import 'server-only'
import type { AdClient } from './ad-clients'

// The ONE Meta Marketing API client. Both the 8am brief (app/api/cron-ads) and
// the dashboard sync (lib/ad-sync.ts) come through here, so "what counts as a
// lead" and "how we talk to Graph" are defined once.
//
// Every function throws on failure rather than returning empty. Callers decide
// what a failure means: the brief reports "Meta unavailable" and still sends the
// competitor half; the sync reports it to the caller. Silently returning [] would
// look exactly like "this account spent nothing", which is a different fact.

const GRAPH = 'https://graph.facebook.com/v23.0'

/** Both credentials, or null if this project isn't configured yet. */
function creds(client: AdClient): { token: string; acct: string } | null {
  const token = process.env[client.tokenEnv]?.trim()
  const acct = process.env[client.adAccountEnv]?.trim()
  return token && acct ? { token, acct } : null
}

/**
 * Meta reports conversions in an `actions` array, and which action_type carries
 * the lead depends on how the funnel is built — a native instant form reports
 * `lead`, a landing-page form firing the Pixel reports
 * `offsite_conversion.fb_pixel_lead`. Each client declares its own list; we take
 * the max rather than the sum because Meta often reports the same conversion
 * under several overlapping types and adding them double-counts.
 */
export function leadsOf(
  actions: { action_type: string; value: string }[] | undefined,
  types: string[],
): number {
  if (!Array.isArray(actions)) return 0
  const hits = actions.filter((a) => types.includes(a.action_type)).map((a) => Number(a.value) || 0)
  return hits.length ? Math.max(...hits) : 0
}

/** One `inline_link_clicks`-style field: Meta returns some of these as [{value}]. */
const actionValue = (v: unknown): number => {
  if (Array.isArray(v)) return Number((v[0] as { value?: string })?.value) || 0
  return Number(v) || 0
}

// ---------------------------------------------------------------- paging
// Graph pages at `limit` and hands back a cursor. An account with 200+ ads over
// a 30-day window is several pages; stopping at page one would silently under-
// report spend. Hard cap the loop so a pathological cursor can't spin forever.
async function getAll(url: string, token: string, maxPages = 10): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let next: string | null = url
  for (let page = 0; next && page < maxPages; page++) {
    const res: Response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Meta ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as {
      data?: Record<string, unknown>[]
      paging?: { next?: string }
    }
    out.push(...(json.data ?? []))
    next = json.paging?.next ?? null
  }
  return out
}

// ---------------------------------------------------------------- campaigns
export type Camp = {
  name: string
  spend: number
  impressions: number
  leads: number
  cpl: number
  // Delivery quality. Meta computes cpm/ctr/cpc itself, so we take its numbers
  // rather than re-deriving them and disagreeing with Ads Manager by a rounding.
  reach: number
  frequency: number | null
  clicks: number
  linkClicks: number
  cpm: number | null
  ctr: number | null // Meta's ctr = ALL clicks ÷ impressions
  linkCtr: number | null
  cpc: number | null
}

/** Campaign-level totals for a preset window. This is what the 8am brief reports. */
export async function campaignInsights(client: AdClient, datePreset: string): Promise<Camp[]> {
  const c = creds(client)
  if (!c) return []
  const url =
    `${GRAPH}/act_${c.acct}/insights?level=campaign&date_preset=${datePreset}` +
    '&fields=campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,' +
    'cpm,ctr,cpc,actions&limit=200'
  const rows = await getAll(url, c.token)
  return rows.map((d) => {
    const spend = Number(d.spend) || 0
    const impressions = Number(d.impressions) || 0
    const linkClicks = actionValue(d.inline_link_clicks)
    const leads = leadsOf(d.actions as { action_type: string; value: string }[], client.leadActionTypes)
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null)
    return {
      name: String(d.campaign_name ?? 'Unnamed'),
      spend,
      impressions,
      leads,
      cpl: leads > 0 ? spend / leads : 0,
      reach: Number(d.reach) || 0,
      frequency: num(d.frequency),
      clicks: Number(d.clicks) || 0,
      linkClicks,
      // Fall back to deriving only when Meta omits the field (it does on rows
      // with zero delivery).
      cpm: num(d.cpm) ?? (impressions > 0 ? (spend / impressions) * 1000 : null),
      ctr: num(d.ctr) !== null ? (num(d.ctr) as number) / 100 : impressions > 0 ? (Number(d.clicks) || 0) / impressions : null,
      linkCtr: impressions > 0 ? linkClicks / impressions : null,
      cpc: num(d.cpc) ?? (Number(d.clicks) > 0 ? spend / Number(d.clicks) : null),
    }
  })
}

// ---------------------------------------------------------------- ads, per day
export type AdDay = {
  date: string // YYYY-MM-DD
  ad_id: string
  ad_name: string
  campaign_name: string
  adset_name: string
  spend: number
  impressions: number
  reach: number
  clicks: number
  link_clicks: number
  leads: number
  currency: string | null
}

/**
 * Ad-level insights, ONE ROW PER AD PER DAY (`time_increment=1`).
 *
 * Per-day rather than one total for the window, because the daily grain is what
 * makes "daily ad spend" a real line and lets any window be re-cut later by
 * summing. You can always add days up; you can never split a total back apart.
 */
export async function adInsights(
  client: AdClient,
  range: { since: string; until: string },
): Promise<AdDay[]> {
  const c = creds(client)
  if (!c) return []
  const url =
    `${GRAPH}/act_${c.acct}/insights?level=ad&time_increment=1` +
    `&time_range=${encodeURIComponent(JSON.stringify(range))}` +
    '&fields=ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,clicks,' +
    'inline_link_clicks,actions,account_currency,date_start&limit=300'
  const rows = await getAll(url, c.token)
  return rows
    .filter((d) => d.ad_id)
    .map((d) => ({
      date: String(d.date_start),
      ad_id: String(d.ad_id),
      ad_name: String(d.ad_name ?? 'Unnamed ad'),
      campaign_name: String(d.campaign_name ?? ''),
      adset_name: String(d.adset_name ?? ''),
      spend: Number(d.spend) || 0,
      impressions: Number(d.impressions) || 0,
      reach: Number(d.reach) || 0,
      clicks: Number(d.clicks) || 0,
      link_clicks: actionValue(d.inline_link_clicks),
      leads: leadsOf(d.actions as { action_type: string; value: string }[], client.leadActionTypes),
      currency: (d.account_currency as string) ?? null,
    }))
}

/**
 * Account-level insights straight from Meta for one window — the only correct
 * source of REACH and FREQUENCY over multiple days, because reach is
 * de-duplicated people and daily reach cannot be added up.
 */
export type AccountInsights = {
  spend: number
  impressions: number
  reach: number
  frequency: number | null
  clicks: number
  linkClicks: number
  uniqueLinkClicks: number
  cpm: number | null
  ctr: number | null
  linkCtr: number | null
  cpc: number | null
  costPerLinkClick: number | null
  leads: number
  cpl: number | null
  actions: { action_type: string; value: number }[]
  window: string
}

export async function accountInsights(client: AdClient, datePreset = 'last_7d'): Promise<AccountInsights | null> {
  const c = creds(client)
  if (!c) return null
  const url =
    `${GRAPH}/act_${c.acct}/insights?level=account&date_preset=${datePreset}` +
    '&fields=spend,impressions,reach,frequency,clicks,inline_link_clicks,unique_inline_link_clicks,' +
    'cpm,ctr,cpc,cost_per_inline_link_click,actions&limit=50'
  const rows = await getAll(url, c.token, 2)
  const d = rows[0]
  if (!d) return null
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const spend = Number(d.spend) || 0
  const impressions = Number(d.impressions) || 0
  const linkClicks = actionValue(d.inline_link_clicks)
  const leads = leadsOf(d.actions as { action_type: string; value: string }[], client.leadActionTypes)
  return {
    spend,
    impressions,
    reach: Number(d.reach) || 0,
    frequency: num(d.frequency),
    clicks: Number(d.clicks) || 0,
    linkClicks,
    uniqueLinkClicks: actionValue(d.unique_inline_link_clicks),
    cpm: num(d.cpm),
    ctr: num(d.ctr) !== null ? (num(d.ctr) as number) / 100 : null,
    linkCtr: impressions > 0 ? linkClicks / impressions : null,
    cpc: num(d.cpc),
    costPerLinkClick: num(d.cost_per_inline_link_click),
    leads,
    cpl: leads > 0 ? spend / leads : null,
    // The whole action list, so "how many landing page views?" can be answered
    // without another deploy.
    actions: Array.isArray(d.actions)
      ? (d.actions as { action_type: string; value: string }[]).map((a) => ({
          action_type: a.action_type,
          value: Number(a.value) || 0,
        }))
      : [],
    window: datePreset,
  }
}

// ---------------------------------------------------------------- ad statuses
/**
 * Insights don't carry delivery status — an ad paused this morning still has
 * yesterday's spend row. So "number of active ads" has to come from the ad
 * objects themselves, or the count is really "ads that spent recently", which
 * is a different (and always stale) number.
 */
export async function adStatuses(client: AdClient): Promise<Map<string, string>> {
  const c = creds(client)
  if (!c) return new Map()
  const url = `${GRAPH}/act_${c.acct}/ads?fields=id,name,effective_status&limit=300`
  const rows = await getAll(url, c.token)
  return new Map(rows.map((d) => [String(d.id), String(d.effective_status ?? 'UNKNOWN')]))
}
