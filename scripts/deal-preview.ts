// Print Leo's "💰 Your share" block for the Claude Malaysia deal — from stored
// data, no Adyntel credit, nothing sent to Telegram.
//
//   node --env-file-if-exists=.env scripts/deal-preview.ts
//   ... --date=2026-09-26   as of that report day (default: yesterday, KL)
//   ... --write             also store it in deal_daily (what the 8am run does)
//   ... --seats             list every buyer with the seat source it was given
//   ... --selftest          check the formula against the contract's worked example
//
// Uses lib/deal-estimate.ts, the code the cron runs. Without an EventOps report
// for the event it falls back to reading each buyer's first touch in GHL (and
// stores those verdicts on ghl_sales, so each contact is looked up once).
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { computeShare, DEAL_CLAUDE_MALAYSIA } from '../lib/deal.ts'
import { estimateDeal, saveDealDaily } from '../lib/deal-estimate.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const flag = (k: string) => process.argv.includes(`--${k}`)

if (flag('selftest')) {
  // Schedule 2 §4 — the House's event of 22 August 2026.
  const r = computeShare(DEAL_CLAUDE_MALAYSIA, {
    adsSeats: 21,
    organicSeats: 27,
    unknownSeats: 0,
    adsRevenue: 9786,
    organicRevenue: 10319,
    unknownRevenue: 0,
    adSpend: 1653,
    sharedCosts: 3725,
    affiliateCommission: 357,
  })
  const ok = r.adsPool === 6209.73 && r.organicPool === 7557.12 && r.partner === 5237.26 && r.house === 8529.59
  console.log(`Ads Pool ${r.adsPool} (6,209.73) · Organic Pool ${r.organicPool} (7,557.12) · Partner ${r.partner} (5,237.26) · House ${r.house} (8,529.59)`)
  console.log(ok ? 'PASS — matches the agreement to the sen' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

const client = AD_CLIENTS.find((c) => c.deal)
if (!client?.deal) {
  console.error('no client has a deal configured')
  process.exit(1)
}
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const asOf =
  arg('date') ?? new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })
const g = client.ghl
const ghl =
  g && process.env[g.locationEnv] && process.env[g.tokenEnv]
    ? { locationId: process.env[g.locationEnv]!.trim(), token: process.env[g.tokenEnv]!.trim() }
    : null

const e = await estimateDeal(db, client.id, client.deal, asOf, { ghl, lookupMax: 200 })
if (!e) {
  console.log(`No event covers ${asOf} — the term is over or closed.`)
  process.exit(0)
}
console.log(`\n${client.name} · as of ${asOf} · ${e.event.label} window ${e.from} → ${e.to} · source: ${e.source}`)
console.log(`${e.text.length} chars\n`)
console.log(e.text)
if (flag('seats')) {
  console.log('\nBuyers:')
  for (const r of e.seatRows)
    console.log(`  ${r.source.padEnd(7)} ${String(r.amount).padStart(5)} ${r.isUpsell ? 'upgrade' : `x${r.seats}   `} ${r.contactName ?? '?'} — ${r.reason}`)
}
if (flag('write')) console.log('\n' + ((await saveDealDaily(db, client.id, e)) ?? 'stored in deal_daily'))
