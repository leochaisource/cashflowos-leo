import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import type { Project } from './ad-clients'
import { leadsSummary, type LeadsSummary } from './leads-sheet'
import { ratio, delivery, perDay, type Delivery } from './delivery'

// Every number the dashboard shows is computed here, and every one of them can
// be `null`.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: null ≠ 0.
//   null = nobody has told us yet   → the tile shows "—" and names its source
//   0    = we know, and it's zero   → the tile shows 0
// A funnel with no sign-ups entered must not print "ROAS 0.0" — that reads as a
// failed campaign when the truth is an empty spreadsheet cell. So every derived
// metric goes through ratio(), which returns null unless both inputs are real.

// ---------------------------------------------------------------- thresholds
// Ranking ads on CPL alone is how you crown an ad that got one lucky RM4 lead
// from RM4 of spend. These floors are the difference between a "winner" and a
// rounding error. Tune them as volume grows.
export const WINNER_MIN_LEADS = 3 // an ad needs this many leads to be called a winner
export const LOSER_MIN_IMPRESSIONS = 1000 // below this, CTR is noise
export const LOSER_MIN_SPEND = 20 // don't shame an ad that has barely spent
/**
 * A losing ad must be losing RELATIVE TO THE ACCOUNT, not merely last in a list.
 * With three ads running, "bottom 3 by CPL" includes the best ad in the account —
 * which is how a dashboard ends up showing the same creative as both the winner
 * and a loser, and how you get talked into pausing something that works.
 */
export const LOSER_CPL_MULTIPLE = 1.25 // 25% worse than the blended CPL
export const LOSER_CTR_FRACTION = 0.75 // clicking through at 3/4 of the account rate

// ---------------------------------------------------------------- null-safe maths
// ratio(), Delivery and delivery() live in lib/delivery.ts — free of the
// `server-only` guard, so the offline replay script can compute the same numbers
// the dashboard does. Re-exported here because everything already imports them
// from this module.
export { ratio, delivery, perDay, type Delivery, type DeliveryRow } from './delivery'

/**
 * Sum a column that is allowed to be NULL. Returns null when NO row has a value
 * (nobody entered anything), and the sum of what exists otherwise — so one day
 * of missing data doesn't blank out the week.
 */
const sumOrNull = (rows: FunnelRow[], key: keyof FunnelRow): number | null => {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')
  return vals.length ? vals.reduce((s, v) => s + v, 0) : null
}

// ---------------------------------------------------------------- row types
export type AdRow = {
  date: string
  ad_id: string
  ad_name: string | null
  campaign_name: string | null
  effective_status: string | null
  spend: number
  impressions: number
  reach: number
  clicks: number
  link_clicks: number
  leads: number
  currency: string | null
  synced_at: string | null
}

export type FunnelRow = {
  date: string
  leads: number | null
  attended: number | null
  appointments: number | null
  signups: number | null
  cash_collected: number | null
}

/** One ad, totalled across the window. */
export type AdPerf = {
  ad_id: string
  ad_name: string
  campaign_name: string
  status: string | null
  spend: number
  impressions: number
  clicks: number
  link_clicks: number
  leads: number
  cpl: number | null // null = spent but produced no lead (shown as "no leads")
  ctr: number | null // link clicks ÷ impressions
  allCtr: number | null // every click ÷ impressions
  cpm: number | null
  cpc: number | null
}

export type Scorecard = {
  project: string
  since: string
  until: string
  days: number
  /** false = this account has no spend in the window at all (pre-launch or paused). */
  hasDelivery: boolean
  /**
   * The last day this account spent anything, looking back further than the
   * window. A client who ran a campaign last month and stopped is a completely
   * different situation from one who has never advertised — and with only the
   * window to go on, both look identically empty.
   */
  lastSpendDate: string | null
  /** Spend and leads over the whole lookback, for that "you did run, but not lately" line. */
  spendLookback: number
  leadsLookback: number
  lookbackDays: number
  // ── ads (Meta)
  activeAds: number | null
  adsWithSpend: number
  spend: number
  spendYesterday: number | null
  leads: number // leads Meta attributed, always a real number
  avgCPL: number | null
  dailySpend: { date: string; spend: number; leads: number }[]
  /** The whole window as one delivery block: CPM, CTR, CPC and the rest. */
  delivery: Delivery
  /**
   * Today SO FAR — everything Meta had recorded as of the last sync.
   *
   * Its RATES (CPM, CTR, CPC, CPL) are comparable with any other day; its
   * TOTALS are not, because the day isn't over. Anything displaying this has to
   * say so, or a 10am glance reads as "spend collapsed".
   */
  today: Delivery
  /** Yesterday on its own. */
  yesterday: Delivery
  /** The three days before today, and the same figures expressed per day. */
  last3: Delivery
  last3PerDay: Delivery
  /** Per-day rows with reach and frequency, which are only exact per day. */
  daily: (Delivery & { date: string; reach: number; frequency: number | null })[]
  winners: AdPerf[]
  losersByCPL: AdPerf[]
  losersByCTR: AdPerf[]
  syncedAt: string | null
  // ── funnel (entered / to be connected)
  optIns: number | null
  attended: number | null
  appointments: number | null
  signups: number | null
  cashCollected: number | null
  showUpRate: number | null
  convRate: number | null
  // ── money (derived)
  coursePrice: number | null
  revenue: number | null
  revenueBasis: 'cash collected' | 'sign-ups × course price' | null
  cpa: number | null
  roas: number | null
  /** Live read of the client's master leads sheet, when one is configured. */
  sheet: LeadsSummary | null
}

// ---------------------------------------------------------------- loading
const dayISO = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return d.toISOString().slice(0, 10)
}

/** Every ad row for these projects since `since`. One query for the whole home page. */
export async function loadAdRows(projectIds: string[], since: string): Promise<AdRow[]> {
  if (!supabaseConfigured || !projectIds.length) return []
  const { data, error } = await supabase
    .from('ad_daily')
    .select(
      'project, date, ad_id, ad_name, campaign_name, effective_status, spend, impressions, reach, clicks, link_clicks, leads, currency, synced_at',
    )
    .in('project', projectIds)
    .gte('date', since)
  if (error) {
    console.warn('[CFO] ad_daily read failed:', error.message)
    return []
  }
  return (data ?? []) as (AdRow & { project: string })[]
}

/** Every funnel row for these projects since `since`. */
export async function loadFunnelRows(projectIds: string[], since: string): Promise<FunnelRow[]> {
  if (!supabaseConfigured || !projectIds.length) return []
  const { data, error } = await supabase
    .from('project_funnel')
    .select('project, date, leads, attended, appointments, signups, cash_collected')
    .in('project', projectIds)
    .gte('date', since)
  if (error) {
    console.warn('[CFO] project_funnel read failed:', error.message)
    return []
  }
  return (data ?? []) as (FunnelRow & { project: string })[]
}

// ---------------------------------------------------------------- the scorecard
/**
 * Turn raw rows into every number on a project page. Pure — hand it rows and it
 * always gives the same answer, which is what makes the maths testable.
 */
export function scorecard(
  project: Project,
  /** Rows for the WHOLE lookback (see LOOKBACK_DAYS), not just the window. */
  allRows: AdRow[],
  funnelRows: FunnelRow[],
  days: number,
  lookbackDays = LOOKBACK_DAYS,
  sheet: LeadsSummary | null = null,
): Scorecard {
  const since = dayISO(days)
  const until = dayISO(0)

  // The window drives every metric. The rest of the lookback answers exactly one
  // question — "did this account EVER run?" — which is the difference between a
  // paused client and a pre-launch one.
  const adRows = allRows.filter((r) => r.date >= since)
  const spentDays = allRows.filter((r) => (Number(r.spend) || 0) > 0).map((r) => r.date)
  const lastSpendDate = spentDays.length ? spentDays.sort().slice(-1)[0] : null
  const spendLookback = allRows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
  const leadsLookback = allRows.reduce((s, r) => s + (Number(r.leads) || 0), 0)

  // ── ads, totalled per ad across the window
  const byAd = new Map<string, AdPerf>()
  for (const r of adRows) {
    const cur =
      byAd.get(r.ad_id) ??
      ({
        ad_id: r.ad_id,
        ad_name: r.ad_name ?? 'Unnamed ad',
        campaign_name: r.campaign_name ?? '',
        status: r.effective_status,
        spend: 0,
        impressions: 0,
        clicks: 0,
        link_clicks: 0,
        leads: 0,
        cpl: null,
        ctr: null,
        allCtr: null,
        cpm: null,
        cpc: null,
      } satisfies AdPerf)
    cur.spend += Number(r.spend) || 0
    cur.impressions += Number(r.impressions) || 0
    cur.clicks += Number(r.clicks) || 0
    cur.link_clicks += Number(r.link_clicks) || 0
    cur.leads += Number(r.leads) || 0
    byAd.set(r.ad_id, cur)
  }
  const ads = Array.from(byAd.values()).map((a) => ({
    ...a,
    cpl: ratio(a.spend, a.leads),
    ctr: ratio(a.link_clicks, a.impressions),
    allCtr: ratio(a.clicks, a.impressions),
    cpm: a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null,
    cpc: ratio(a.spend, a.clicks),
  }))

  const spend = ads.reduce((s, a) => s + a.spend, 0)
  const leads = ads.reduce((s, a) => s + a.leads, 0)

  // Status is stamped at sync time, so this is "live right now", not "spent recently".
  const statuses = new Set(adRows.map((r) => `${r.ad_id}:${r.effective_status ?? ''}`))
  const activeAds = adRows.length
    ? new Set(
        Array.from(statuses)
          .filter((s) => s.endsWith(':ACTIVE'))
          .map((s) => s.split(':')[0]),
      ).size
    : null

  // Daily spend line — every day in the window, including the zero days, so a
  // gap in delivery is visible as a gap instead of silently closing up.
  const perDay = new Map<string, { spend: number; leads: number }>()
  for (let i = days; i >= 0; i--) perDay.set(dayISO(i), { spend: 0, leads: 0 })
  for (const r of adRows) {
    const d = perDay.get(r.date)
    if (d) {
      d.spend += Number(r.spend) || 0
      d.leads += Number(r.leads) || 0
    }
  }
  const dailySpend = Array.from(perDay.entries()).map(([date, v]) => ({ date, ...v }))
  const yRow = perDay.get(dayISO(1))
  const spendYesterday = yRow ? yRow.spend : null

  // ── delivery metrics: the whole window, yesterday, and the trailing 3 days.
  const inRange = (from: string, to: string) => adRows.filter((r) => r.date >= from && r.date <= to)
  const todayRows = inRange(dayISO(0), dayISO(0))
  const yesterdayRows = inRange(dayISO(1), dayISO(1))
  // "Past 3 days" means the three COMPLETE days behind us — today is still being
  // written and would drag every average down as the morning goes on.
  const last3Rows = inRange(dayISO(3), dayISO(1))
  const last3 = delivery(last3Rows)
  const daysWithSpend = new Set(last3Rows.filter((r) => Number(r.spend) > 0).map((r) => r.date)).size || 1
  const perDayOf = (d: Delivery, n: number): Delivery => ({
    ...d,
    spend: d.spend / n,
    impressions: d.impressions / n,
    clicks: d.clicks / n,
    linkClicks: d.linkClicks / n,
    leads: d.leads / n,
    // The rates are already per-impression — dividing them by days would be wrong.
  })

  // Per-day rows keep reach and frequency, which only mean anything on one day.
  const byDate = new Map<string, AdRow[]>()
  for (const r of adRows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const daily = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, rows]) => {
      const reach = rows.reduce((s, r) => s + (Number(r.reach) || 0), 0)
      const d = delivery(rows)
      return { date, ...d, reach, frequency: ratio(d.impressions, reach) }
    })

  const avgCPL = ratio(spend, leads)

  // Winners: cheapest CPL, but only among ads that have proven anything.
  const winners = ads
    .filter((a) => a.leads >= WINNER_MIN_LEADS && a.cpl !== null)
    .sort((a, b) => (a.cpl as number) - (b.cpl as number))
    .slice(0, 3)

  // Losers by cost: spent real money AND is doing measurably worse than the
  // account as a whole — either no leads at all, or a CPL a quarter worse than
  // blended. A winner can never appear here, which is the whole point.
  const winnerIds = new Set(winners.map((w) => w.ad_id))
  const losersByCPL = ads
    .filter(
      (a) =>
        !winnerIds.has(a.ad_id) &&
        a.spend >= LOSER_MIN_SPEND &&
        (a.leads === 0 || (avgCPL !== null && (a.cpl as number) > avgCPL * LOSER_CPL_MULTIPLE)),
    )
    .sort((a, b) => (b.cpl ?? Infinity) - (a.cpl ?? Infinity))
    .slice(0, 3)

  // Losers by attention: nobody is clicking through, judged against how this
  // account actually performs rather than a number from a blog post.
  const accountCtr = ratio(
    ads.reduce((s, a) => s + a.link_clicks, 0),
    ads.reduce((s, a) => s + a.impressions, 0),
  )
  const losersByCTR = ads
    .filter(
      (a) =>
        a.impressions >= LOSER_MIN_IMPRESSIONS &&
        a.ctr !== null &&
        (accountCtr === null || a.ctr < accountCtr * LOSER_CTR_FRACTION),
    )
    .sort((a, b) => (a.ctr as number) - (b.ctr as number))
    .slice(0, 3)

  const syncedAt =
    adRows.map((r) => r.synced_at).filter(Boolean).sort().slice(-1)[0] ?? null

  // ── funnel — every one of these may be null, and null must survive the maths.
  //
  // The master sheet is the source of truth for anything it actually records:
  // it is what the client types into all day, so it cannot be stale relative to
  // a table we maintain. Where the sheet has no column for something — today it
  // has no "Attended" — it returns null and the stored rows answer instead. A
  // sheet that is unreachable falls back the same way, rather than zeroing the
  // funnel because Google had a bad minute.
  const pick = (fromSheet: number | null | undefined, stored: number | null) =>
    fromSheet ?? stored

  const optIns = pick(sheet?.ok ? sheet.total : null, sumOrNull(funnelRows, 'leads'))
  const attended = pick(sheet?.attended, sumOrNull(funnelRows, 'attended'))
  const appointments = pick(sheet?.appointments, sumOrNull(funnelRows, 'appointments'))
  const signups = pick(sheet?.ok ? sheet.signups : null, sumOrNull(funnelRows, 'signups'))
  const cashCollected = pick(sheet?.ok ? sheet.revenue : null, sumOrNull(funnelRows, 'cash_collected'))

  // Show-up = of the people who opted in, how many turned up. Falls back to
  // Meta's lead count only when no opt-in figure has been entered, and the page
  // says which basis was used.
  const registered = optIns ?? (leads > 0 ? leads : null)
  const showUpRate = ratio(attended, registered)
  const convRate = ratio(signups, attended)

  const coursePrice = typeof project.coursePrice === 'number' ? project.coursePrice : null
  // Cash actually banked beats a modelled figure. Only fall back to
  // sign-ups × price when no cash has been recorded, and label it as modelled.
  const revenue =
    cashCollected !== null
      ? cashCollected
      : signups !== null && coursePrice !== null
        ? signups * coursePrice
        : null
  const revenueBasis =
    cashCollected !== null ? 'cash collected' : revenue !== null ? 'sign-ups × course price' : null

  return {
    project: project.id,
    since,
    until,
    days,
    hasDelivery: spend > 0,
    lastSpendDate,
    spendLookback,
    leadsLookback,
    lookbackDays,
    activeAds,
    adsWithSpend: ads.filter((a) => a.spend > 0).length,
    spend,
    spendYesterday,
    leads,
    avgCPL,
    dailySpend,
    winners,
    losersByCPL,
    losersByCTR,
    syncedAt,
    delivery: delivery(adRows),
    today: delivery(todayRows),
    yesterday: delivery(yesterdayRows),
    last3,
    last3PerDay: perDayOf(last3, daysWithSpend),
    daily,
    optIns,
    attended,
    appointments,
    signups,
    cashCollected,
    showUpRate,
    convRate,
    coursePrice,
    revenue,
    revenueBasis,
    cpa: ratio(spend, signups),
    roas: ratio(revenue, spend),
    sheet,
  }
}

/**
 * How far back we READ, versus the window we REPORT on. Reading wider costs one
 * query either way (a month of one account is tens of rows) and buys the
 * difference between "paused" and "never started".
 */
export const LOOKBACK_DAYS = 90

/** Load + compute for a set of projects in two queries total. */
export async function scorecards(
  projects: Project[],
  days = 14,
): Promise<Map<string, Scorecard>> {
  const ids = projects.map((p) => p.id)
  const [adRows, funnelRows, sheets] = await Promise.all([
    loadAdRows(ids, dayISO(LOOKBACK_DAYS)),
    // Funnel numbers are only ever shown for the window, so read only the window.
    loadFunnelRows(ids, dayISO(days)),
    // One CSV fetch per project that has a sheet; projects without one cost nothing.
    Promise.all(projects.map((p) => leadsSummary(p).catch(() => null))),
  ])
  const out = new Map<string, Scorecard>()
  projects.forEach((p, i) => {
    const a = (adRows as (AdRow & { project: string })[]).filter((r) => r.project === p.id)
    const f = (funnelRows as (FunnelRow & { project: string })[]).filter((r) => r.project === p.id)
    out.set(p.id, scorecard(p, a, f, days, LOOKBACK_DAYS, sheets[i]))
  })
  return out
}

/** One project. Same maths, one project's rows. */
export async function projectScorecard(project: Project, days = 14): Promise<Scorecard> {
  return (await scorecards([project], days)).get(project.id) as Scorecard
}
