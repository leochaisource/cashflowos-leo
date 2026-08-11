// The delivery maths — CPM, CTR, CPC and friends.
//
// Deliberately free of `server-only` and of any import that touches Supabase, so
// the same functions run in the app, in the offline replay script, and in a test.
// lib/metrics.ts re-exports them, so nothing else had to change when they moved
// out of it.

/** a ÷ b, or null unless both are real numbers and b > 0. The guard behind every derived metric. */
export const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && b > 0 ? a / b : null

/**
 * The standard Meta delivery metrics, derived from what ad_daily already
 * stores. They were never missing from the data — only from the code.
 *
 * WHAT IS DELIBERATELY ABSENT: reach and frequency over a multi-day window.
 * Reach is de-duplicated people, so daily reach does not add up — summing a
 * week of it and dividing gives a frequency that is simply wrong. Per DAY both
 * are exact and are reported; for a window, ask Meta directly.
 */
export type Delivery = {
  spend: number
  impressions: number
  clicks: number
  linkClicks: number
  leads: number
  cpm: number | null // cost per 1,000 impressions
  ctr: number | null // all clicks ÷ impressions
  linkCtr: number | null // link clicks ÷ impressions — the one that means intent
  cpc: number | null // cost per click (all)
  costPerLinkClick: number | null
  cpl: number | null
  /** Of the people who clicked through, how many became a lead. */
  leadRate: number | null
}

export type DeliveryRow = {
  spend: number
  impressions: number
  clicks: number
  link_clicks: number
  leads: number
}

/** Roll any set of ad-days into one delivery block. */
export function delivery(rows: DeliveryRow[]): Delivery {
  const spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
  const impressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0)
  const clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0)
  const linkClicks = rows.reduce((s, r) => s + (Number(r.link_clicks) || 0), 0)
  const leads = rows.reduce((s, r) => s + (Number(r.leads) || 0), 0)
  return {
    spend,
    impressions,
    clicks,
    linkClicks,
    leads,
    // CPM is per THOUSAND impressions — the ×1000 is the whole definition.
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    ctr: ratio(clicks, impressions),
    linkCtr: ratio(linkClicks, impressions),
    cpc: ratio(spend, clicks),
    costPerLinkClick: ratio(spend, linkClicks),
    cpl: ratio(spend, leads),
    leadRate: ratio(leads, linkClicks),
  }
}

/** Divide the volume figures by N days; the rates are already per-impression. */
export const perDay = (d: Delivery, n: number): Delivery => ({
  ...d,
  spend: d.spend / n,
  impressions: d.impressions / n,
  clicks: d.clicks / n,
  linkClicks: d.linkClicks / n,
  leads: d.leads / n,
})
