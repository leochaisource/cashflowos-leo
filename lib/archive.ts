import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { isConfigured, type AdClient } from './ad-clients'
import { ghlConfigured, type GhlPerformance, type LeadRow, type SaleRow } from './ghl'
import {
  funnelDailyRows,
  briefDailyRow,
  ghlLeadRows,
  ghlSaleRows,
  registryRow,
  adyntelRunRow,
  ADYNTEL_RUN_OPTIONAL,
  type AdyntelRunInput,
} from './archive-rows'

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

/**
 * Upsert, and if a column from a LATER migration is missing, write the row
 * without it and say which file to run.
 *
 * Without this, adding a column to a table the cron already writes turns every
 * deploy-before-migration into a lost row — the generic guard would blame the
 * wrong SQL file and drop the whole morning's accounting over one new field.
 */
async function upsertWithFallback(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  optional: readonly string[],
  migration: string,
): Promise<string | null> {
  if (!rows.length) return null
  const first = await supabase.from(table).upsert(rows, { onConflict })
  if (!first.error) return null
  const missing = optional.filter((c) => first.error!.message.includes(c))
  if (!missing.length) throw new Error(first.error.message)
  const trimmed = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !optional.includes(k))))
  const retry = await supabase.from(table).upsert(trimmed, { onConflict })
  if (retry.error) throw new Error(retry.error.message)
  return `Archive: ${table} stored without ${optional.join(', ')} — run ${migration} once in the SQL editor.`
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
  adyntel: AdyntelRunInput | null
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
  if (perf?.funnels.length)
    add(
      await guard('funnel metrics', () =>
        upsert('funnel_daily', funnelDailyRows(client, date, perf), 'project,date,funnel'),
      ),
    )

  // ── the brief itself, verbatim — for EVERY briefed client.
  // This used to be written only when a GoHighLevel performance block existed,
  // which meant a competitor-only brief (Starcity, Mr Money) left no record at
  // all. The row is the record of the morning: report_text may be null when the
  // model was unavailable, and delivered/failed still matter then.
  add(
    await guard('the brief', () =>
      upsert('brief_daily', [briefDailyRow(client, date, perf, input)], 'project,date'),
    ),
  )

  // ── what the competitor research cost, found, and concluded
  if (input.adyntel) {
    const a = input.adyntel
    let note: string | null = null
    add(
      await guard('the Adyntel run', async () => {
        note = await upsertWithFallback(
          'adyntel_runs',
          [adyntelRunRow(client, date, a)],
          'project,date',
          ADYNTEL_RUN_OPTIONAL,
          'supabase/competitor-archive.sql',
        )
      }),
    )
    add(note)
  }

  // ── every individual opt-in
  if (input.leads.length)
    add(
      await guard('leads', () =>
        upsert('ghl_leads', ghlLeadRows(client.id, input.leads), 'project,submission_id'),
      ),
    )

  // ── every individual sale, upsells included but flagged
  if (input.sales.length)
    add(
      await guard('sales', () =>
        upsert('ghl_sales', ghlSaleRows(client.id, input.sales), 'project,transaction_id'),
      ),
    )

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
      clients.map((c) => registryRow(c, isConfigured(c), ghlConfigured(c))),
      'project',
    ),
  )
}
