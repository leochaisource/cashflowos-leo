import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { normaliseAd, type NormalisedAd } from './adyntel'
import type { Camp } from './meta'
import type { Project } from './ad-clients'

// Where a DEMO project's numbers come from.
//
// A real client's brief calls Meta and Adyntel. A demo project reads the same
// three tables those calls would have filled — so from `runClient`'s point of
// view nothing else changes: same rollups, same competitor section, same prompt,
// same Telegram message. One branch at the source instead of a demo mode
// threaded through the whole pipeline.

const dayISO = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return d.toISOString().slice(0, 10)
}

/** Campaign-level rollup out of `ad_daily` — the shape Meta's insights would return. */
export async function demoCampaigns(project: Project, days: number): Promise<Camp[]> {
  if (!supabaseConfigured) return []
  const { data, error } = await supabase
    .from('ad_daily')
    .select('campaign_name, spend, impressions, reach, clicks, link_clicks, leads')
    .eq('project', project.id)
    .gte('date', dayISO(days))
  if (error || !data?.length) return []
  const blank = (name: string): Camp => ({
    name, spend: 0, impressions: 0, leads: 0, cpl: 0, reach: 0, frequency: null,
    clicks: 0, linkClicks: 0, cpm: null, ctr: null, linkCtr: null, cpc: null,
  })
  const by = new Map<string, Camp>()
  for (const r of data) {
    const name = r.campaign_name || 'Unnamed'
    const c = by.get(name) ?? blank(name)
    c.spend += Number(r.spend) || 0
    c.impressions += Number(r.impressions) || 0
    c.reach += Number(r.reach) || 0
    c.clicks += Number(r.clicks) || 0
    c.linkClicks += Number(r.link_clicks) || 0
    c.leads += Number(r.leads) || 0
    by.set(name, c)
  }
  return [...by.values()].map((c) => ({
    ...c,
    cpl: c.leads > 0 ? c.spend / c.leads : 0,
    cpm: c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null,
    ctr: c.impressions > 0 ? c.clicks / c.impressions : null,
    linkCtr: c.impressions > 0 ? c.linkClicks / c.impressions : null,
    cpc: c.clicks > 0 ? c.spend / c.clicks : null,
    // Summed daily reach is not de-duplicated, so no frequency here on purpose.
    frequency: null,
  }))
}

/**
 * The competitor set, rebuilt from stored `raw_payload` instead of a fresh
 * Adyntel search. This is the same trick scripts/ads-brief-replay.ts uses, and
 * the reason raw_payload is kept in the first place: a full brief with zero
 * credits spent.
 */
export async function demoCompetitors(project: Project): Promise<NormalisedAd[]> {
  if (!supabaseConfigured) return []
  const { data, error } = await supabase
    .from('competitor_ads')
    .select('raw_payload')
    .eq('client', project.id)
    .limit(200)
  if (error || !data?.length) return []
  return data
    .map((r) => normaliseAd(r.raw_payload as Record<string, unknown>))
    .filter((a) => a.ad_archive_id)
}

/**
 * The leads block for a project with no sheet: the same story told from
 * `project_funnel`. Returns [] when nothing is recorded, so the brief simply
 * omits the section rather than printing a row of zeroes.
 */
export async function demoLeadsBlock(project: Project, days: number, money: (n: number) => string): Promise<string[]> {
  if (!supabaseConfigured) return []
  const { data, error } = await supabase
    .from('project_funnel')
    .select('date, leads, attended, appointments, signups, cash_collected')
    .eq('project', project.id)
    .gte('date', dayISO(days))
    .order('date', { ascending: false })
  if (error || !data?.length) return []

  const sum = (k: 'leads' | 'attended' | 'appointments' | 'signups' | 'cash_collected') => {
    const v = data.map((r) => r[k]).filter((x): x is number => typeof x === 'number')
    return v.length ? v.reduce((a, b) => a + b, 0) : null
  }
  const yesterday = data.find((r) => r.date === dayISO(1))
  const optIns = sum('leads')
  const attended = sum('attended')
  const appts = sum('appointments')
  const signups = sum('signups')
  const cash = sum('cash_collected')
  const pct = (a: number | null, b: number | null) =>
    a !== null && b !== null && b > 0 ? `${Math.round((a / b) * 100)}%` : 'not tracked'

  return [
    '',
    `LEADS (${project.sources?.leads ?? 'client system'} — ${days}-day window):`,
    `- yesterday: ${yesterday?.leads ?? 0} new opt-in(s) · ${optIns ?? 'not tracked'} in the window`,
    `- attended: ${attended ?? 'not tracked'} (show-up ${pct(attended, optIns)}) · appointments booked: ${appts ?? 'not tracked'}`,
    `- sign-ups: ${signups ?? 'not tracked'} · collected: ${cash === null ? 'not tracked' : money(cash)}`,
    signups !== null && attended !== null
      ? `- attendee → sign-up: ${pct(signups, attended)}`
      : '',
  ].filter((l) => l !== '')
}
