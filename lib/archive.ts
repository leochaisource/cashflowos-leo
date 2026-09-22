import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { isConfigured, type AdClient } from './ad-clients'
import { ghlConfigured, type GhlPerformance, type LeadRow, type SaleRow } from './ghl'

// THE ARCHIVE — write side. Schema and reasoning live in supabase/archive.sql.
//
// Everything the 8am run works out used to vanish the moment the Telegram
// message was sent. This module writes it down instead: the figures, the exact
// message, what the competitor search cost, every opt-in and every sale.
//
// TWO RULES HOLD THROUGHOUT.
//
// 1. ARCHIVING MUST NEVER COST THE BRIEF. Every write is wrapped; a failure
//    returns a note and the morning message still goes out. Storage is the
//    junior partner to delivery — a missing row is an inconvenience, a missing
//    brief is the product not working.
//
// 2. EVERY WRITE IS AN UPSERT ON A NATURAL KEY. Re-running a day corrects it
//    rather than duplicating it, which is what lets the cron re-pull the
//    trailing week while Meta restates its attributed conversions, and what
//    makes a manual replay safe.

/** Run one write, turning any failure into a note instead of an exception. */
async function guard(label: string, fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    const msg = (e as Error).message
    // A missing table is the single most likely failure and has a specific
    // remedy, so say it rather than leaking a PostgREST error code.
    if (/does not exist|schema cache|relation/i.test(msg))
      return `Archive: ${label} not stored — run supabase/archive.sql once in the SQL editor.`
    return `Archive: ${label} not stored (${msg}).`
  }
}

const upsert = async (table: string, rows: Record<string, unknown>[], onConflict: string) => {
  if (!rows.length) return
  const { error } = await supabase.from(table).upsert(rows, { onConflict })
  if (error) throw new Error(error.message)
}

export type ArchiveInput = {
  client: AdClient
  /** The day the figures cover — NOT the send date. */
  date: string
  perf: GhlPerformance | null
  performanceText: string
  reportText: string
  recipients: string[]
  delivered: string[]
  failed: { chat: string; error: string }[]
  notes: string[]
  leads: LeadRow[]
  sales: SaleRow[]
  adyntel: {
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
  } | null
}

/**
 * Write one morning's work to Supabase. Returns notes for anything that failed;
 * never throws.
 */
export async function archiveRun(input: ArchiveInput): Promise<string[]> {
  if (!supabaseConfigured) return ['Archive: Supabase is not configured, so nothing was stored.']
  const { client, date, perf } = input
  const problems: string[] = []
  const add = (n: string | null) => {
    if (n) problems.push(n)
  }

  // ── per funnel, per day
  if (perf?.funnels.length) {
    const byLabel = new Map(client.ghl?.funnels.map((f) => [f.label, f]) ?? [])
    add(
      await guard('funnel metrics', () =>
        upsert(
          'funnel_daily',
          perf.funnels.map((f) => ({
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
          })),
          'project,date,funnel',
        ),
      ),
    )
  }

  // ── the brief itself, verbatim
  if (perf || input.performanceText) {
    add(
      await guard('the brief', () =>
        upsert(
          'brief_daily',
          [
            {
              project: client.id,
              date,
              sent_at: new Date().toISOString(),
              performance_text: input.performanceText || null,
              report_text: input.reportText || null,
              purchases_today: perf?.purchasesToday ?? null,
              purchases_total: perf?.purchasesTotal ?? null,
              sales_since: perf?.salesSince ?? null,
              spend_total: perf?.spendTotal ?? null,
              spend_since: perf?.spendSince ?? null,
              cost_per_sale: perf?.costPerSale ?? null,
              recipients: input.recipients,
              delivered: input.delivered,
              failed: input.failed,
              notes: input.notes,
              payload: perf,
              updated_at: new Date().toISOString(),
            },
          ],
          'project,date',
        ),
      ),
    )
  }

  // ── what the competitor research cost and found
  if (input.adyntel) {
    const a = input.adyntel
    add(
      await guard('the Adyntel run', () =>
        upsert(
          'adyntel_runs',
          [
            {
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
            },
          ],
          'project,date',
        ),
      ),
    )
  }

  // ── every individual opt-in
  if (input.leads.length) {
    add(
      await guard('leads', () =>
        upsert(
          'ghl_leads',
          input.leads.map((l) => ({
            project: client.id,
            submission_id: l.submissionId,
            contact_id: l.contactId,
            form_id: l.formId,
            form_name: l.formName,
            name: l.name,
            email: l.email,
            phone: l.phone,
            submitted_at: l.submittedAt,
            payload: l.payload,
          })),
          'project,submission_id',
        ),
      ),
    )
  }

  // ── every individual sale, upsells included but flagged
  if (input.sales.length) {
    add(
      await guard('sales', () =>
        upsert(
          'ghl_sales',
          input.sales.map((s) => ({
            project: client.id,
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
          })),
          'project,transaction_id',
        ),
      ),
    )
  }

  return problems
}

/**
 * Mirror the registry into Supabase so the projects can be queried next to the
 * data that describes them.
 *
 * Deliberately a SNAPSHOT: lib/ad-clients.ts stays the source of truth and
 * nothing reads this back, so the two cannot drift into disagreeing about which
 * is right. Env var NAMES are stored, never their values.
 */
export async function archiveRegistry(clients: AdClient[]): Promise<string | null> {
  if (!supabaseConfigured) return null
  return guard('the project registry', () =>
    upsert(
      'project_registry',
      clients.map((c) => ({
        project: c.id,
        name: c.name,
        client: c.client ?? null,
        stage: c.stage ?? null,
        rank: c.rank ?? null,
        currency: c.currency,
        countries: c.countries,
        target_cpl: c.targetCPL ?? null,
        meta_ready: isConfigured(c),
        ghl_ready: ghlConfigured(c),
        config: {
          keywords: c.keywords,
          keywordsPerRun: c.keywordsPerRun,
          watchPages: c.watchPages ?? [],
          leadActionTypes: c.leadActionTypes ?? [],
          adAccountEnv: c.adAccountEnv,
          tokenEnv: c.tokenEnv,
          ghl: c.ghl ? { ...c.ghl, tokenEnv: c.ghl.tokenEnv, locationEnv: c.ghl.locationEnv } : null,
          briefContext: c.briefContext ?? null,
        },
        synced_at: new Date().toISOString(),
      })),
      'project',
    ),
  )
}
