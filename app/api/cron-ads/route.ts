import Anthropic from '@anthropic-ai/sdk'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'

// The 8am ads brief. Three reads, one write:
//   ① Meta Marketing API — yesterday vs the trailing 7-day average, per campaign.
//   ② Adyntel — what competitors are running in the niche right now.
//   ③ Claude — turns both into what changed + 3 things to do about it.
// Then one Telegram message to the owner.
//
// AUTH FAILS CLOSED, exactly like cron-daily: this endpoint spends Anthropic +
// Adyntel credit, so with no CRON_SECRET set it returns 401 to everyone.
//
// Every external call is wrapped: if Meta is down you still get the competitor
// half, if Adyntel is down you still get your numbers. A half report beats silence.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const GRAPH = 'https://graph.facebook.com/v23.0'

// Keywords we watch in the market. Edit freely — this is the one knob that
// decides what "the competition" means for your report.
const WATCH_KEYWORDS = ['NLP practitioner', 'transformational coaching', 'mindset webinar']
const WATCH_COUNTRY = 'MY'

// Same recipient rule as the morning brief: the team list, else the owner.
function recipients(): string[] {
  const team = (process.env.TELEGRAM_TEAM_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s))
  const list = team.length
    ? team
    : ([process.env.OWNER_CHAT_ID?.trim()].filter(Boolean) as string[])
  return Array.from(new Set(list))
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const money = (n: number) => 'RM' + n.toLocaleString('en-MY', { maximumFractionDigits: 2 })

// ---------------------------------------------------------------- Meta
type Camp = { name: string; spend: number; impressions: number; leads: number; cpl: number }

// Meta reports conversions in an `actions` array; a lead can arrive under either
// of these action types depending on how the form is wired, so we take the max.
function leadsOf(actions: { action_type: string; value: string }[] | undefined): number {
  if (!Array.isArray(actions)) return 0
  const hits = actions
    .filter((a) => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped')
    .map((a) => Number(a.value) || 0)
  return hits.length ? Math.max(...hits) : 0
}

async function metaCampaigns(datePreset: string): Promise<Camp[]> {
  const token = process.env.META_ACCESS_TOKEN?.trim()
  const acct = process.env.META_AD_ACCOUNT_ID?.trim()
  if (!token || !acct) return []
  const url =
    `${GRAPH}/act_${acct}/insights?level=campaign&date_preset=${datePreset}` +
    `&fields=campaign_name,spend,impressions,actions&limit=200`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Meta ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { data?: Record<string, unknown>[] }
  return (json.data ?? []).map((d) => {
    const spend = Number(d.spend) || 0
    const leads = leadsOf(d.actions as { action_type: string; value: string }[])
    return {
      name: String(d.campaign_name ?? 'Unnamed'),
      spend,
      impressions: Number(d.impressions) || 0,
      leads,
      cpl: leads > 0 ? spend / leads : 0,
    }
  })
}

// ---------------------------------------------------------------- Adyntel
type CompetitorAd = {
  id: string
  page: string
  active: boolean
  daysRunning: number
  copy: string
  cta: string
}

// Adyntel returns `results` as an ARRAY OF ARRAYS (one inner array per collated
// ad group), so it has to be flattened before anything else works.
function flattenAds(json: unknown): Record<string, unknown>[] {
  const results = (json as { results?: unknown[] })?.results
  if (!Array.isArray(results)) return []
  const out: Record<string, unknown>[] = []
  for (const entry of results) {
    if (Array.isArray(entry)) out.push(...(entry as Record<string, unknown>[]))
    else if (entry && typeof entry === 'object') out.push(entry as Record<string, unknown>)
  }
  return out
}

async function adyntelSearch(keyword: string): Promise<CompetitorAd[]> {
  const api_key = process.env.ADYNTEL_API_KEY?.trim()
  const email = process.env.ADYNTEL_EMAIL?.trim()
  if (!api_key || !email) return []
  const res = await fetch('https://api.adyntel.com/facebook_ad_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key, email, keyword, country_code: WATCH_COUNTRY }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Adyntel ${res.status} on "${keyword}"`)
  const json = await res.json()
  return flattenAds(json)
    .map((a) => {
      const snap = (a.snapshot ?? {}) as Record<string, unknown>
      const body = (snap.body ?? {}) as Record<string, unknown>
      return {
        id: String(a.ad_archive_id ?? a.ad_id ?? ''),
        page: String(a.page_name ?? snap.page_name ?? 'Unknown page'),
        active: a.is_active === true,
        // total_active_time is seconds; a long-running ad is a working ad.
        daysRunning: Math.round((Number(a.total_active_time) || 0) / 86400),
        copy: String(body.text ?? snap.title ?? '').slice(0, 220),
        cta: String(snap.cta_text ?? ''),
      }
    })
    .filter((a) => a.id && a.copy)
}

// ------------------------------------------------- seen-ads memory (bot_memory)
// Stored on the owner's bot_memory row under counters.ad_intel_seen so the report
// can say "3 NEW ads" instead of re-listing the same creatives every morning.
const SEEN_KEY = 'ad_intel_seen'
const SEEN_CAP = 400

async function loadSeen(chatId: number): Promise<Set<string>> {
  if (!supabaseConfigured) return new Set()
  const { data } = await supabase.from('bot_memory').select('counters').eq('chat_id', chatId).maybeSingle()
  const list = (data?.counters as Record<string, unknown>)?.[SEEN_KEY]
  return new Set(Array.isArray(list) ? (list as string[]) : [])
}

async function saveSeen(chatId: number, ids: Set<string>) {
  if (!supabaseConfigured) return
  const { data } = await supabase.from('bot_memory').select('counters').eq('chat_id', chatId).maybeSingle()
  const counters = { ...((data?.counters as Record<string, unknown>) ?? {}) }
  counters[SEEN_KEY] = Array.from(ids).slice(-SEEN_CAP)
  const { error } = await supabase
    .from('bot_memory')
    .upsert({ chat_id: chatId, counters }, { onConflict: 'chat_id' })
  if (error) console.error('[CFO] could not save ad-intel memory:', error.message)
}

// ---------------------------------------------------------------- the route
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  const authed = !!secret && req.headers.get('authorization') === `Bearer ${secret}`
  if (!authed) return new Response('forbidden', { status: 401 })

  const to = recipients()
  const notes: string[] = []

  // ① Yesterday vs the trailing 7-day daily average.
  let yesterday: Camp[] = []
  let week: Camp[] = []
  let month: Camp[] = []
  try {
    ;[yesterday, week, month] = await Promise.all([
      metaCampaigns('yesterday'),
      metaCampaigns('last_7d'),
      metaCampaigns('last_30d'),
    ])
  } catch (e) {
    notes.push(`Meta unavailable: ${(e as Error).message}`)
  }

  const weekByName = new Map(week.map((c) => [c.name, c]))
  const movers = yesterday
    .filter((c) => c.spend > 0)
    .map((c) => {
      const w = weekByName.get(c.name)
      const avgCpl = w && w.leads > 0 ? w.spend / w.leads : 0
      const cplDelta = avgCpl > 0 && c.cpl > 0 ? Math.round(((c.cpl - avgCpl) / avgCpl) * 100) : 0
      return { ...c, avgCpl, cplDelta }
    })
    .sort((a, b) => b.spend - a.spend)

  let spentYesterday = movers.reduce((s, c) => s + c.spend, 0)
  let leadsYesterday = movers.reduce((s, c) => s + c.leads, 0)

  // Nothing ran yesterday (paused account, or a gap between campaigns)? Reporting
  // "RM0, 0 leads" every morning is technically true and completely useless, so
  // fall back to the trailing week and SAY that's what you're looking at.
  let window = 'yesterday'
  if (spentYesterday === 0) {
    const fallback: [string, Camp[]][] = [
      ['last 7 days (nothing ran yesterday)', week],
      ['last 30 days (nothing ran this week)', month],
    ]
    for (const [label, rows] of fallback) {
      if (!rows.some((c) => c.spend > 0)) continue
      window = label
      movers.length = 0
      movers.push(
        ...rows
          .filter((c) => c.spend > 0)
          .map((c) => ({ ...c, avgCpl: c.cpl, cplDelta: 0 }))
          .sort((a, b) => b.spend - a.spend),
      )
      spentYesterday = movers.reduce((s, c) => s + c.spend, 0)
      leadsYesterday = movers.reduce((s, c) => s + c.leads, 0)
      break
    }
    if (window === 'yesterday') notes.push('No Meta spend in the last 30 days — every campaign is paused.')
  }

  // ② The market.
  const chatId = Number(process.env.OWNER_CHAT_ID?.trim() || 0)
  const seen = await loadSeen(chatId)
  let competitors: CompetitorAd[] = []
  try {
    const batches = await Promise.all(WATCH_KEYWORDS.map((k) => adyntelSearch(k)))
    const byId = new Map<string, CompetitorAd>()
    for (const ad of batches.flat()) if (!byId.has(ad.id)) byId.set(ad.id, ad)
    competitors = Array.from(byId.values())
  } catch (e) {
    notes.push(`Adyntel unavailable: ${(e as Error).message}`)
  }

  const fresh = competitors.filter((a) => !seen.has(a.id))
  // What's *working* for others: still running, and running a long time.
  const proven = competitors
    .filter((a) => a.active && a.daysRunning >= 14)
    .sort((a, b) => b.daysRunning - a.daysRunning)
    .slice(0, 8)

  // ③ Turn it into advice.
  const facts = [
    `WINDOW = ${window.toUpperCase()}: spent ${money(spentYesterday)}, ${leadsYesterday} leads across ${movers.length} campaigns.`,
    ...movers.slice(0, 8).map(
      (c) =>
        `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}` +
        (c.cplDelta ? ` (${c.cplDelta > 0 ? '+' : ''}${c.cplDelta}% vs 7-day avg ${money(c.avgCpl)})` : ''),
    ),
    '',
    `COMPETITOR ADS IN ${WATCH_COUNTRY} (${competitors.length} seen, ${fresh.length} new since yesterday):`,
    ...fresh.slice(0, 10).map((a) => `- NEW · ${a.page} · CTA "${a.cta}" · ${a.copy}`),
    ...proven.map((a) => `- PROVEN (${a.daysRunning}d running) · ${a.page} · ${a.copy}`),
  ].join('\n')

  let report = ''
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (key) {
    try {
      const anthropic = new Anthropic({ apiKey: key })
      const res = await anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1200,
        system:
          'You write a 7am ads briefing for a busy Malaysian coaching business owner. ' +
          'Be concrete and short. No preamble, no markdown headers, no bullet symbols other than "-". ' +
          'Structure: one line on what changed in the numbers; two or three lines on what competitors are doing ' +
          'that is worth copying; then exactly 3 numbered actions, each one sentence and specific enough to do today. ' +
          'If a competitor ad has run 30+ days, say so - longevity means it converts. ' +
          'Never invent numbers that are not in the data. If data is missing, say which part is missing.',
        messages: [{ role: 'user', content: facts }],
      })
      report = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
    } catch (e) {
      notes.push(`Claude unavailable: ${(e as Error).message}`)
    }
  }

  const header =
    `📊 <b>Ads brief</b> — ${window}: ${money(spentYesterday)} spent · ${leadsYesterday} leads` +
    (movers.length ? ` · ${movers.length} live campaigns` : '')
  const text = [
    header,
    '',
    report ? esc(report) : esc(facts),
    notes.length ? '\n⚠️ ' + notes.map(esc).join('\n⚠️ ') : '',
  ]
    .filter(Boolean)
    .join('\n')

  for (const chat of to) await sendMessage(chat, text)

  // Remember what we showed, so tomorrow's "new" is genuinely new.
  if (competitors.length) {
    for (const a of competitors) seen.add(a.id)
    await saveSeen(chatId, seen)
  }

  return Response.json({
    ok: true,
    sent: to.length,
    campaigns: movers.length,
    window,
    spend: spentYesterday,
    leads: leadsYesterday,
    competitor_ads: competitors.length,
    new_competitor_ads: fresh.length,
    notes,
  })
}
