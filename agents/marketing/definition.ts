// 👉 THIS FILE IS YOURS TO READ — the Head of Marketing's knobs.
//
// The blueprint's Marketing head "watches content and the funnel top". On this
// business that means the Meta ad accounts, so its job is CREATIVE EFFICIENCY
// TRIAGE: grade every ad against YOUR OWN cost per lead and hand back a short
// kill/scale list. It never touches the ad account — it recommends, you decide.
//
// IT RANKS ON WASTED MONEY, NOT ON A RATIO. This is the whole design. An ad at
// 3× your average CPL that spent RM30 has cost you RM20; an ad at 1.2× that spent
// RM2,185 has cost you RM404. Ratio-ranking shouts about the first and never
// mentions the second, which is backwards. `wastedSpend` is the ranking key:
// what these leads cost you ABOVE what they should have.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE. Everything here is pure arithmetic over
// plain objects, with type-only imports. That is what lets scripts/marketing-dry-run.ts
// run this EXACT code under plain node — so the dry run can never drift from what
// the cron actually does. Add a value import (especially anything `server-only`,
// like lib/metrics.ts or lib/supabase.ts) and the dry run breaks.

export type WhenTrigger = 'on_photo' | 'on_new_record' | 'daily'

// ============================================================
// THE DIALS
// ============================================================

// How far back to look. Ads older than this stop being decisions you can act on.
export function windowDays(): number {
  const n = Number(process.env.MARKETING_WINDOW_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 90
}

// Don't shame an ad that has barely spent — below this it's a test, not a leak.
// (Mirrors LOSER_MIN_SPEND in lib/metrics.ts; keep the two in step.)
export function minSpend(): number {
  const n = Number(process.env.MARKETING_MIN_SPEND)
  return Number.isFinite(n) && n > 0 ? n : 20
}

// Only speak up once an ad has cost you at least this much MORE than your average
// would have. The unit is money, which is the point — it's the size of the leak,
// not how bad the rate looks.
export function minWaste(): number {
  const n = Number(process.env.MARKETING_MIN_WASTE)
  return Number.isFinite(n) && n > 0 ? n : 50
}

// A winner needs this many leads before it's a winner and not a lucky week.
// (Mirrors WINNER_MIN_LEADS in lib/metrics.ts.)
export function minLeadsToWin(): number {
  const n = Number(process.env.MARKETING_MIN_LEADS_WINNER)
  return Number.isFinite(n) && n > 0 ? n : 3
}

// Never put more than this many problems in front of you per run. The point is a
// decision you'll actually make, not a spreadsheet.
export function maxProposals(): number {
  const n = Number(process.env.MARKETING_MAX_PROPOSALS)
  return Number.isFinite(n) && n > 0 ? n : 3
}

// ============================================================
// THE SHAPES
// ============================================================

// One row as it comes out of `ad_daily` (loose on purpose — lib/metrics.ts's
// AdRow and a raw PostgREST row both satisfy it).
export type AdDayLike = {
  ad_id: string
  ad_name?: string | null
  campaign_name?: string | null
  effective_status?: string | null
  project?: string | null
  spend?: number | string | null
  impressions?: number | string | null
  link_clicks?: number | string | null
  leads?: number | string | null
}

// One ad, totalled across the window.
export type AdAgg = {
  adId: string
  name: string
  campaign: string
  status: string | null
  project: string | null
  spend: number
  impressions: number
  linkClicks: number
  leads: number
  cpl: number | null // null = spent but produced no lead
  ctr: number | null
}

export type CplBaseline = { ads: number; spend: number; leads: number; cpl: number }

// 'dud'       — spent real money, produced no lead at all.
// 'expensive' — produced leads, but each one cost more than your average, and the
//               gap has added up to real money.
// 'scale'     — the opposite. The only positive recommendation.
export type Issue = 'dud' | 'expensive' | 'scale'

export type Finding = {
  ad: AdAgg
  issue: Issue
  wastedSpend: number // what this ad's leads cost ABOVE your baseline
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ============================================================
// LOOK-AT — roll the daily rows up into one row per ad.
// ============================================================
export function aggregate(days: AdDayLike[]): AdAgg[] {
  const by = new Map<string, AdAgg>()
  for (const d of days) {
    const cur =
      by.get(d.ad_id) ??
      ({
        adId: d.ad_id,
        name: d.ad_name || 'Unnamed ad',
        campaign: d.campaign_name || '',
        status: d.effective_status ?? null,
        project: d.project ?? null,
        spend: 0,
        impressions: 0,
        linkClicks: 0,
        leads: 0,
        cpl: null,
        ctr: null,
      } satisfies AdAgg)
    cur.spend += num(d.spend)
    cur.impressions += num(d.impressions)
    cur.linkClicks += num(d.link_clicks)
    cur.leads += num(d.leads)
    // Status is stamped at sync time, so the latest row wins — "how it is now".
    if (d.effective_status) cur.status = d.effective_status
    by.set(d.ad_id, cur)
  }
  return Array.from(by.values()).map((a) => ({
    ...a,
    cpl: a.leads > 0 ? a.spend / a.leads : null,
    ctr: a.impressions > 0 ? a.linkClicks / a.impressions : null,
  }))
}

// Your own blended cost per lead — the head grades against YOU, never an invented
// industry benchmark. Pooled (total spend ÷ total leads), so a tiny ad can't drag
// the baseline around the way an average-of-averages would.
export function baseline(ads: AdAgg[]): CplBaseline | null {
  const spend = ads.reduce((s, a) => s + a.spend, 0)
  const leads = ads.reduce((s, a) => s + a.leads, 0)
  if (leads <= 0 || spend <= 0) return null
  return { ads: ads.length, spend, leads, cpl: spend / leads }
}

// What this ad's leads cost ABOVE your baseline. Positive = a leak; negative = it
// is subsidising the rest of the account.
export function wastedSpend(a: AdAgg, base: CplBaseline): number {
  return a.spend - a.leads * base.cpl
}

// ============================================================
// THE RECOMMENDATION LIST — ranked by money, capped, one positive.
// ============================================================
export function findings(ads: AdAgg[], base: CplBaseline): Finding[] {
  const problems: Finding[] = ads
    .filter((a) => a.spend >= minSpend())
    .map((a) => ({ ad: a, issue: (a.leads === 0 ? 'dud' : 'expensive') as Issue, wastedSpend: wastedSpend(a, base) }))
    .filter((f) => f.wastedSpend >= minWaste())
    .sort((x, y) => y.wastedSpend - x.wastedSpend)
    .slice(0, maxProposals())

  // One winner: of the ads cheaper than your average, the one that has already
  // proven it at the greatest scale. Ranking on CPL alone crowns a rounding
  // error — filter on efficiency, rank on proven volume.
  const winner = ads
    .filter((a) => a.leads >= minLeadsToWin() && a.cpl !== null && a.cpl < base.cpl)
    .sort((x, y) => y.leads - x.leads)[0]

  return winner
    ? [...problems, { ad: winner, issue: 'scale', wastedSpend: wastedSpend(winner, base) }]
    : problems
}

// ============================================================
// The definition the rest of the app reads (same shape as agents/expense).
// ============================================================
export const definition = {
  key: 'marketing-triage',
  when: 'daily' as WhenTrigger,

  // LOOK-AT — `ad_daily` rows, rolled up per ad. (The loader lives in load.ts;
  // this file stays pure so the dry run can share it.)
  lookAt: aggregate,

  // ASK-BEFORE — ALWAYS 🟡. Killing or scaling a creative moves ad budget, so it
  // is never 🟢 autopilot however confident the arithmetic looks. There is no
  // threshold that turns this false — that's deliberate.
  askBefore: () => true,
}
