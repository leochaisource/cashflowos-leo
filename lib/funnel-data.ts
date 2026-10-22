import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdClient } from './ad-clients.ts'
import type { RateKey } from './funnel-config.ts'
import { adKey, adLabel, type JourneyRow } from './funnel-report.ts'
import { campaignMatches, funnelCampaigns } from './ghl.ts'

// THE FUNNEL X-RAY's reads (owner, 2026-10-22): event windows, the journey
// rows, ad spend per ad and funnel, typed-in benchmarks — and, for the
// Scorecard's creative ranker, leads and customers straight from the archive
// (ghl_leads + ghl_sales), which works before the journey table exists.
// The Supabase client is passed in, so scripts run the same code.

export type EventWindow = { no: number; label: string; date: string; from: string; to: string }

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

/** Every event of the client's deal with its selling window (day after the previous event → event day). */
export function eventWindows(client: AdClient): EventWindow[] {
  const d = client.deal
  if (!d) return []
  return d.events.map((e, i) => ({ no: e.no, label: e.label, date: e.date, from: i ? addDay(d.events[i - 1].date, 1) : d.agreementDate, to: e.date }))
}

/** The window a day falls in (the next event on or after it). */
export const windowFor = (client: AdClient, dayISO: string): EventWindow | null => eventWindows(client).find((w) => w.to >= dayISO) ?? null

/** Malaysia-day bounds as UTC instants (KL has no daylight saving). */
export const klStart = (dayISO: string) => new Date(`${dayISO}T00:00:00+08:00`).toISOString()
export const klEnd = (dayISO: string) => new Date(`${dayISO}T23:59:59.999+08:00`).toISOString()
export const klToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })

/** The funnel a campaign belongs to (by the client's funnel list), else "Other campaigns". */
export function funnelOfCampaign(client: AdClient, campaign: string | null | undefined): string {
  for (const f of client.ghl?.funnels ?? []) if (funnelCampaigns(f.campaign).some((c) => campaignMatches(campaign, c))) return f.label
  return 'Other campaigns'
}

/** The funnel a GHL form belongs to. */
export function funnelOfForm(client: AdClient, formId: string | null | undefined): string {
  return client.ghl?.funnels.find((f) => f.formId === formId)?.label ?? 'Other forms'
}

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) break
  }
  return out
}

/** The journey rows of one event cohort. Throws "run supabase/funnel.sql once" if the table is missing. */
export async function loadJourney(db: SupabaseClient, project: string, eventDate: string): Promise<JourneyRow[]> {
  try {
    return await pageAll<JourneyRow>((a, b) =>
      db.from('lead_journey').select('*').eq('project', project).eq('event_date', eventDate).order('opted_in_at', { ascending: false }).range(a, b),
    )
  } catch (e) {
    if (/lead_journey|does not exist|schema cache/i.test((e as Error).message)) throw new Error('run supabase/funnel.sql once')
    throw e
  }
}

/** Ad spend in a window: total, per funnel, and per ad within its funnel (keyed by adKey). */
export async function loadSpend(db: SupabaseClient, client: AdClient, from: string, to: string) {
  const rows = await pageAll<{ ad_name: string | null; campaign_name: string | null; spend: number }>((a, b) =>
    db.from('ad_daily').select('ad_name, campaign_name, spend').eq('project', client.id).gte('date', from).lte('date', to).range(a, b),
  )
  const byAd = new Map<string, number>()
  const byFunnel = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    const s = Number(r.spend || 0)
    if (!s) continue
    const f = funnelOfCampaign(client, r.campaign_name)
    total += s
    byFunnel.set(f, (byFunnel.get(f) ?? 0) + s)
    const k = adKey(f, adLabel(r.ad_name))
    byAd.set(k, (byAd.get(k) ?? 0) + s)
  }
  return { total, byFunnel, byAd }
}

/** Benchmarks the owner typed in, for one funnel view ('all' or a funnel label). */
export async function loadManualBenchmarks(db: SupabaseClient, project: string, funnel: string): Promise<Partial<Record<RateKey, number>>> {
  const { data, error } = await db.from('funnel_benchmarks').select('rate, value').eq('project', project).eq('funnel', funnel)
  if (error) return {}
  return Object.fromEntries((data ?? []).map((r) => [r.rate, Number(r.value)]))
}

type LeadRow = { contact_id: string | null; form_id: string | null; name: string | null; submitted_at: string; payload: Record<string, unknown> | null }
type SaleRow = { contact_id: string | null; amount: number | null; seats: number | null; is_upsell: boolean; paid_at: string }

/** utm_content / utm_campaign of a GHL form submission (its own landing-page URL). */
export function submissionUtm(payload: Record<string, unknown> | null): { content: string | null; campaign: string | null } {
  const ev = ((payload?.others as Record<string, unknown> | undefined)?.eventData ?? {}) as Record<string, unknown>
  const params = (ev.url_params ?? {}) as Record<string, unknown>
  const pick = (k: string) => (params[k] as string | undefined) ?? (ev[k] as string | undefined) ?? null
  return { content: pick('utm_content'), campaign: pick('utm_campaign') ?? ((ev.campaign as string | undefined) ?? null) }
}

/**
 * One row per lead of a window — their FIRST opt-in in it — from the archive,
 * with what they paid between opting in and `untilISO`. Only the opt-in and
 * paid stages are filled; the journey table adds the rest.
 */
export async function archiveCohort(db: SupabaseClient, client: AdClient, from: string, to: string, untilISO: string): Promise<JourneyRow[]> {
  const leads = await pageAll<LeadRow>((a, b) =>
    db.from('ghl_leads').select('contact_id, form_id, name, submitted_at, payload').eq('project', client.id)
      .gte('submitted_at', klStart(from)).lte('submitted_at', klEnd(to)).order('submitted_at', { ascending: true }).range(a, b),
  )
  const sales = await pageAll<SaleRow>((a, b) =>
    db.from('ghl_sales').select('contact_id, amount, seats, is_upsell, paid_at').eq('project', client.id)
      .gte('paid_at', klStart(from)).lte('paid_at', untilISO).range(a, b),
  )
  const first = new Map<string, LeadRow>()
  for (const l of leads) if (l.contact_id && !first.has(l.contact_id)) first.set(l.contact_id, l)
  const out: JourneyRow[] = []
  for (const [id, l] of first) {
    const mine = sales.filter((s) => s.contact_id === id && s.paid_at >= l.submitted_at)
    const tickets = mine.filter((s) => !s.is_upsell).sort((a, b) => a.paid_at.localeCompare(b.paid_at))
    const utm = submissionUtm(l.payload)
    out.push({
      contact_id: id,
      name: l.name,
      funnel: funnelOfForm(client, l.form_id),
      form_id: l.form_id,
      ad_name: utm.content,
      campaign: utm.campaign,
      opted_in_at: l.submitted_at,
      webinar_at: null,
      replied_at: null,
      engaged_at: null,
      hot_at: null,
      called_at: null,
      checkout_at: tickets[0]?.paid_at ?? null,
      paid_at: tickets[0]?.paid_at ?? null,
      seats: tickets.length ? tickets.reduce((n, s) => n + (s.seats ?? 1), 0) : null,
      revenue: mine.length ? mine.reduce((n, s) => n + Number(s.amount ?? 0), 0) : null,
      attended_at: null,
    })
  }
  return out
}
