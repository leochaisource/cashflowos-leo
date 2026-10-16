import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/closer-coach.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { dayBounds } from './ghl.ts'
import { eventFor } from './deal.ts'
import { gatherCoachInput, coachReport, coachRequest, renderCoach } from './closer-coach.ts'
import { coachBatchSent, submitCoachRequest, takeBatchedCoach, type CoachBatchStep } from './coach-batch.ts'
import { sendMessage } from './telegram.ts'
import { readHotList } from './hot-list.ts'

// The closing coach, end to end: yesterday's threads → coaching → Telegram.
// Shared by POST /api/closer-coach (fired by the sheet's 9am trigger, through
// /api/hotleads-sync) and scripts/closer-coach.ts.
//
// Sent once per day: the result is recorded on that day's brief_daily row
// (payload.coach), and a second run for the same day is skipped unless forced.

const LIMIT = 3800
function chunk(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > LIMIT) {
      out.push(buf)
      buf = line
    } else buf = buf ? `${buf}\n${line}` : line
  }
  if (buf) out.push(buf)
  return out
}

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

export type CoachRun = {
  ok: boolean
  day: string
  text: string | null
  sentTo: string[]
  skipped?: string
  error?: string | null
}

/** The day the coach reviews by default: yesterday where the client is. */
function coachDay(client: AdClient): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: client.ghl?.timeZone ?? 'Asia/Kuala_Lumpur' })
  return addDay(today, -1)
}

/** Everything the coach reads for `day`: the threads and numbers, the product line, her GHL list. */
async function prepareCoach(client: AdClient, day: string) {
  const g = client.ghl!
  const deal = client.deal!
  const closer = g.followupAssignee!
  const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz })
  const { start, end } = dayBounds(day, tz)
  const next = eventFor(deal, today)
  const upcoming = deal.events.filter((e) => e.date >= today).map((e) => e.date)
  const product =
    `${client.client ?? client.name}'s one-day, in-person Claude AI workshop in Kuala Lumpur (General and VIP ` +
    `tickets). Upcoming classes: ${upcoming.join(', ') || 'none scheduled'}. Prices, bonuses and deadlines: only as stated in the chats`
  const input = await gatherCoachInput({
    locationId: process.env[g.locationEnv]!.trim(),
    token: process.env[g.tokenEnv]!.trim(),
    day,
    dayStartISO: start,
    dayEndISO: end,
    ariellaId: closer.userId,
    salesSinceISO: dayBounds(next?.from ?? deal.agreementDate, tz).start,
    includeSources: g.includeOrderSources ?? [],
    notLeads: g.notLeads,
  })
  // Her one list in GHL (owner, 2026-10-14): the coach names only leads on it,
  // and shows the list itself, so Telegram and GHL never disagree.
  const hl = g.hotList ? await readHotList(client) : null
  const list = g.hotList && hl && !hl.error ? { open: hl.open, stages: g.hotList.openStages, pipeline: g.hotList.pipeline } : undefined
  return { input, product, hl, list }
}

/**
 * After midnight (/api/intent-batch): send yesterday's coaching request to the
 * half-price Batch API, once per day. The 9am run then uses its answer.
 */
export async function submitOvernightCoach(args: { client: AdClient; anthropic: Anthropic; db: SupabaseClient }): Promise<CoachBatchStep> {
  const { client } = args
  const closer = client.ghl?.followupAssignee
  if (!client.ghl || !closer || !client.deal) return { ok: true, action: 'coach: no follow-up owner configured' }
  const day = coachDay(client)
  if (await coachBatchSent(args.db, client, day)) return { ok: true, action: 'coach: already sent for the day', day }
  const { input, product, list } = await prepareCoach(client, day)
  return submitCoachRequest({ ...args, day, request: coachRequest(input, product, closer.name, list?.open) })
}

export async function runCloserCoach(args: {
  client: AdClient
  /** The day to review; default yesterday where the client is. */
  day?: string
  /** "closer" = the follow-up owner (owner instead until their Telegram is linked); "owner" = a preview to the owner; "none" = build only. */
  to: 'closer' | 'owner' | 'none'
  db?: SupabaseClient | null
  anthropic: Anthropic | null
  force?: boolean
}): Promise<CoachRun> {
  const { client } = args
  const g = client.ghl
  const closer = g?.followupAssignee
  if (!g || !closer || !client.deal) return { ok: false, day: '', text: null, sentTo: [], error: 'no follow-up owner configured' }
  const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
  const day = args.day ?? coachDay(client)

  // Once a day: a second 9am run (or a manual one) doesn't send it again.
  const row = args.db
    ? (await args.db.from('brief_daily').select('id, payload').eq('project', client.id).eq('date', day).maybeSingle()).data
    : null
  const already = (row?.payload as { coach?: { sentAt?: string } } | null)?.coach?.sentAt
  if (already && !args.force && args.to === 'closer') return { ok: true, day, text: null, sentTo: [], skipped: `already sent ${already}` }

  const { input, product, hl, list } = await prepareCoach(client, day)
  // Written overnight at half price (lib/coach-batch.ts) — the real 9am send
  // only, so a manual preview can never cancel the night's batch.
  const batched = args.to === 'closer' && args.anthropic && args.db ? await takeBatchedCoach({ client, anthropic: args.anthropic, db: args.db, day }).catch(() => null) : null
  const { report, error } = batched
    ? { report: batched, error: null }
    : args.anthropic
      ? await coachReport(args.anthropic, input, product, closer.name, list?.open)
      : { report: null, error: 'ANTHROPIC_API_KEY not set' }
  let text = renderCoach(input.stats, report, closer.name, error, list)
  if (hl?.error) text += `\n\n<i>Your GHL list couldn't be read this morning (${hl.error.slice(0, 120)}).</i>`

  const owner = process.env.OWNER_CHAT_ID?.trim()
  let recipients: string[] = []
  if (args.to === 'owner') recipients = owner ? [owner] : []
  if (args.to === 'closer') {
    if (closer.telegramChatId) recipients = [closer.telegramChatId]
    else if (owner) {
      recipients = [owner]
      text = `<i>${closer.name}'s Telegram isn't linked yet, so this came to you. It's what ${closer.name} will get each morning.</i>\n\n${text}`
    }
  }

  const sendAll = async (chatId: string, body: string): Promise<string | null> => {
    for (const piece of chunk(body)) {
      const r = await sendMessage(chatId, piece, { noPreview: true })
      if (!r.ok) return r.error ?? 'send failed'
    }
    return null
  }
  const sentTo: string[] = []
  let sendError: string | null = null
  for (const chatId of recipients) {
    const err = await sendAll(chatId, text)
    if (err) sendError = err
    else sentTo.push(chatId)
  }

  // The owner gets a copy of what the closer got (owner, 2026-10-08), marked as
  // such. A failed copy never counts against the closer's send.
  if (args.to === 'closer' && closer.telegramChatId && sentTo.includes(closer.telegramChatId) && owner && owner !== closer.telegramChatId) {
    const at = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
    const copyErr = await sendAll(owner, `📋 <i>Copy — sent to ${closer.name} on Telegram at ${at}.</i>\n\n${text}`)
    if (!copyErr) sentTo.push(owner)
  }

  if (args.to === 'closer' && sentTo.length && args.db && row?.id) {
    const payload = { ...((row.payload as Record<string, unknown>) ?? {}), coach: { sentAt: new Date().toISOString(), to: sentTo, modelError: error, text } }
    await args.db.from('brief_daily').update({ payload }).eq('id', row.id)
  }
  return { ok: !sendError && (recipients.length === 0 || sentTo.length > 0), day, text, sentTo, error: sendError ?? error }
}
