// 👉 THIS FILE IS YOURS TO READ — the Head of Marketing's knobs.
//
// The blueprint's Marketing head "watches the funnel top and the content rows".
// On THIS business the content rows are Meta ad performance records (leads, reach,
// views, clicks in `meta`), so the head's real job is CREATIVE EFFICIENCY TRIAGE:
// grade every ad against YOUR OWN account average and hand back a short kill/scale
// list. It never touches the ad account — it recommends, you decide.
//
// Why not the gallery's Content Approval head? That one watches `status='draft'`
// and waits to be asked before publishing. Every content row here is already
// `posted` — it would match zero rows forever. Same department, different job.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE. `Rec` is a TYPE-only import (erased at
// runtime), which is what lets scripts/marketing-dry-run.ts run this exact code
// under plain `node` without the Next.js `@/` alias. Add a value import here and
// the dry run breaks.

import type { Rec } from '@/lib/records'

export type WhenTrigger = 'on_photo' | 'on_new_record' | 'daily'

// ============================================================
// THE DIALS — the line between "not my problem" and "tell the boss".
// All three are env-tunable, same pattern as the Expense Filer's threshold().
// ============================================================

// Ads below this many clicks are too small to judge — one lucky lead off 3 clicks
// is not a 33% conversion rate, it's noise. Raise it as your volume grows.
export function minClicks(): number {
  const n = Number(process.env.MARKETING_MIN_CLICKS)
  return Number.isFinite(n) && n > 0 ? n : 20
}

// Flag an ad when its click→lead rate falls below this FRACTION of your account
// average. 0.5 = "less than half as good as my average" — a deliberately loud
// signal. Lower it to 0.3 to hear only about the truly terrible ones.
export function cvrFloor(): number {
  const n = Number(process.env.MARKETING_CVR_FLOOR)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5
}

// Never put more than this many kill-recommendations in front of you per run.
// The point is a decision you'll actually make, not a 26-row spreadsheet.
export function maxProposals(): number {
  const n = Number(process.env.MARKETING_MAX_PROPOSALS)
  return Number.isFinite(n) && n > 0 ? n : 3
}

// A "scale this" call moves budget, so it needs a fatter sample than a kill call.
// 5× the kill threshold: a 20% conversion rate off 34 clicks is not a winner yet.
export function scaleMinClicks(): number {
  return minClicks() * 5
}

// ============================================================
// THE SHAPES
// ============================================================

export type AdStat = {
  id: number
  title: string
  date: string | null
  leads: number
  reach: number
  views: number
  clicks: number
  ctr: number // clicks / views — did it earn attention?
  cvr: number // leads / clicks — did that attention mean anything?
}

export type Baseline = {
  ads: number
  leads: number
  clicks: number
  views: number
  reach: number
  ctr: number
  cvr: number
}

// 'dud'      — spent real clicks, produced nothing.
// 'mismatch' — earned MORE attention than average but converted far less. The
//              expensive one: the creative works, the promise doesn't match.
// 'scale'    — the opposite, and the only positive recommendation.
export type Issue = 'dud' | 'mismatch' | 'scale'

export type Finding = {
  stat: AdStat
  issue: Issue
  wastedClicks: number // clicks that would have become leads at your average rate
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ============================================================
// LOOK-AT — which rows this head reads.
// Ad rows only (meta.format === 'ad'), and only ones big enough to judge.
// ============================================================
export function adStats(rows: Rec[]): AdStat[] {
  return rows
    .filter(
      (r) =>
        r.category === 'content' &&
        String(r.meta?.format || '').toLowerCase() === 'ad' &&
        num(r.meta?.clicks) >= minClicks(),
    )
    .map((r) => {
      const leads = num(r.meta?.leads)
      const reach = num(r.meta?.reach)
      const views = num(r.meta?.views)
      const clicks = num(r.meta?.clicks)
      return {
        id: r.id,
        title: r.title,
        date: r.due_date,
        leads,
        reach,
        views,
        clicks,
        ctr: views > 0 ? clicks / views : 0,
        cvr: clicks > 0 ? leads / clicks : 0,
      }
    })
}

// Your own account average — the head grades against YOU, never an industry
// benchmark it made up. Pooled (total leads / total clicks), not an average of
// per-ad rates, so a tiny ad can't drag the baseline around.
export function baseline(stats: AdStat[]): Baseline | null {
  if (stats.length === 0) return null
  const t = stats.reduce(
    (a, s) => ({
      leads: a.leads + s.leads,
      clicks: a.clicks + s.clicks,
      views: a.views + s.views,
      reach: a.reach + s.reach,
    }),
    { leads: 0, clicks: 0, views: 0, reach: 0 },
  )
  return {
    ads: stats.length,
    ...t,
    ctr: t.views > 0 ? t.clicks / t.views : 0,
    cvr: t.clicks > 0 ? t.leads / t.clicks : 0,
  }
}

// ============================================================
// THE RECOMMENDATION LIST — ranked, capped, one positive.
// ============================================================
export function findings(stats: AdStat[], base: Baseline): Finding[] {
  const floor = base.cvr * cvrFloor()

  const problems: Finding[] = stats
    .map((stat): Finding | null => {
      // Clicks that SHOULD have become leads if this ad performed like your average.
      const wastedClicks =
        base.cvr > 0 ? Math.max(0, Math.round(stat.clicks * (1 - stat.cvr / base.cvr))) : 0

      if (stat.leads === 0) return { stat, issue: 'dud', wastedClicks }
      // Above-average attention, below-floor intent. The inverted signal.
      if (stat.ctr >= base.ctr && stat.cvr < floor) return { stat, issue: 'mismatch', wastedClicks }
      return null
    })
    .filter((f): f is Finding => f !== null)
    .sort((a, b) => b.wastedClicks - a.wastedClicks)
    .slice(0, maxProposals())

  // One winner: of the ads that are MORE efficient than your average, the one that
  // has already proven it at the greatest scale.
  //
  // Ranking by CVR alone crowns a rounding error — on real data it picked a
  // 20-month-old ad with 13 leads off 103 clicks over one with 100 leads off
  // 1,148, and the second is the one actually worth more budget. So: filter on
  // efficiency (must beat baseline), then rank on proven volume.
  const winner = stats
    .filter((s) => s.clicks >= scaleMinClicks() && s.cvr > base.cvr)
    .sort((a, b) => b.leads - a.leads)[0]

  return winner ? [...problems, { stat: winner, issue: 'scale', wastedClicks: 0 }] : problems
}

// ============================================================
// The definition the rest of the app reads (same shape as agents/expense).
// ============================================================
export const definition = {
  key: 'marketing-triage',
  when: 'daily' as WhenTrigger,

  // LOOK-AT — ad rows with enough clicks to judge.
  lookAt: (rows: Rec[]) => adStats(rows),

  // ASK-BEFORE — ALWAYS 🟡. Killing or scaling a creative moves ad budget, so it
  // is never 🟢 autopilot no matter how confident the numbers look. There is no
  // threshold that turns this false — that's deliberate.
  askBefore: () => true,
}
