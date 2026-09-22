// Fill the archive with history that predates it.
//
//   node --env-file-if-exists=.env scripts/archive-backfill.ts --client=claude-malaysia
//   ... --from=2026-09-13      (defaults to the client's salesSince)
//   ... --dry                  (compute and print, write nothing)
//
// The cron only ever archives the day it just briefed, so the tables start
// empty and history would only accumulate from tomorrow. This replays the same
// mapping over past days — deliberately the SAME functions the cron uses
// (lib/archive-rows.ts), because a backfill that writes subtly different rows
// from the live path is worse than no backfill.
//
// Safe to re-run: every write is an upsert on the same natural key the cron
// uses, so a second pass corrects rather than duplicates.
//
// It does NOT write brief_daily or adyntel_runs: there was no brief and no
// competitor search on those days, and inventing rows for them would put
// fiction in the one place meant to be the record of what actually happened.
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS, isConfigured } from '../lib/ad-clients.ts'
import { ghlPerformance, formSubmissionRows, saleRows, dayBounds, ghlConfigured } from '../lib/ghl.ts'
import { funnelDailyRows, ghlLeadRows, ghlSaleRows, registryRow } from '../lib/archive-rows.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const DRY = process.argv.includes('--dry')
const ID = arg('client') ?? 'claude-malaysia'

const client = AD_CLIENTS.find((c) => c.id === ID)
if (!client) {
  console.error(`unknown client "${ID}" — known: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}
if (!client.ghl) {
  console.error(`${client.name} has no GoHighLevel config, so there is nothing to back-fill.`)
  process.exit(1)
}
if (!ghlConfigured(client)) {
  console.error(`${client.ghl.locationEnv} / ${client.ghl.tokenEnv} are not set in this environment.`)
  process.exit(1)
}

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)

const write = async (table: string, rows: Record<string, unknown>[], onConflict: string) => {
  if (DRY || !rows.length) return rows.length
  const { error } = await db.from(table).upsert(rows, { onConflict })
  if (error) throw new Error(`${table}: ${error.message}`)
  return rows.length
}

const from = arg('from') ?? client.ghl.salesSince
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
const days: string[] = []
for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= yesterday; d.setUTCDate(d.getUTCDate() + 1))
  days.push(d.toISOString().slice(0, 10))

console.log(`${client.name}: back-filling ${days.length} day(s), ${days[0]} → ${days.at(-1)}${DRY ? '  [DRY RUN]' : ''}`)

// Spend for the whole range in one read, then sliced per day in memory.
const { data: adRows, error: adErr } = await db
  .from('ad_daily')
  .select('date, campaign_name, spend')
  .eq('project', client.id)
  .gte('date', from)
if (adErr) throw new Error(`ad_daily: ${adErr.message}`)
const spendByCampaign = (campaign: string, f: string, t: string) =>
  (adRows ?? [])
    .filter((r) => r.date >= f && r.date <= t && (campaign === '*' || r.campaign_name === campaign))
    .reduce((s, r) => s + Number(r.spend), 0)

const tz = client.ghl.timeZone ?? 'Asia/Kuala_Lumpur'
const token = process.env[client.ghl.tokenEnv]!.trim()
const loc = process.env[client.ghl.locationEnv]!.trim()

let funnelCount = 0
let leadCount = 0
for (const day of days) {
  const perf = await ghlPerformance(client, day, spendByCampaign)
  if (!perf) continue
  funnelCount += await write('funnel_daily', funnelDailyRows(client, day, perf), 'project,date,funnel')

  const { start, end } = dayBounds(day, tz)
  const leads = []
  for (const f of client.ghl.funnels) leads.push(...(await formSubmissionRows(loc, token, f.formId, start, end)))
  leadCount += await write('ghl_leads', ghlLeadRows(client.id, leads), 'project,submission_id')

  const line = perf.funnels
    .map((f) => `${f.label.split(' ')[0]} ${f.leads ?? '?'} lead(s) / RM${f.spend.toFixed(2)}`)
    .join(' · ')
  console.log(`  ${day}  ${line}  · ${leads.length} submission(s)`)
}

// Sales once for the whole range — they are dated events, not daily aggregates.
const sales = await saleRows(
  loc,
  token,
  dayBounds(from, tz).start,
  dayBounds(yesterday, tz).end,
  client.ghl.excludeOrderSources ?? [],
)
const saleCount = await write('ghl_sales', ghlSaleRows(client.id, sales), 'project,transaction_id')
const seats = sales.filter((s) => !s.isUpsell).reduce((n, s) => n + s.seats, 0)

const regCount = await write('project_registry', AD_CLIENTS.map((c) => registryRow(c, isConfigured(c), ghlConfigured(c))), 'project')

console.log(
  `\n${DRY ? 'would write' : 'wrote'}: ${funnelCount} funnel row(s) · ${leadCount} lead(s) · ` +
    `${saleCount} sale(s) (${seats} seats, upsells flagged) · ${regCount} project(s)`,
)
