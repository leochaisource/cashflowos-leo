import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { adInsights, adStatuses } from './meta'
import type { AdClient } from './ad-clients'

// Meta → `ad_daily`. Called by the 8am cron (so the dashboard is fresh before
// you wake up) and by the Refresh button on a project page.
//
// It re-pulls the trailing few days, not just yesterday: Meta restates
// attributed conversions after the fact, so a day's lead count keeps moving for
// a while. The unique index (project, date, ad_id) turns the re-pull into a
// correction instead of a duplicate.

/** Local date, N days back, as YYYY-MM-DD. */
const dayISO = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return d.toISOString().slice(0, 10)
}

export type SyncResult = {
  project: string
  rows: number
  days: number
  spend: number
  leads: number
  active_ads: number
  since: string
  until: string
}

export async function syncProjectAds(client: AdClient, days = 7): Promise<SyncResult> {
  const since = dayISO(days)
  const until = dayISO(0)

  // Statuses are a nice-to-have: if that call fails we still store the spend
  // rows and just don't know which ads are live. Insights failing IS fatal —
  // there'd be nothing to write.
  const [rows, statuses] = await Promise.all([
    adInsights(client, { since, until }),
    adStatuses(client).catch(() => new Map<string, string>()),
  ])

  const result: SyncResult = {
    project: client.id,
    rows: 0,
    days,
    spend: rows.reduce((s, r) => s + r.spend, 0),
    leads: rows.reduce((s, r) => s + r.leads, 0),
    active_ads: Array.from(statuses.values()).filter((s) => s === 'ACTIVE').length,
    since,
    until,
  }
  if (!supabaseConfigured || !rows.length) return result

  const now = new Date().toISOString()
  const payload = rows.map((r) => ({
    project: client.id,
    date: r.date,
    ad_id: r.ad_id,
    ad_name: r.ad_name,
    campaign_name: r.campaign_name,
    adset_name: r.adset_name,
    // The status is "as of this sync", stamped onto every day's row for the ad —
    // it describes the ad now, not what it was doing on that date.
    effective_status: statuses.get(r.ad_id) ?? null,
    spend: r.spend,
    impressions: r.impressions,
    reach: r.reach,
    clicks: r.clicks,
    link_clicks: r.link_clicks,
    leads: r.leads,
    currency: r.currency,
    synced_at: now,
  }))

  const { data, error } = await supabase
    .from('ad_daily')
    .upsert(payload, { onConflict: 'project,date,ad_id' })
    .select('id')
  if (error) throw new Error(`ad_daily upsert failed: ${error.message}`)
  result.rows = data?.length ?? 0
  return result
}
