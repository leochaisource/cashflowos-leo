import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/watchdog.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { journeyFor } from './funnel-config.ts'
import { readBeats, type Beat } from './heartbeat.ts'
import { AUTOPILOT, isoWeek } from '../agents/linkedin/definition.ts'

// 🩺 THE WATCHDOG (owner, 2026-11-10). Every morning at 9am it checks that the
// automations which run without anyone watching actually ran and produced
// believable numbers. It fixes what is safe to repeat and tells the owner the rest.
//
// What the owner decided:
//   • It may RETRY only jobs that are safe to run twice: re-sync Meta spend, and
//     re-send a brief that failed to reach HIM. It never edits settings, code or
//     env vars, and never re-sends anything to a client's group.
//   • It reports inside the 9am message, and only when something is wrong. On
//     Mondays a one-line "still alive" summary goes out even when all is well,
//     so silence never means it died. Its own watchdog is the 8am job
//     (deadManCheck below): if this morning's check never finished, 8am says so.
//
// Every check works from evidence the jobs already leave (brief_daily,
// cron_claims, ad_daily, funnel_daily, linkedin_autopilot, cfo-cache markers),
// plus heartbeats for the jobs driven by the sheet's Apps Script (lib/heartbeat.ts).
// A check that throws becomes one plain line; it never takes the others down.
//
// Shared with scripts/watchdog.ts (a dry run): no server-only imports, and the
// Supabase client comes in as a parameter.

const BUCKET = 'cfo-cache'
const TZ = 'Asia/Kuala_Lumpur'
const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Problem = { check: string; text: string; fix?: string }
export type Fixed = { check: string; text: string }
export type CheckResult = { name: string; status: 'ok' | 'problem' | 'fixed' | 'skipped' | 'error'; detail?: string }
export type WatchdogReport = {
  day: string // the Malaysian date of the run
  at: string
  checks: CheckResult[]
  problems: Problem[]
  fixed: Fixed[]
  /** Dry runs only: the retries a real run would have tried. */
  wouldRetry: string[]
}

export type WatchdogDeps = {
  db: SupabaseClient
  /** The 8am brief's focus list, in rank order (focusProjects()). */
  focus: AdClient[]
  now?: Date
  /** Epoch ms after which no new retry starts (the 9am job shares a 300s limit). */
  deadline?: number
  /** Leave out for a dry run: nothing is retried, the report says what would be. */
  retry?: {
    resync: (client: AdClient) => Promise<unknown>
    send: (chat: string, text: string) => Promise<{ ok: boolean; error?: string }>
  }
}

// ---------------------------------------------------------------- small helpers
const klDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ })
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const klStart = (day: string) => new Date(`${day}T00:00:00+08:00`)
const klHour = (d: Date) => Number(d.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24
const klWeekday = (d: Date) => new Date(`${klDay(d)}T12:00:00Z`).getUTCDay() // 0 = Sunday
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const money = (cur: string, v: number) => `${cur}${Math.round(v).toLocaleString('en-MY')}`
const norm = (s: string) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Shorten by code points, so "fancy" two-unit letters are never cut in half (see lib/format.ts clip()). */
const clip = (s: string, n: number) => {
  const cps = Array.from(String(s ?? ''))
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : cps.join('')
}
const nameOf = (c: AdClient) => c.client ?? c.name

/** Every row of a query, 1,000 at a time (Supabase caps a read at 1,000 rows, silently). */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

type Ctx = WatchdogDeps & {
  now: Date
  today: string
  yesterday: string
  report: WatchdogReport
  timeLeft: () => boolean
}
type Check = (ctx: Ctx) => Promise<{ skipped?: string; detail?: string } | void>

// ---------------------------------------------------------------- ① the 8am briefs
type BriefRow = {
  project: string
  date: string
  sent_at: string
  delivered: string[] | null
  failed: { chat: string; error: string }[] | null
  performance_text: string | null
  report_text: string | null
}

/** A chat id in words, never the raw id. */
function chatLabel(chat: string, client: AdClient): string {
  const [id, ...rest] = String(chat).split(' ')
  const suffix = rest.join(' ').replace(/[()]/g, '').trim()
  const owner = process.env.OWNER_CHAT_ID?.trim()
  const team = (process.env.TELEGRAM_TEAM_CHAT_IDS || '').split(',').map((s) => s.trim())
  const groups = (client.briefChatIdEnvs ?? []).map((e) => process.env[e]?.trim()).filter(Boolean)
  const who =
    id === owner ? 'your private chat' : groups.includes(id) ? 'the client group' : team.includes(id) ? 'the team chat' : id.startsWith('-') ? 'a group chat' : 'a private chat'
  return suffix ? `${who} (${suffix})` : who
}

/** Split on lines to stay under Telegram's 4,096-character limit (it rejects, not truncates). */
function chunks(text: string, max = 3800): string[] {
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const piece = Array.from(line).length > max ? clip(line, max) : line
    if (Array.from(cur).length + Array.from(piece).length + 1 > max && cur) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${piece}` : piece
  }
  if (cur) out.push(cur)
  return out
}

const checkBriefs: Check = async (ctx) => {
  const { db, focus, today, now, report } = ctx
  if (!focus.length) return { skipped: 'no focus clients' }
  if (klHour(now) < 9) return { skipped: 'before 9am: the 8am briefs may still be running' }

  const { data: claim } = await db.from('cron_claims').select('claimed_at').eq('key', `cron-ads:${today}`).maybeSingle()
  const { data, error } = await db
    .from('brief_daily')
    .select('project,date,sent_at,delivered,failed,performance_text,report_text')
    .in('project', focus.map((c) => c.id))
    .gte('sent_at', klStart(today).toISOString())
    .lt('sent_at', klStart(addDays(today, 1)).toISOString())
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as BriefRow[]
  const claimedAt = (claim as { claimed_at?: string } | null)?.claimed_at

  if (!rows.length && !claimedAt) {
    report.problems.push({
      check: 'briefs',
      text: "The 8am briefs didn't run today: no client got one, and Vercel never started the 8am job.",
      fix: 'Check Vercel → cashflowos-leo → Logs for /api/cron-ads, or ask Claude to run the 8am job by hand.',
    })
    return
  }
  // Still running (a long Claude Malaysia run, or a late cron delivery)? Don't call it missing yet.
  if (claimedAt && now.getTime() - Date.parse(claimedAt) < 8 * 60_000 && rows.length < focus.length)
    return { skipped: 'the 8am job started under 8 minutes ago and is still running' }

  const owner = process.env.OWNER_CHAT_ID?.trim()
  for (const client of focus) {
    const row = rows.find((r) => r.project === client.id)
    if (!row) {
      report.problems.push({
        check: 'briefs',
        text: `${nameOf(client)}: the 8am brief didn't go out today. The run stopped for this client, so neither you nor its group got the numbers.`,
        fix: `Ask Claude to read the Vercel logs for /api/cron-ads and decide whether to re-run it (?client=${client.id} also sends to the client group).`,
      })
      continue
    }
    if (!row.report_text)
      report.problems.push({
        check: 'briefs',
        text: `${nameOf(client)}: the brief went out without its written analysis, so the Claude step failed.`,
        fix: 'Usually API credit: check platform.claude.com → Settings → Billing (claude.ai credit does not pay for the API).',
      })

    for (const f of row.failed ?? []) {
      const id = String(f.chat).split(' ')[0]
      const label = chatLabel(f.chat, client)
      const isMainOwnerCopy = id === owner && String(f.chat).trim() === owner
      if (isMainOwnerCopy) {
        const text = [row.performance_text, row.report_text].filter(Boolean).join('\n\n')
        if (!text) {
          report.problems.push({ check: 'briefs', text: `${nameOf(client)}: your copy of the brief didn't arrive (${clip(f.error, 120)}), and there is no stored text to re-send.` })
          continue
        }
        if (!ctx.retry) {
          report.wouldRetry.push(`re-send ${nameOf(client)}'s brief to you`)
          report.problems.push({ check: 'briefs', text: `${nameOf(client)}: your copy of the 8am brief didn't arrive (${clip(f.error, 120)}).` })
          continue
        }
        const header = `🔁 <b>Re-sent by the watchdog</b>: your 8am copy of ${esc(nameOf(client))} didn't arrive.\n\n`
        let ok = true
        let err = ''
        for (const part of chunks(header + text)) {
          const r = await ctx.retry.send(owner!, part)
          if (!r.ok) {
            ok = false
            err = r.error ?? 'unknown'
            break
          }
        }
        if (ok) report.fixed.push({ check: 'briefs', text: `${nameOf(client)}: your copy of the 8am brief failed (${clip(f.error, 80)}). Re-sent it above ✅` })
        else report.problems.push({ check: 'briefs', text: `${nameOf(client)}: your copy of the 8am brief didn't arrive, and re-sending failed too (${clip(err, 120)}).` })
        continue
      }
      // Never re-sent: a client's group, the team chat, or one of the owner's side messages.
      const removed = /chat not found|kicked|not a member|blocked|deactivated|forbidden/i.test(f.error)
      report.problems.push({
        check: 'briefs',
        text: `${nameOf(client)}: the brief didn't reach ${label} (${clip(f.error, 120)}).`,
        fix: removed
          ? 'The bot was removed from that chat, or its id changed: add the bot back, then tell Claude.'
          : 'Telegram refused it this morning. Tell Claude if that chat should get today’s numbers re-sent.',
      })
    }
  }
}

// ---------------------------------------------------------------- ② Meta spend is fresh
type SyncRow = { project: string; date: string; synced_at: string }

const checkMeta: Check = async (ctx) => {
  const { db, focus, today, report } = ctx
  // Judged from the stored rows, not from this machine's env: a client never
  // connected has no rows and is skipped below ("no ads ran").
  const clients = focus
  const notes: string[] = []
  for (const client of clients) {
    const latest = async () => {
      const { data, error } = await db.from('ad_daily').select('project,date,synced_at').eq('project', client.id).order('synced_at', { ascending: false }).limit(1)
      if (error) throw new Error(error.message)
      return (data?.[0] as SyncRow | undefined) ?? null
    }
    const { data: newest, error } = await db.from('ad_daily').select('date').eq('project', client.id).order('date', { ascending: false }).limit(1)
    if (error) throw new Error(error.message)
    const lastDelivery = (newest?.[0] as { date?: string } | undefined)?.date ?? null
    // The 8am sync re-reads the last 7 days. An account with no delivery in that
    // window writes no rows, so an old synced_at there is normal, not a fault.
    if (!lastDelivery || lastDelivery < addDays(today, -6)) {
      notes.push(`${client.id}: no ads ran in the last week`)
      continue
    }
    const before = await latest()
    if (before && before.synced_at >= klStart(today).toISOString()) continue

    const since = before ? whenLabel(before.synced_at) : 'never'
    if (!ctx.retry) {
      report.wouldRetry.push(`re-sync ${nameOf(client)} from Meta`)
      report.problems.push({ check: 'meta', text: `${nameOf(client)}: Meta spend hasn't synced since ${since}, so this morning's brief used old numbers.` })
      continue
    }
    if (!ctx.timeLeft()) {
      report.problems.push({ check: 'meta', text: `${nameOf(client)}: Meta spend hasn't synced since ${since}. No time was left this morning to retry.` })
      continue
    }
    let err = ''
    try {
      await ctx.retry.resync(client)
    } catch (e) {
      err = (e as Error).message
    }
    const after = err ? null : await latest()
    if (after && after.synced_at >= klStart(today).toISOString()) {
      report.fixed.push({ check: 'meta', text: `${nameOf(client)}: Meta spend hadn't synced since ${since}, so the 8am brief used old numbers. Re-synced it now ✅` })
      continue
    }
    const tokenish = /token|oauth|session|expired|permission|#190|code 190/i.test(err)
    report.problems.push({
      check: 'meta',
      text: `${nameOf(client)}: Meta spend hasn't synced since ${since}, and a retry failed${err ? ` (${clip(err, 140)})` : ''}.`,
      fix: tokenish
        ? `The Meta access token has probably expired: make a new one for the system user and paste it into Vercel as ${client.tokenEnv}.`
        : 'Ask Claude to check the Meta connection for this client.',
    })
  }
  return notes.length ? { detail: notes.join('; ') } : undefined
}

// ---------------------------------------------------------------- ③ spend outside every funnel, ④ leads that disagree
type AdRow = { project: string; date: string; campaign_name: string | null; spend: number | string | null; leads: number | string | null }
type FunnelRow = { project: string; funnel: string; spend: number | string | null; leads: number | null }

const checkFunnels: Check = async (ctx) => {
  const { db, focus, today, yesterday, report } = ctx
  const clients = focus.filter((c) => c.ghl?.funnels?.length)
  if (!clients.length) return { skipped: 'no focus client has GHL funnels' }
  const ids = clients.map((c) => c.id)
  const from30 = addDays(today, -30)
  const from7 = addDays(today, -7)
  const ads = await allRows<AdRow>((a, b) =>
    db.from('ad_daily').select('project,date,campaign_name,spend,leads').in('project', ids).gte('date', from30).lte('date', yesterday).order('date').range(a, b),
  )
  const { data: fData, error } = await db.from('funnel_daily').select('project,funnel,spend,leads').in('project', ids).eq('date', yesterday)
  if (error) throw new Error(error.message)
  const funnelRows = (fData ?? []) as FunnelRow[]

  for (const client of clients) {
    const cur = client.currency || 'RM'
    const funnelOf = new Map<string, string>()
    for (const f of client.ghl!.funnels) for (const c of [f.campaign].flat()) funnelOf.set(norm(c), f.label)
    const rows = ads.filter((r) => r.project === client.id)

    // ③ Campaigns no funnel lists. The brief already notes "spend not matched" each
    // morning; the watchdog escalates it with the campaign names, the money and
    // how long it has gone on, because every day it stays the cost per lead is wrong.
    const outside = new Map<string, { spend7: number; days: Set<string>; first: string }>()
    let total7 = 0
    for (const r of rows) {
      const spend = Number(r.spend) || 0
      if (r.date >= from7) total7 += spend
      if (spend <= 0 || funnelOf.has(norm(r.campaign_name ?? ''))) continue
      const k = r.campaign_name ?? '(no campaign name)'
      const o = outside.get(k) ?? { spend7: 0, days: new Set<string>(), first: r.date }
      if (r.date < o.first) o.first = r.date
      if (r.date >= from7) {
        o.spend7 += spend
        o.days.add(r.date)
      }
      outside.set(k, o)
    }
    const flagged = [...outside.entries()].filter(([, o]) => o.spend7 >= 50 && o.days.size >= 2).sort((a, b) => b[1].spend7 - a[1].spend7)
    if (flagged.length) {
      const sum = flagged.reduce((s, [, o]) => s + o.spend7, 0)
      const share = total7 > 0 ? Math.round((sum / total7) * 100) : null
      const lines = flagged.slice(0, 4).map(([name, o]) => `• ${clip(name, 60)}: ${money(cur, o.spend7)}, ${o.first <= from30 ? 'for over a month' : `since ${dayLabel(o.first)}`}`)
      const labels = client.ghl!.funnels.map((f) => `"${f.label}"`).join(' or ')
      report.problems.push({
        check: 'funnels',
        text:
          `${nameOf(client)}: ${plural(flagged.length, 'campaign')} outside every funnel spent ${money(cur, sum)} in the last 7 days` +
          `${share !== null ? ` (${share}% of spend)` : ''}, so the brief's cost per lead leaves ${flagged.length === 1 ? 'it' : 'them'} out:\n` +
          lines.join('\n') +
          (flagged.length > 4 ? `\n…and ${flagged.length - 4} more` : ''),
        fix: `If they feed ${labels}, ask Claude to add them to that funnel in lib/ad-clients.ts. If they're a separate funnel, tell Claude which form they use.`,
      })
    }

    // ④ Yesterday's leads per funnel: Meta's count vs GHL's form submissions. Small
    // gaps are normal (attribution); one side at zero while the other is not means
    // a wrong form id or a changed conversion event. That second case hid
    // Starcity's leads for 10 days in October.
    for (const f of client.ghl!.funnels) {
      const ghlRow = funnelRows.find((r) => r.project === client.id && r.funnel === f.label)
      if (!ghlRow) continue // no brief yesterday: check ① reports that
      const mine = rows.filter((r) => r.date === yesterday && funnelOf.get(norm(r.campaign_name ?? '')) === f.label)
      const spend = mine.reduce((s, r) => s + (Number(r.spend) || 0), 0)
      const meta = Math.round(mine.reduce((s, r) => s + (Number(r.leads) || 0), 0))
      const ghl = Number(ghlRow.leads) || 0
      if (spend < 30) continue
      if (meta >= 3 && ghl === 0)
        report.problems.push({
          check: 'funnels',
          text: `${nameOf(client)}, ${f.label}: Meta reported ${meta} leads yesterday, but GHL counted no opt-ins on the form "${clip(f.formName, 50)}".`,
          fix: 'The form id in lib/ad-clients.ts may be wrong, or the landing page now uses a different form. Ask Claude to check.',
        })
      else if (ghl >= 3 && meta === 0)
        report.problems.push({
          check: 'funnels',
          text: `${nameOf(client)}, ${f.label}: GHL counted ${ghl} opt-ins yesterday, but Meta reported no leads on ${money(cur, spend)} of spend.`,
          fix: 'The campaign probably fires a different conversion event from the one the brief counts (leadActionTypes in lib/ad-clients.ts). Ask Claude to compare the events.',
        })
    }
  }
}

// ---------------------------------------------------------------- ⑤ the sheet's Apps Script clocks
const TRIGGER_FIX =
  'Open the Hot leads sheet → Extensions → Apps Script → Triggers (the clock icon). If the triggers are gone, run installSyncTriggers once. If they show errors, Executions says why (often the script needs authorising again).'

const checkTriggers: Check = async (ctx) => {
  const { db, focus, now, yesterday, report } = ctx
  const notes: string[] = []
  const hotList = focus.find((c) => c.ghl?.hotList)
  if (hotList) {
    const jobs: { job: string; label: string; maxGapH: number }[] = [
      { job: 'hotlist-tick', label: "Ariella's hourly list check", maxGapH: 3 },
      // Runs at 9am, 12, 3, 6 and 9pm: the longest normal gap is 9pm → 9am.
      { job: 'hotleads-sync', label: 'The Hot leads sheet refresh', maxGapH: 13.5 },
    ]
    for (const j of jobs) {
      const beats: Beat[] | null = await readBeats(db, j.job)
      if (!beats?.length) {
        notes.push(`${j.job}: not tracked yet`)
        continue
      }
      const last = beats[beats.length - 1]
      const gapH = (now.getTime() - Date.parse(last.at)) / HOUR
      if (gapH > j.maxGapH)
        report.problems.push({
          check: 'triggers',
          text: `${j.label} hasn't run since ${whenLabel(last.at)} (${Math.round(gapH)}h ago). The sheet's clock has probably stopped.`,
          fix: TRIGGER_FIX,
        })
    }
  }
  // The Funnel X-ray rebuilds yesterday from 6am, on the same hourly trigger, and
  // retries every hour until it succeeds. Still behind at 9am = three misses.
  for (const client of focus.filter((c) => journeyFor(c.id) && c.ghl && c.deal)) {
    const { data } = await db.storage.from(BUCKET).download(`funnel/${client.id}-refreshed.json`)
    const day = data ? ((JSON.parse(await data.text()) as { day?: string }).day ?? null) : null
    if (!day) {
      notes.push(`${client.id}: no Funnel X-ray marker yet`)
      continue
    }
    if (day < yesterday)
      report.problems.push({
        check: 'triggers',
        text: `${nameOf(client)}: the Funnel X-ray hasn't rebuilt yesterday's numbers (last rebuilt: ${dayLabel(day)}).`,
        fix: 'It retries every hour. If this is still here tomorrow, ask Claude to look at /api/lead-journey.',
      })
  }
  return notes.length ? { detail: notes.join('; ') } : undefined
}

// ---------------------------------------------------------------- ⑥ Jarvis can hear you
const checkBot: Check = async (ctx) => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return { skipped: 'TELEGRAM_BOT_TOKEN not set here' }
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string } }
  if (!body.ok || !body.result) throw new Error(`Telegram answered ${res.status}`)
  const r = body.result
  if (!r.url) {
    ctx.report.problems.push({
      check: 'bot',
      text: "Jarvis (your Telegram bot) has no webhook set, so it can't receive your messages.",
      fix: 'Ask Claude to run npm run webhook:set in cashflowos-leo.',
    })
    return
  }
  const pending = r.pending_update_count ?? 0
  const recentError = !!r.last_error_date && ctx.now.getTime() - r.last_error_date * 1000 < DAY
  if (pending >= 3 && recentError)
    ctx.report.problems.push({
      check: 'bot',
      text: `Jarvis has ${pending} messages waiting that Telegram couldn't hand over (${clip(r.last_error_message ?? 'no reason given', 100)}).`,
      fix: 'Usually a failed deploy or a changed secret. Ask Claude to run npm run webhook:info and check the latest deploy.',
    })
}

// ---------------------------------------------------------------- ⑦ the LinkedIn autopilot took its step
// One heavy step per morning, after this check in the same 9am run: Saturday
// researches, Sunday writes, Monday schedules (agents/linkedin/autopilot.ts). So
// on Sunday the watchdog looks for Saturday's research, on Monday for Sunday's
// posts, and on Tuesday for Monday's scheduling. Single empty slots are not
// checked here: the autopilot sends its own card for those.
const checkLinkedIn: Check = async (ctx) => {
  if (!AUTOPILOT) return { skipped: 'the LinkedIn autopilot is switched off' }
  const wd = klWeekday(ctx.now)
  if (![0, 1, 2].includes(wd)) return { skipped: 'nothing to check today' }
  const tue = addDays(ctx.today, (2 - wd + 7) % 7) // Sun/Mon → the coming Tuesday; Tue → today
  const week = isoWeek(new Date(`${tue}T09:00:00+08:00`))
  const { data, error } = await ctx.db.from('linkedin_autopilot').select('kind,status').eq('week', week)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as { kind: string; status: string }[]
  const posts = rows.filter((r) => r.kind === 'post')
  const push = (text: string, fix: string) => ctx.report.problems.push({ check: 'linkedin', text: `LinkedIn autopilot (${week}): ${text}`, fix })
  if (wd === 0 && !rows.some((r) => r.kind === 'research' && r.status === 'ready'))
    push("Saturday's research step didn't finish.", 'It tries again in this morning\'s run. If this is still here tomorrow, the Tue–Thu posts are at risk: ask Claude to look at the autopilot.')
  if (wd === 1 && !posts.length)
    push("Sunday's writing step produced no posts.", 'It tries again this morning. If it still has none tomorrow, ask Claude to look before Tuesday 9am.')
  if (wd === 2 && !posts.some((r) => r.status === 'scheduled'))
    push("Monday's step scheduled nothing for Tue–Thu, so today's 9am post didn't go out.", 'Ask Claude to check the autopilot and GHL (npm run linkedin -- list).')
}

// ---------------------------------------------------------------- the run
const CHECKS: [string, Check][] = [
  ['briefs', checkBriefs],
  ['meta', checkMeta],
  ['funnels', checkFunnels],
  ['triggers', checkTriggers],
  ['bot', checkBot],
  ['linkedin', checkLinkedIn],
]
const LABEL: Record<string, string> = {
  briefs: '8am briefs',
  meta: 'Meta sync',
  funnels: 'funnel spend and leads',
  triggers: 'sheet triggers',
  bot: 'Telegram bot',
  linkedin: 'LinkedIn autopilot',
}

export async function runWatchdog(deps: WatchdogDeps): Promise<WatchdogReport> {
  const now = deps.now ?? new Date()
  const today = klDay(now)
  const report: WatchdogReport = { day: today, at: now.toISOString(), checks: [], problems: [], fixed: [], wouldRetry: [] }
  const ctx: Ctx = {
    ...deps,
    now,
    today,
    yesterday: addDays(today, -1),
    report,
    timeLeft: () => !deps.deadline || Date.now() < deps.deadline,
  }
  for (const [name, check] of CHECKS) {
    const p0 = report.problems.length
    const f0 = report.fixed.length
    try {
      const r = (await check(ctx)) || {}
      const status = r.skipped ? 'skipped' : report.problems.length > p0 ? 'problem' : report.fixed.length > f0 ? 'fixed' : 'ok'
      report.checks.push({ name, status, ...(r.skipped || r.detail ? { detail: r.skipped ?? r.detail } : {}) })
    } catch (e) {
      const msg = (e as Error).message || String(e)
      report.checks.push({ name, status: 'error', detail: msg })
      report.problems.push({ check: name, text: `The watchdog couldn't run its ${LABEL[name] ?? name} check (${clip(msg, 140)}).` })
    }
  }
  return report
}

/** What the 9am message carries when the whole watchdog crashed before it could report. */
export function watchdogCrashed(e: unknown, now = new Date()): WatchdogReport {
  return {
    day: klDay(now),
    at: now.toISOString(),
    checks: [{ name: 'watchdog', status: 'error', detail: (e as Error)?.message ?? String(e) }],
    problems: [{ check: 'watchdog', text: `The watchdog itself crashed, so nothing was checked this morning (${clip((e as Error)?.message ?? String(e), 140)}).`, fix: 'Ask Claude to look at lib/watchdog.ts.' }],
    fixed: [],
    wouldRetry: [],
  }
}

// ---------------------------------------------------------------- the message
export type WeekSummary = { expected: number; ran: number; missed: string[]; problems: number; fixed: number }

const MAX_SHOWN = 8

/** The watchdog's part of the 9am message, or null when there is nothing to say. */
export function watchdogSection(r: WatchdogReport, opts: { week?: WeekSummary | null } = {}): string | null {
  if (!r.problems.length && !r.fixed.length) return opts.week ? weekLine(opts.week) : null
  const head = ['🩺 <b>Watchdog</b>', r.problems.length ? plural(r.problems.length, 'problem') : '', r.fixed.length ? `${r.fixed.length} fixed` : '']
    .filter(Boolean)
    .join(' · ')
  const parts = [head]
  for (const f of r.fixed) parts.push(`🔁 ${esc(f.text)}`)
  for (const p of r.problems.slice(0, MAX_SHOWN)) parts.push(`⚠️ ${esc(p.text)}${p.fix ? `\n<i>Fix:</i> ${esc(p.fix)}` : ''}`)
  if (r.problems.length > MAX_SHOWN) parts.push(`…and ${r.problems.length - MAX_SHOWN} more. Ask Claude for the full watchdog report.`)
  return parts.join('\n\n')
}

function weekLine(w: WeekSummary): string {
  const ran = w.expected ? `ran ${w.ran} of ${w.expected} mornings` : 'this is its first week'
  const missed = w.missed.length ? ` (missed ${w.missed.join(', ')})` : ''
  return `🩺 <b>Watchdog</b>: all clear this morning. Last 7 days: ${ran}${missed}, ${plural(w.problems, 'problem')} flagged, ${w.fixed} fixed by a retry.`
}

// ---------------------------------------------------------------- the record of each morning
const markerPath = (day: string) => `watchdog/${day}.json`

/** Write this morning's report (cfo-cache `watchdog/<day>.json`). The 8am dead-man check and the Monday line read it. */
export async function saveWatchdog(db: SupabaseClient, r: WatchdogReport, extra: Record<string, unknown> = {}): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(markerPath(r.day), JSON.stringify({ ...r, ...extra }), { upsert: true, contentType: 'application/json' })
  if (error) console.error('[CFO] watchdog report not stored:', error.message)
}

/** The last 7 mornings, for Monday's line. Mornings before the watchdog's first run don't count as missed. */
export async function weekSummary(db: SupabaseClient, today: string): Promise<WeekSummary> {
  const { data: list } = await db.storage.from(BUCKET).list('watchdog', { limit: 1000 })
  const days = new Set((list ?? []).map((o) => o.name.replace(/\.json$/, '')))
  const first = [...days].sort()[0] ?? today
  const w: WeekSummary = { expected: 0, ran: 0, missed: [], problems: 0, fixed: 0 }
  for (let i = 7; i >= 1; i--) {
    const day = addDays(today, -i)
    if (day < first) continue
    w.expected++
    if (!days.has(day)) {
      w.missed.push(dayLabel(day))
      continue
    }
    w.ran++
    const { data } = await db.storage.from(BUCKET).download(markerPath(day))
    if (!data) continue
    const r = JSON.parse(await data.text()) as Partial<WatchdogReport>
    w.problems += r.problems?.length ?? 0
    w.fixed += r.fixed?.length ?? 0
  }
  return w
}

/**
 * The watchdog's own watchdog, run by the 8am job: did yesterday's 9am check
 * finish? Returns the message to send the owner, or null. Silent until the
 * watchdog has run at least once, so the first morning after a deploy is quiet.
 */
export async function deadManCheck(db: SupabaseClient, now = new Date()): Promise<string | null> {
  const yesterday = addDays(klDay(now), -1)
  const { data: list, error } = await db.storage.from(BUCKET).list('watchdog', { limit: 1 })
  if (error || !list?.length) return null
  const { data } = await db.storage.from(BUCKET).download(markerPath(yesterday))
  if (data) return null
  return (
    `⚠️ <b>Watchdog</b>: yesterday's 9am check (${dayLabel(yesterday)}) never finished, so nothing was checked. ` +
    'The 9am job (/api/cron-daily) probably didn\'t run or crashed. Check Vercel → cashflowos-leo → Logs, or ask Claude to look.'
  )
}
