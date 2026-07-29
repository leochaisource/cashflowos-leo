import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import type { Project } from './ad-clients'

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

// ---------------------------------------------------------------- null-safe maths
/** a ÷ b, or null unless both are real numbers and b > 0. The guard behind every derived tile. */
export const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && b > 0 ? a / b : null

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
  link_clicks: number
  leads: number
  cpl: number | null // null = spent but produced no lead (shown as "no leads")
  ctr: number | null // link clicks ÷ impressions
}

export type Scorecard = {
  project: string
  since: string
  until: string
  days: number
  /** false = this account has no spend in the window at all (pre-launch or paused). */
  hasDelivery: boolean
  // ── ads (Meta)
  activeAds: number | null
  adsWithSpend: number
  spend: number
  spendYesterday: number | null
  leads: number // leads Meta attributed, always a real number
  avgCPL: number | null
  dailySpend: { date: string; spend: number; leads: number }[]
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
      'project, date, ad_id, ad_name, campaign_name, effective_status, spend, impressions, clicks, link_clicks, leads, currency, synced_at',
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
  adRows: AdRow[],
  funnelRows: FunnelRow[],
  days: number,
): Scorecard {
  const since = dayISO(days)
  const until = dayISO(0)

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
        link_clicks: 0,
        leads: 0,
        cpl: null,
        ctr: null,
      } satisfies AdPerf)
    cur.spend += Number(r.spend) || 0
    cur.impressions += Number(r.impressions) || 0
    cur.link_clicks += Number(r.link_clicks) || 0
    cur.leads += Number(r.leads) || 0
    byAd.set(r.ad_id, cur)
  }
  const ads = Array.from(byAd.values()).map((a) => ({
    ...a,
    cpl: ratio(a.spend, a.leads),
    ctr: ratio(a.link_clicks, a.impressions),
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

  const avgCPL = ratio(spend, leads)

  // Winners: cheapest CPL, but only among ads that have proven anything.
  const winners = ads
    .filter((a) => a.leads >= WINNER_MIN_LEADS && a.cpl !== null)
    .sort((a, b) => (a.cpl as number) - (b.cpl as number))
    .slice(0, 3)

  // Losers by cost: an ad that spent real money. No leads at all sorts worst —
  // that's the point, and cpl === null is exactly that case.
  const losersByCPL = ads
    .filter((a) => a.spend >= LOSER_MIN_SPEND)
    .sort((a, b) => (b.cpl ?? Infinity) - (a.cpl ?? Infinity))
    .slice(0, 3)

  // Losers by attention: nobody is clicking through. Needs enough impressions
  // for the rate to mean anything.
  const losersByCTR = ads
    .filter((a) => a.impressions >= LOSER_MIN_IMPRESSIONS && a.ctr !== null)
    .sort((a, b) => (a.ctr as number) - (b.ctr as number))
    .slice(0, 3)

  const syncedAt =
    adRows.map((r) => r.synced_at).filter(Boolean).sort().slice(-1)[0] ?? null

  // ── funnel — every one of these may be null, and null must survive the maths
  const optIns = sumOrNull(funnelRows, 'leads')
  const attended = sumOrNull(funnelRows, 'attended')
  const appointments = sumOrNull(funnelRows, 'appointments')
  const signups = sumOrNull(funnelRows, 'signups')
  const cashCollected = sumOrNull(funnelRows, 'cash_collected')

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
  }
}

/** Load + compute for a set of projects in two queries total. */
export async function scorecards(
  projects: Project[],
  days = 14,
): Promise<Map<string, Scorecard>> {
  const since = dayISO(days)
  const ids = projects.map((p) => p.id)
  const [adRows, funnelRows] = await Promise.all([loadAdRows(ids, since), loadFunnelRows(ids, since)])
  const out = new Map<string, Scorecard>()
  for (const p of projects) {
    const a = (adRows as (AdRow & { project: string })[]).filter((r) => r.project === p.id)
    const f = (funnelRows as (FunnelRow & { project: string })[]).filter((r) => r.project === p.id)
    out.set(p.id, scorecard(p, a, f, days))
  }
  return out
}

/** One project. Same maths, one project's rows. */
export async function projectScorecard(project: Project, days = 14): Promise<Scorecard> {
  return (await scorecards([project], days)).get(project.id) as Scorecard
}
