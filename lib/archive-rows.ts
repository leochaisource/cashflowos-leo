import type { AdClient } from './ad-clients'
import type { GhlPerformance, LeadRow, SaleRow } from './ghl'
import type { CompetitorStats } from './adyntel'

/** One morning's competitor research, as the cron hands it to the archive. */
export type AdyntelRunInput = {
  searches: { keyword: string; country: string }[]
  watchPage: string | null
  credits: number
  adsSeen: number
  adsStored: number
  advertisers: number
  concepts: number
  newConcepts: number
  newVariations: number
  partial: string[]
  /** The competitor facts block the model was given, verbatim. */
  factsText: string
  /** competitorSection()'s whole stats object — more than the columns above carry. */
  stats: CompetitorStats
  /** Every ad this run returned, so "what did we find on the 19th" has an answer. */
  seenIds: string[]
}

/** Columns added by supabase/competitor-archive.sql — dropped on retry if it has not been run. */
export const ADYNTEL_RUN_OPTIONAL = ['facts_text', 'stats', 'seen_ids'] as const

export const adyntelRunRow = (client: AdClient, date: string, a: AdyntelRunInput) => ({
  project: client.id,
  date,
  searches: a.searches,
  watch_page: a.watchPage,
  credits: a.credits,
  ads_seen: a.adsSeen,
  ads_stored: a.adsStored,
  advertisers: a.advertisers,
  concepts: a.concepts,
  new_concepts: a.newConcepts,
  new_variations: a.newVariations,
  partial: a.partial,
  facts_text: a.factsText || null,
  stats: a.stats,
  seen_ids: a.seenIds,
})

// The SHAPE of every archive row, as pure functions.
//
// Split out of lib/archive.ts, which carries the `server-only` guard because it
// imports the service-role Supabase client. The backfill script has to write
// exactly the same rows the cron does, and the only way to guarantee that is
// for both to call the same mapping — a second, hand-copied version in the
// script is a guarantee of drift instead.
//
// Nothing here touches the network or the database: given the same inputs these
// return the same rows, which also makes them trivial to eyeball in a test.

export const funnelDailyRows = (client: AdClient, date: string, perf: GhlPerformance) => {
  const byLabel = new Map(client.ghl?.funnels.map((f) => [f.label, f]) ?? [])
  return perf.funnels.map((f) => ({
    project: client.id,
    date,
    funnel: f.label,
    campaign: f.campaign,
    spend: f.spend,
    leads: f.leads,
    cpl: f.cpl,
    form_id: byLabel.get(f.label)?.formId ?? null,
    form_name: byLabel.get(f.label)?.formName ?? null,
    updated_at: new Date().toISOString(),
  }))
}

export const briefDailyRow = (
  client: AdClient,
  date: string,
  perf: GhlPerformance | null,
  extra: {
    performanceText: string
    reportText: string
    recipients: string[]
    delivered: string[]
    failed: { chat: string; error: string }[]
    notes: string[]
  },
) => ({
  project: client.id,
  date,
  sent_at: new Date().toISOString(),
  performance_text: extra.performanceText || null,
  report_text: extra.reportText || null,
  purchases_today: perf?.purchasesToday ?? null,
  purchases_total: perf?.purchasesTotal ?? null,
  sales_since: perf?.salesSince ?? null,
  spend_total: perf?.spendTotal ?? null,
  spend_since: perf?.spendSince ?? null,
  cost_per_sale: perf?.costPerSale ?? null,
  recipients: extra.recipients,
  delivered: extra.delivered,
  failed: extra.failed,
  notes: extra.notes,
  payload: perf,
  updated_at: new Date().toISOString(),
})

export const ghlLeadRows = (projectId: string, leads: LeadRow[]) =>
  leads.map((l) => ({
    project: projectId,
    submission_id: l.submissionId,
    contact_id: l.contactId,
    form_id: l.formId,
    form_name: l.formName,
    name: l.name,
    email: l.email,
    phone: l.phone,
    submitted_at: l.submittedAt,
    payload: l.payload,
  }))

export const ghlSaleRows = (projectId: string, sales: SaleRow[]) =>
  sales.map((s) => ({
    project: projectId,
    transaction_id: s.transactionId,
    order_id: s.orderId,
    contact_id: s.contactId,
    contact_name: s.contactName,
    contact_email: s.contactEmail,
    amount: s.amount,
    currency: s.currency,
    seats: s.seats,
    source_name: s.sourceName,
    is_upsell: s.isUpsell,
    status: s.status,
    paid_at: s.paidAt,
    payload: s.payload,
  }))

/**
 * The registry mirror. Env var NAMES are stored, never their values — the point
 * is to see which project reads which variable, not to copy secrets into a
 * table that anyone with read access can query.
 */
export const registryRow = (c: AdClient, metaReady: boolean, ghlReady: boolean) => ({
  project: c.id,
  name: c.name,
  client: c.client ?? null,
  stage: c.stage ?? null,
  rank: c.rank ?? null,
  currency: c.currency,
  countries: c.countries,
  target_cpl: c.targetCPL ?? null,
  meta_ready: metaReady,
  ghl_ready: ghlReady,
  config: {
    keywords: c.keywords,
    keywordsPerRun: c.keywordsPerRun,
    watchPages: c.watchPages ?? [],
    leadActionTypes: c.leadActionTypes ?? [],
    adAccountEnv: c.adAccountEnv,
    tokenEnv: c.tokenEnv,
    ghl: c.ghl ?? null,
    briefContext: c.briefContext ?? null,
  },
  synced_at: new Date().toISOString(),
})
