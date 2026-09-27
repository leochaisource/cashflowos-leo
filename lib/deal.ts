// THE DEAL, AS CODE — how Leo is paid on the Claude Malaysia collaboration.
//
// Source: Marketing Collaboration Agreement, CMO Consulting Sdn Bhd (Claude
// Malaysia, "the House") × SF Media Resources ("the Partner"), 27 Aug 2026,
// term 13 Sep – 14 Dec 2026. Clause and schedule numbers below refer to it.
//
// Pure: no I/O, no server-only imports, so the cron, the dashboard and
// scripts/deal-preview.ts all run the identical arithmetic. The Schedule 2
// worked example (the House's event of 22 Aug 2026) is the test this must pass
// to the sen — see scripts/deal-preview.ts --selftest.
//
// Two readings are OWNER DECISIONS, not contract text (2026-09-27):
//   · A negative pool pays the Partner RM0 from that pool; it never eats into
//     another pool's share. The contract is silent on negative pools.
//   · Unknown-source seats count as Organic (clause 6(c): a paid seat with no
//     recorded paid touch is an Organic Seat).

export type DealEvent = { no: number; date: string; label: string }

export type Deal = {
  agreementDate: string
  /** Schedule 4 — the one-day Events, in order. Classes are not tracked yet. */
  events: DealEvent[]
  rates: { ads: number; organic: number }
  /** Card/gateway processing, as a share of each pool's revenue (Schedule 2 §1). */
  processing: number
  /** Clause 6(f): below this many Organic Seats, the shortfall comes out of Ads Seats. */
  organicFloor: number
  /** Schedule 2: affiliate commission, as a share of ticket value, where payable. */
  affiliateRate: number
  /** GHL funnel names whose sales are affiliate sales (Organic, affiliate commission due). */
  affiliateSources: string[]
  /** Shared Costs per event until the House's statement gives the actual invoices (worked example). */
  sharedCostDefaults: { venue: number; camera: number; platform: number; mealPerSeat: number }
  ticketPrices: { general: number; vip: number }
  /** Schedule 3 — measured by the House over two events; shown as a daily early warning. */
  standards: { adsSeats: number; costPerTicketReview: number }
}

export const DEAL_CLAUDE_MALAYSIA: Deal = {
  agreementDate: '2026-08-27',
  events: [
    { no: 1, date: '2026-09-13', label: 'Event 1' },
    { no: 2, date: '2026-10-04', label: 'Event 2' },
    { no: 3, date: '2026-10-25', label: 'Event 3' },
    { no: 4, date: '2026-11-14', label: 'Event 4' },
    { no: 5, date: '2026-11-29', label: 'Event 5' },
    { no: 6, date: '2026-12-06', label: 'Event 6' },
  ],
  rates: { ads: 0.6, organic: 0.2 },
  processing: 0.03,
  organicFloor: 27,
  affiliateRate: 0.3,
  affiliateSources: ['[Kamin]'],
  sharedCostDefaults: { venue: 1000, camera: 1000, platform: 525, mealPerSeat: 25 },
  ticketPrices: { general: 397, vip: 697 },
  standards: { adsSeats: 24, costPerTicketReview: 150 },
}

// ---------------------------------------------------------------- the event cycle

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

/**
 * The event a given day's sales and spend belong to: the first event on or
 * after that day. Its window runs from the day after the previous event to the
 * event day itself — ticket sales and ad spend in that window fill that event.
 * Null after the last event (15–31 Dec: closed, no spend).
 */
export function eventFor(deal: Deal, dayISO: string): { event: DealEvent; from: string; to: string } | null {
  const i = deal.events.findIndex((e) => e.date >= dayISO)
  if (i < 0) return null
  const prev = deal.events[i - 1]
  return { event: deal.events[i], from: prev ? addDays(prev.date, 1) : deal.agreementDate, to: deal.events[i].date }
}

/** The previous event's day — what "since the last class" means in the performance block. */
export function previousEventDate(deal: Deal, dayISO: string): string | null {
  const past = deal.events.filter((e) => e.date < dayISO)
  return past.length ? past[past.length - 1].date : null
}

// ---------------------------------------------------------------- Schedule 2

export type ShareInput = {
  adsSeats: number
  organicSeats: number
  /** Seats with no recorded source — counted as Organic (clause 6(c)). */
  unknownSeats: number
  adsRevenue: number
  organicRevenue: number
  unknownRevenue: number
  adSpend: number
  /** Venue + meals + camera + GHL/WhatsApp for the event. Defaults from the deal when omitted. */
  sharedCosts?: number
  /** Affiliate commission payable on Organic seats (30% of ticket value where payable). */
  affiliateCommission?: number
}

export type ShareResult = {
  totalSeats: number
  sharedCosts: number
  /** Clause 6(f): Ads Seats moved to the Organic rate because Organic fell short of the floor. */
  movedToOrganic: number
  adsSeatsCounted: number
  organicSeatsCounted: number
  adsRevenueCounted: number
  organicRevenueCounted: number
  adsPool: number
  organicPool: number
  partnerFromAds: number
  partnerFromOrganic: number
  partner: number
  house: number
  lines: { label: string; value: number }[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function sharedCostsFor(deal: Deal, seats: number): number {
  const d = deal.sharedCostDefaults
  return d.venue + d.camera + d.platform + d.mealPerSeat * seats
}

/** The contract's formula, clause 6(f) floor included. Every figure rounded to the sen. */
export function computeShare(deal: Deal, i: ShareInput): ShareResult {
  const organicRaw = i.organicSeats + i.unknownSeats
  const organicRevRaw = i.organicRevenue + i.unknownRevenue
  const totalSeats = i.adsSeats + organicRaw
  const shared = i.sharedCosts ?? sharedCostsFor(deal, totalSeats)

  // 6(f): "If Organic Seats at any event fall below twenty-seven, the shortfall
  // is deducted from that event's Ads Seat count and paid at the Organic Pool rate."
  const moved = Math.min(i.adsSeats, Math.max(0, deal.organicFloor - organicRaw))
  const perAdsSeat = i.adsSeats > 0 ? i.adsRevenue / i.adsSeats : 0
  const adsSeats = i.adsSeats - moved
  const organicSeats = organicRaw + moved
  const adsRev = i.adsRevenue - moved * perAdsSeat
  const orgRev = organicRevRaw + moved * perAdsSeat

  const share = (seats: number) => (totalSeats > 0 ? (shared * seats) / totalSeats : 0)
  const adsShared = share(adsSeats)
  const orgShared = share(organicSeats)
  const adsProc = deal.processing * adsRev
  const orgProc = deal.processing * orgRev
  const affiliate = i.affiliateCommission ?? 0

  const adsPool = r2(adsRev - i.adSpend - adsShared - adsProc)
  const organicPool = r2(orgRev - affiliate - orgShared - orgProc)
  // Owner's reading: a negative pool pays RM0 and never reduces another pool's share.
  const partnerFromAds = r2(Math.max(0, deal.rates.ads * adsPool))
  const partnerFromOrganic = r2(Math.max(0, deal.rates.organic * organicPool))
  const partner = r2(partnerFromAds + partnerFromOrganic)

  return {
    totalSeats,
    sharedCosts: r2(shared),
    movedToOrganic: moved,
    adsSeatsCounted: adsSeats,
    organicSeatsCounted: organicSeats,
    adsRevenueCounted: r2(adsRev),
    organicRevenueCounted: r2(orgRev),
    adsPool,
    organicPool,
    partnerFromAds,
    partnerFromOrganic,
    partner,
    house: r2(adsPool + organicPool - partner),
    lines: [
      { label: 'Ads Seat revenue', value: r2(adsRev) },
      { label: 'Advertising spend', value: -r2(i.adSpend) },
      { label: 'Shared Costs × Ads / Total seats', value: -r2(adsShared) },
      { label: 'Processing 3% × Ads revenue', value: -r2(adsProc) },
      { label: 'Organic Seat revenue', value: r2(orgRev) },
      { label: 'Affiliate commissions', value: -r2(affiliate) },
      { label: 'Shared Costs × Organic / Total seats', value: -r2(orgShared) },
      { label: 'Processing 3% × Organic revenue', value: -r2(orgProc) },
    ],
  }
}

/**
 * What moves the number — by re-running the formula, so the answer is right in
 * every regime (floor active, a pool below zero, both).
 */
export function marginals(deal: Deal, i: ShareInput) {
  const base = computeShare(deal, i)
  const avgTicket =
    i.adsSeats > 0 ? i.adsRevenue / i.adsSeats : (deal.ticketPrices.general + deal.ticketPrices.vip) / 2
  const meal = deal.sharedCostDefaults.mealPerSeat
  const withSeat = (k: number): ShareInput => ({
    ...i,
    adsSeats: i.adsSeats + k,
    adsRevenue: i.adsRevenue + k * avgTicket,
    sharedCosts: i.sharedCosts === undefined ? undefined : i.sharedCosts + k * meal,
  })
  const nextAdsSeat = r2(computeShare(deal, withSeat(1)).partner - base.partner)
  const extra100Spend = r2(computeShare(deal, { ...i, adSpend: i.adSpend + 100 }).partner - base.partner)
  // More Ads Seats needed before the Ads Pool itself is above zero (null = more than 200).
  let breakEven: number | null = 0
  if (base.adsPool < 0) {
    breakEven = null
    for (let k = 1; k <= 200; k++)
      if (computeShare(deal, withSeat(k)).adsPool >= 0) {
        breakEven = k
        break
      }
  }
  // While the Ads Pool is below zero an extra ads seat barely moves Leo's share;
  // this is what each one is worth once the pool is back above zero.
  const k = (breakEven ?? 0) + 1
  const perSeatAfterBreakEven = r2(computeShare(deal, withSeat(k)).partner - computeShare(deal, withSeat(k - 1)).partner)
  return { nextAdsSeat, extra100Spend, breakEven, perSeatAfterBreakEven }
}

/** Schedule 3 standards, as an early warning (the House measures them over two events). */
export function standards(deal: Deal, i: Pick<ShareInput, 'adsSeats' | 'adSpend'>) {
  const costPerTicket = i.adsSeats > 0 ? r2(i.adSpend / i.adsSeats) : null
  return {
    adsSeats: i.adsSeats,
    adsSeatsTarget: deal.standards.adsSeats,
    costPerTicket,
    costPerTicketReview: deal.standards.costPerTicketReview,
    overReviewLine: costPerTicket !== null && costPerTicket > deal.standards.costPerTicketReview,
  }
}
