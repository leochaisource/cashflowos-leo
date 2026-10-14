import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/hotleads-sheet.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { dayBounds } from './ghl.ts'
import { eventFor } from './deal.ts'
import { buildFollowups, type Followups } from './followups.ts'
import { hotLeadRows, hotListRows, pushHotLeads, paidList, type SheetRow } from './hot-leads-sheet.ts'
import { syncHotList, type HotListSync } from './hot-list.ts'

// ONE DAY'S HOT LEADS → THE SHEET, as one call.
//
// Three callers, one path, so the sheet can't depend on who filled it:
//   • the 8am cron        — yesterday, whole day (it also assigns GHL tasks; this doesn't)
//   • /api/hotleads-sync  — TODAY SO FAR, at 9am, 12pm and 6pm (owner, 2026-10-02),
//                           fired by a time trigger in the sheet's own Apps Script
//   • scripts/hotleads-sheet.ts — backfill / re-run of any day
//
// Re-running a day is safe: rows are keyed date|contactId, so a later run
// refreshes interest, objection and last-message for leads already listed and
// adds the new ones. The team's status and Notes columns are never touched.

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

/** Today's date where the client is, e.g. "2026-10-02" in Kuala Lumpur. */
export const localDay = (timeZone: string, at = new Date()) => at.toLocaleDateString('en-CA', { timeZone })

export type HotLeadsSync = {
  day: string
  /** Chats read up to this instant (the end of the day, or "now" for today). */
  untilISO: string
  rows: SheetRow[]
  followups: Followups
  /** null = not pushed (dry run, or the sheet isn't configured). */
  pushed: Awaited<ReturnType<typeof pushHotLeads>> | null
  /** Ariella's GHL list brought up to date from this run (null = no list configured). */
  hotList: HotListSync | null
}

/**
 * Judge `day`'s WhatsApp chats and unpaid checkouts, build the sheet rows and
 * (unless `push` is null) send them. `untilISO` cuts the day short — "today so
 * far" — and also makes "paid" mean paid by then. Returns null when the client
 * has no follow-ups or no event is scheduled after `day`.
 */
export async function syncHotLeadsDay(args: {
  client: AdClient
  day: string
  untilISO?: string
  db?: SupabaseClient | null
  anthropic: Anthropic | null
  push: { url: string; secret: string } | null
  /** Also bring Ariella's GHL list up to date — the live refresh only, never a backfill. */
  syncList?: boolean
}): Promise<HotLeadsSync | null> {
  const { client } = args
  const g = client.ghl
  if (!g?.followups || !client.deal) return null
  const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
  const next = eventFor(client.deal, addDay(args.day, 1))
  if (!next) return null

  const { start, end } = dayBounds(args.day, tz)
  const until = args.untilISO && args.untilISO < end ? args.untilISO : end
  const token = process.env[g.tokenEnv]!.trim()
  const locationId = process.env[g.locationEnv]!.trim()

  const f = await buildFollowups({
    locationId,
    token,
    day: args.day,
    dayStartISO: start,
    dayEndISO: until,
    salesSinceISO: dayBounds(next.from, tz).start,
    asOfISO: until,
    includeSources: g.includeOrderSources ?? [],
    product:
      `${client.client ?? client.name} one-day Claude AI workshop on ${next.to}, tickets ` +
      `RM${client.deal.ticketPrices.general} General / RM${client.deal.ticketPrices.vip} VIP`,
    anthropic: args.anthropic,
    notLeads: g.notLeads,
    db: args.db ?? null,
    cacheKey: client.id,
  })
  const common = {
    f,
    project: client.id,
    locationId,
    token,
    agreementDate: client.deal.agreementDate,
    assignee: g.followupAssignee?.name ?? null,
    funnels: g.funnels.map((x) => ({ formId: x.formId, label: x.label })),
    db: args.db ?? null,
  }
  // Ariella's one list in GHL (owner, 2026-10-14) — the live refresh only; a
  // backfill of an old day must never put old leads back on her list. The
  // sheet is then a copy of that list; without one it gets the day's rows.
  const hotList = g.hotList && args.syncList ? await syncHotList({ client, f, db: args.db ?? null }) : null
  const rows = hotList?.ok ? await hotListRows({ ...common, cards: hotList.all }) : await hotLeadRows(common)
  const pushed = args.push
    ? hotList?.ok
      ? await pushHotLeads(args.push.url, args.push.secret, rows, [], 'list')
      : await pushHotLeads(args.push.url, args.push.secret, rows, paidList(f))
    : null
  return { day: args.day, untilISO: until, rows, followups: f, pushed, hotList }
}
