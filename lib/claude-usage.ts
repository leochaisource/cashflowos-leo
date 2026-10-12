import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// THE CLAUDE API METER. Every Claude call CashFlowOS (Jarvis / the Oyen bot)
// makes is priced and totalled per Kuala Lumpur day. The first time a day's total
// passes CLAUDE_DAILY_ALERT_USD (default $1; owner, 2026-10-12), the owner gets
// one Telegram alert listing what spent it.
//
// Every client comes from claudeClient(feature). Its fetch reads `usage` off each
// /v1/messages response and files one tiny object per call in the private
// `cfo-cache` bucket, with the cost in the object's NAME:
//   usage/2026-10-12/1760259000000_k3f9_closer-coach_claude-opus-5-5_214500.json
// (214500 = $0.2145 in millionths of a dollar). One object per call means calls
// running in parallel can't overwrite each other's numbers, and a day's total
// is a single folder listing — no table to create. Token counting is free and
// skipped; failed calls (429/529/5xx) aren't billed and aren't counted.
//
// Scripts run from the laptop use it too (feature "script-…"), so the total is
// everything that spends the API key from this project.

// USD per million tokens [model prefix, input, output] — platform.claude.com
// pricing as of 2026-10-12. Cache reads cost 0.1× input, 5-minute cache writes
// 1.25×, 1-hour writes 2×; web search $10 per 1,000. A model not listed is
// priced at the dearest rate here, so the meter errs high, never low.
const PRICES: [string, number, number][] = [
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
]
const DEAREST = PRICES.reduce((a, b) => (b[2] > a[2] ? b : a))

const BUCKET = 'cfo-cache'
const TZ = 'Asia/Kuala_Lumpur'
const FEATURE_LABEL: Record<string, string> = {
  'intent-judge-8am': 'Buying-intent judging, 8am brief',
  'intent-judge-refresh': 'Buying-intent judging, hot leads refresh',
  'closer-coach': "Ariella's closing coach",
  'brief-analysis': '8am competitor analysis',
  'competitor-usp': 'Competitor write-ups',
  'linkedin-ideas': 'LinkedIn ideas',
  'jarvis-chat': 'Jarvis chat on Telegram',
  'receipt-reader': 'Receipt reader',
}

type Usage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

export type DaySpend = { day: string; total: number; calls: number; byFeature: { feature: string; cost: number; calls: number }[] }

/** What one response cost, in USD. */
export function costOf(model: string, u: Usage): number {
  const [, inRate, outRate] = PRICES.filter(([m]) => model.startsWith(m)).sort((a, b) => b[0].length - a[0].length)[0] ?? DEAREST
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h)
  const perMillion =
    (u.input_tokens ?? 0) * inRate +
    write5m * inRate * 1.25 +
    write1h * inRate * 2 +
    (u.cache_read_input_tokens ?? 0) * inRate * 0.1 +
    (u.output_tokens ?? 0) * outRate
  return perMillion / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * 0.01
}

/** An Anthropic client whose every Messages call is metered under `feature`. */
export function claudeClient(feature: string, opts: ClientOptions = {}): Anthropic {
  const base = opts.fetch ?? globalThis.fetch
  const metered = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await base(input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (res.ok && /\/v1\/messages(\?|$)/.test(url) && (res.headers.get('content-type') ?? '').includes('application/json')) {
        const body = (await res.clone().json()) as { model?: string; usage?: Usage }
        if (body.model && body.usage) {
          // Bounded, so a slow bucket can never hold up the call it measures.
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            record(feature, body.model, body.usage),
            new Promise<void>((r) => (timer = setTimeout(r, 8000))),
          ]).finally(() => clearTimeout(timer))
        }
      }
    } catch (e) {
      console.warn('[CFO] claude meter skipped a call:', e instanceof Error ? e.message : e)
    }
    return res
  }
  return new Anthropic({ ...opts, fetch: metered as ClientOptions['fetch'] })
}

/** Today's (or `day`'s) metered spend, KL time. Null when storage isn't configured. */
export async function spendOn(day = klDay()): Promise<DaySpend | null> {
  const s = store()
  if (!s) return null
  const by = new Map<string, { cost: number; calls: number }>()
  let total = 0
  let calls = 0
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await s.storage.from(BUCKET).list(`${prefix()}/${day}`, { limit: 1000, offset })
    if (error) throw new Error(error.message)
    for (const o of data ?? []) {
      const m = /^\d+_[a-z0-9]+_([a-z0-9-]+)_[a-z0-9-]+_(\d+)\.json$/.exec(o.name)
      if (!m) continue
      const cost = Number(m[2]) / 1e6
      const f = by.get(m[1]) ?? { cost: 0, calls: 0 }
      f.cost += cost
      f.calls += 1
      by.set(m[1], f)
      total += cost
      calls += 1
    }
    if ((data?.length ?? 0) < 1000) break
  }
  const byFeature = [...by].map(([feature, v]) => ({ feature, ...v })).sort((a, b) => b.cost - a.cost)
  return { day, total, calls, byFeature }
}

async function record(feature: string, model: string, usage: Usage): Promise<void> {
  const s = store()
  if (!s) return
  const cost = costOf(model, usage)
  const day = klDay()
  const dir = `${prefix()}/${day}`
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${slug(feature)}_${slug(model)}_${Math.round(cost * 1e6)}.json`
  const body = JSON.stringify({ at: new Date().toISOString(), feature, model, usage, cost })
  const put = () => s.storage.from(BUCKET).upload(`${dir}/${name}`, body, { contentType: 'application/json' })
  let up = await put()
  if (up.error && /not found/i.test(up.error.message)) {
    await s.storage.createBucket(BUCKET, { public: false })
    up = await put()
  }
  if (up.error) throw new Error(up.error.message)
  console.log(`[CFO] claude ${feature} ${model} $${cost.toFixed(4)}`)

  const limit = Number(process.env.CLAUDE_DAILY_ALERT_USD ?? 1)
  if (!Number.isFinite(limit)) return
  const spend = await spendOn(day)
  if (!spend || spend.total <= limit) return
  // One alert a day: this marker can only be created once, so of two calls that
  // cross the line together, only one sends. A failed send removes it to retry.
  const mark = await s.storage.from(BUCKET).upload(`${dir}/alert`, '{}', { contentType: 'application/json', upsert: false })
  if (mark.error) return
  if (!(await tellOwner(alertText(spend, limit)))) await s.storage.from(BUCKET).remove([`${dir}/alert`])
}

function alertText(s: DaySpend, limit: number): string {
  const test = prefix() === 'usage' ? '' : '(TEST) '
  const day = new Date(`${s.day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const lines = s.byFeature.map((f) => {
    const label = FEATURE_LABEL[f.feature] ?? (f.feature.startsWith('script-') ? `Script on the laptop: ${f.feature.slice(7)}` : f.feature)
    return `• ${label} — $${f.cost.toFixed(2)} · ${f.calls} call${f.calls === 1 ? '' : 's'}`
  })
  return (
    `${test}⚠️ <b>Claude API: $${s.total.toFixed(2)} spent today</b> — over your $${limit}/day line.\n` +
    `${day} (KL), ${s.calls} calls so far:\n${lines.join('\n')}\n\n` +
    `Counts every Claude call CashFlowOS makes, scripts included. One alert a day.`
  )
}

async function tellOwner(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chat = process.env.OWNER_CHAT_ID?.trim()
  if (!token || !chat) return false
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  }).catch(() => null)
  return Boolean(res?.ok)
}

let db: SupabaseClient | null | undefined
function store(): SupabaseClient | null {
  if (db !== undefined) return db
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null
  if (!db) console.warn('[CFO] claude meter off: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  return db
}

const prefix = () => process.env.CLAUDE_USAGE_PREFIX?.trim() || 'usage'
const klDay = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ })
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
