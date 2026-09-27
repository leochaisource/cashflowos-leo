import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/deal-preview.ts (Node type stripping).
import {
  eventFor,
  computeShare,
  marginals,
  standards,
  type Deal,
  type DealEvent,
  type ShareInput,
  type ShareResult,
} from './deal.ts'
import { contactFirstTouch, classifyFirstTouch } from './ghl.ts'

// YOUR SHARE, THIS MORNING — the Claude Malaysia deal applied to the event in
// progress, with whatever is known so far.
//
// Seat split, in order of trust:
//   1. Kingsley's EventOps report (house_reports) — the House's payment records
//      and community join dates, i.e. what the statement will be settled on.
//   2. Our own reading of each buyer's first touch in GoHighLevel — a fallback
//      that undercounts Ads Seats (GHL loses the ad click behind "cs follow up"
//      links and direct checkouts), and says so.
// Ad spend is Meta's, from ad_daily, for the event's window. Shared Costs are
// the worked example's until the House's statement gives the invoices.
//
// Pure apart from the Supabase / GHL reads, which take their clients as
// parameters so the cron and scripts/deal-preview.ts produce the same block.

export type SeatSource = 'eventops' | 'ghl-estimate'

export type SeatRow = {
  contactName: string | null
  amount: number
  seats: number
  isUpsell: boolean
  sourceName: string | null
  source: 'ads' | 'organic' | 'unknown'
  reason: string
}

export type DealEstimate = {
  event: DealEvent
  from: string
  to: string
  asOf: string
  source: SeatSource
  sourceNote: string
  input: ShareInput
  seats: { ads: number; organic: number; unknown: number; total: number }
  result: ShareResult
  marginals: ReturnType<typeof marginals>
  standards: ReturnType<typeof standards>
  seatRows: SeatRow[]
  text: string
}

const MAX_REPORT_AGE_DAYS = 2
const dayStart = (d: string) => new Date(`${d}T00:00:00+08:00`).toISOString()
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999+08:00`).toISOString()
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rm = (n: number) => `${n < 0 ? '−' : ''}RM${Math.round(Math.abs(n)).toLocaleString('en-MY')}`
const shortDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')

/** Meta spend for the event window, up to the report day. */
async function adSpendBetween(db: SupabaseClient, project: string, from: string, to: string): Promise<number> {
  let total = 0
  for (let at = 0; ; at += 1000) {
    const { data, error } = await db
      .from('ad_daily')
      .select('spend')
      .eq('project', project)
      .gte('date', from)
      .lte('date', to)
      .order('id')
      .range(at, at + 999)
    if (error) throw new Error(`ad spend unreadable: ${error.message}`)
    for (const r of (data ?? []) as { spend: number | string }[]) total += Number(r.spend) || 0
    if (!data || data.length < 1000) break
  }
  return total
}

type HouseReport = {
  report_date: string
  paid: number | null
  ads_confirmed: number | null
  organic_confirmed: number | null
  unknown: number | null
  general: number | null
  vip: number | null
  affiliate_seats: number | null
  ads_revenue: number | string | null
  organic_revenue: number | string | null
}

async function latestHouseReport(db: SupabaseClient, project: string, eventDate: string, asOf: string): Promise<HouseReport | null> {
  const { data, error } = await db
    .from('house_reports')
    .select('report_date, paid, ads_confirmed, organic_confirmed, unknown, general, vip, affiliate_seats, ads_revenue, organic_revenue')
    .eq('project', project)
    .eq('event_date', eventDate)
    .lte('report_date', asOf < eventDate ? eventDate : asOf)
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null // table not created yet, or no report: fall back
  const r = data as HouseReport
  const age = (Date.parse(asOf) - Date.parse(r.report_date)) / 864e5
  if (age > MAX_REPORT_AGE_DAYS || r.ads_confirmed === null || r.organic_confirmed === null) return null
  return r
}

/**
 * The fallback: classify each buyer in the window from GHL. Classifications are
 * stored on ghl_sales, so each contact is looked up once, not every morning.
 */
async function ghlSeats(
  db: SupabaseClient,
  project: string,
  deal: Deal,
  from: string,
  to: string,
  ghl: { locationId: string; token: string } | null,
  lookupMax: number,
): Promise<SeatRow[]> {
  const base = 'id, contact_id, contact_name, amount, seats, source_name, is_upsell'
  const read = (cols: string) =>
    db.from('ghl_sales').select(cols).eq('project', project).gte('paid_at', dayStart(from)).lte('paid_at', dayEnd(to)).order('paid_at')
  let res = await read(base + ', seat_source, source_reason')
  const stored = !res.error
  if (res.error) res = await read(base)
  if (res.error) throw new Error(`sales unreadable: ${res.error.message}`)
  type Row = { id: number; contact_id: string | null; contact_name: string | null; amount: number | null; seats: number; source_name: string | null; is_upsell: boolean; seat_source?: string | null; source_reason?: string | null }
  const rows = (res.data ?? []) as unknown as Row[]

  // One verdict per buyer: an upgrade belongs to the seat it upgrades.
  const verdict = new Map<string, { source: SeatRow['source']; reason: string }>()
  for (const r of rows) if (r.contact_id && r.seat_source) verdict.set(r.contact_id, { source: r.seat_source as SeatRow['source'], reason: r.source_reason ?? '' })
  let looked = 0
  for (const r of rows) {
    const affiliate = deal.affiliateSources.some((a) => (r.source_name ?? '').includes(a))
    if (!r.contact_id || verdict.has(r.contact_id)) continue
    if (affiliate) {
      verdict.set(r.contact_id, { source: 'organic', reason: `affiliate sale (${r.source_name})` })
    } else if (ghl && looked < lookupMax) {
      looked++
      try {
        const t = await contactFirstTouch(ghl.locationId, ghl.token, r.contact_id)
        const v = classifyFirstTouch(t, deal.agreementDate)
        verdict.set(r.contact_id, v)
        if (stored)
          await db
            .from('ghl_sales')
            .update({ seat_source: v.source, source_reason: v.reason, contact_added_at: t.dateAdded })
            .eq('project', project)
            .eq('contact_id', r.contact_id)
      } catch {
        // One unreadable contact stays unknown; the rest still count.
      }
    }
  }
  return rows.map((r) => {
    const v = (r.contact_id && verdict.get(r.contact_id)) || { source: 'unknown' as const, reason: 'not classified yet' }
    return {
      contactName: r.contact_name,
      amount: Number(r.amount) || 0,
      seats: r.is_upsell ? 0 : r.seats,
      isUpsell: r.is_upsell,
      sourceName: r.source_name,
      source: v.source,
      reason: v.reason,
    }
  })
}

export async function estimateDeal(
  db: SupabaseClient,
  project: string,
  deal: Deal,
  asOf: string,
  opts: { ghl?: { locationId: string; token: string } | null; lookupMax?: number } = {},
): Promise<DealEstimate | null> {
  const w = eventFor(deal, asOf)
  if (!w) return null
  const upTo = asOf < w.to ? asOf : w.to
  const adSpend = Math.round((await adSpendBetween(db, project, w.from, upTo)) * 100) / 100

  // Revenue per seat, from what the window's buyers actually paid (VIP
  // tickets and upgrades included); the list price if nothing is stored yet.
  let seatRows: SeatRow[] = []
  let seatRowsError: string | null = null
  try {
    seatRows = await ghlSeats(db, project, deal, w.from, upTo, opts.ghl ?? null, opts.lookupMax ?? 60)
  } catch (e) {
    seatRowsError = (e as Error).message
  }
  const soldSeats = seatRows.reduce((s, r) => s + r.seats, 0)
  const soldRevenue = seatRows.reduce((s, r) => s + r.amount, 0)
  const avgTicket = soldSeats > 0 ? soldRevenue / soldSeats : deal.ticketPrices.general

  const report = await latestHouseReport(db, project, w.to, asOf)
  let input: ShareInput
  let source: SeatSource
  let sourceNote: string
  if (report) {
    const ads = report.ads_confirmed ?? 0
    const organic = report.organic_confirmed ?? 0
    const unknown = report.unknown ?? 0
    const mix = (report.general ?? 0) + (report.vip ?? 0)
    const avg = mix > 0 ? ((report.general ?? 0) * deal.ticketPrices.general + (report.vip ?? 0) * deal.ticketPrices.vip) / mix : avgTicket
    const adsRev = report.ads_revenue !== null ? Number(report.ads_revenue) : ads * avg
    const orgRev = report.organic_revenue !== null ? Number(report.organic_revenue) : organic * avg
    input = {
      adsSeats: ads,
      organicSeats: organic,
      unknownSeats: unknown,
      adsRevenue: adsRev,
      organicRevenue: orgRev,
      unknownRevenue: unknown * avg,
      adSpend,
      affiliateCommission: (report.affiliate_seats ?? 0) * deal.affiliateRate * deal.ticketPrices.general,
    }
    source = 'eventops'
    sourceNote = `EventOps, ${shortDay(report.report_date).replace(/^\w+ /, '')}`
  } else {
    if (seatRowsError) throw new Error(seatRowsError)
    const sum = (k: SeatRow['source'], f: (r: SeatRow) => number) => seatRows.filter((r) => r.source === k).reduce((s, r) => s + f(r), 0)
    const affiliateCommission = seatRows
      .filter((r) => !r.isUpsell && deal.affiliateSources.some((a) => (r.sourceName ?? '').includes(a)))
      .reduce((s, r) => s + deal.affiliateRate * r.amount, 0)
    input = {
      adsSeats: sum('ads', (r) => r.seats),
      organicSeats: sum('organic', (r) => r.seats),
      unknownSeats: sum('unknown', (r) => r.seats),
      adsRevenue: sum('ads', (r) => r.amount),
      organicRevenue: sum('organic', (r) => r.amount),
      unknownRevenue: sum('unknown', (r) => r.amount),
      adSpend,
      affiliateCommission,
    }
    source = 'ghl-estimate'
    sourceNote = 'our GHL estimate — EventOps feed not connected yet'
  }

  const result = computeShare(deal, input)
  const m = marginals(deal, input)
  const st = standards(deal, input)
  const seats = {
    ads: input.adsSeats,
    organic: input.organicSeats,
    unknown: input.unknownSeats,
    total: input.adsSeats + input.organicSeats + input.unknownSeats,
  }
  const est: Omit<DealEstimate, 'text'> = { event: w.event, from: w.from, to: w.to, asOf, source, sourceNote, input, seats, result, marginals: m, standards: st, seatRows }
  return { ...est, text: renderDealBlock(est, deal) }
}

/** The daily block — Telegram HTML, 6–7 lines. Operator only, never a client group. */
export function renderDealBlock(e: Omit<DealEstimate, 'text'>, deal: Deal): string {
  const r = e.result
  const lines = [
    `💰 <b>Your share — ${esc(e.event.label)} · ${shortDay(e.event.date)}</b> (estimate)`,
    `Seats ${e.seats.total}: ads ${e.seats.ads} · organic ${e.seats.organic} · unknown ${e.seats.unknown} — <i>${esc(e.sourceNote)}</i>`,
  ]
  if (r.movedToOrganic > 0)
    lines.push(
      `Organic floor: House has ${e.seats.organic + e.seats.unknown} of ${deal.organicFloor} → ${r.movedToOrganic} of your ads seats paid at ${Math.round(deal.rates.organic * 100)}%`,
    )
  lines.push(
    `Ads Pool ${rm(r.adsPool)} → you ${rm(r.partnerFromAds)} · Organic Pool ${rm(r.organicPool)} → you ${rm(r.partnerFromOrganic)}`,
    `<b>≈ ${rm(r.partner)} so far</b> · ad spend ${rm(e.input.adSpend)}`,
  )
  const m = e.marginals
  if (r.adsPool < 0 && m.breakEven !== null)
    lines.push(
      `Next ads ticket +${rm(m.nextAdsSeat)} now; ${m.breakEven} more ads seats clear the Ads Pool, then +${rm(m.perSeatAfterBreakEven)} each`,
    )
  else
    lines.push(`Next ads ticket +${rm(m.nextAdsSeat)} · RM100 of spend with no sale ${m.extra100Spend < 0 ? rm(m.extra100Spend) : 'costs you RM0'}`)
  const s = e.standards
  if (s.costPerTicket !== null)
    lines.push(
      `Cost per ads ticket ${rm(s.costPerTicket)} (review line ${rm(s.costPerTicketReview)})${s.overReviewLine ? ' ⚠️' : ''} · ads seats ${s.adsSeats}/${s.adsSeatsTarget}`,
    )
  return lines.join('\n')
}

/** Keep the morning's estimate. Never throws: a storage fault must not cost the brief. */
export async function saveDealDaily(db: SupabaseClient, project: string, e: DealEstimate): Promise<string | null> {
  const { error } = await db.from('deal_daily').upsert(
    {
      project,
      date: e.asOf,
      event_no: e.event.no,
      event_date: e.event.date,
      source: e.source,
      inputs: { ...e.input, seats: e.seats, from: e.from, to: e.to, sourceNote: e.sourceNote },
      result: { ...e.result, marginals: e.marginals, standards: e.standards },
      text: e.text,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project,date' },
  )
  if (!error) return null
  return /deal_daily|schema cache|does not exist/i.test(error.message)
    ? 'Deal snapshot not stored — run supabase/deal.sql once in the SQL editor.'
    : `Deal snapshot not stored: ${error.message}`
}
