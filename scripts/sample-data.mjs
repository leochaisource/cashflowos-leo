// DEMO SAMPLE DATA — seed and purge.
//
//   node --env-file-if-exists=.env scripts/sample-data.mjs --seed
//   node --env-file-if-exists=.env scripts/sample-data.mjs --purge
//   node --env-file-if-exists=.env scripts/sample-data.mjs --status
//
// WHY THIS EXISTS: the dashboard is honest to a fault — a metric with no source
// shows a dash, not a zero. That is right in daily use and useless on a stage,
// where a funnel of dashes tells the audience nothing. This fills the gaps so
// the whole river can be shown end to end.
//
// HOW IT STAYS HONEST:
//   • Every row is stamped `meta.sample = true` (records) or `source = 'sample'`
//     (project_funnel). Nothing renders those fields, so the dashboard and the
//     brief look exactly like production — but one command removes every trace.
//   • It NEVER touches real data. No updates, no deletes outside its own rows.
//   • It does not invent money that competes with the truth: the real leads
//     sheet still owns opt-ins, payments and revenue for the workshop. The
//     sample fills only what nothing is recording yet (attendance, 1-1s) plus
//     agency-level receivables and expenses.
import { createClient } from '@supabase/supabase-js'

const MODE = process.argv.includes('--purge') ? 'purge' : process.argv.includes('--status') ? 'status' : 'seed'
const BATCH = 'demo-2026-08-08'
const PROJECT = 'claude-malaysia'

const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

// ---------------------------------------------------------------- dates
const d = (offset) => {
  const x = new Date()
  x.setDate(x.getDate() + offset)
  return x.toISOString().slice(0, 10)
}
const WEBINAR = '2026-08-08' // the 8 Aug cohort in the master sheet

// ---------------------------------------------------------------- the data
const mark = (extra = {}) => ({ sample: true, sample_batch: BATCH, ...extra })

// MONEY IN — what clients owe, and by when. The Cash In tab and the agency
// "Who Owes Me" tile read these; overdue ones drive the red flags.
const cashIn = [
  ['Claude Malaysia — August ads retainer', 'waiting', 4500, d(5), { customer: 'Claude Malaysia', terms: 'Net 14' }],
  ['Workshop seats — corporate group (10 pax)', 'waiting', 3970, d(2), { customer: 'Sunway Group', terms: 'Net 7' }],
  ['Dianna Toh — July retainer', 'overdue', 3800, d(-12), { customer: 'Dianna Toh', terms: 'Net 14' }],
  ['HRD Corp claim — August cohort', 'waiting', 2400, d(21), { customer: 'HRD Corp', terms: 'claim submitted' }],
  ['Funnel audit — one-off project', 'overdue', 2200, d(-5), { customer: 'Vertex Digital', terms: 'Net 7' }],
  ['Speaking fee — SME Summit KL', 'paid', 1500, d(-20), { customer: 'SME Summit' }],
  ['Workshop tickets — 8 Aug cohort payout', 'paid', 794, d(-2), { customer: 'Stripe payout' }],
]

// MONEY OUT — receipts filed against the workshop project.
const cashOut = [
  ['Venue deposit — Connexion Bangsar ballroom', 'paid', 1800, d(-9), { merchant: 'Connexion Conference Centre', category: 'Venue', project: PROJECT }],
  ['Catering — 60 pax, full day', 'filed', 1440, d(-3), { merchant: 'Dapur Rasa Catering', category: 'F&B', project: PROJECT }],
  ['Video editor — 3 ad creatives', 'paid', 900, d(-11), { merchant: 'Faiz Editorial', category: 'Creative', project: PROJECT }],
  ['Designer — slide deck + event banners', 'paid', 650, d(-8), { merchant: 'Studio Sepuluh', category: 'Creative', project: PROJECT }],
  ['Photographer — event day', 'filed', 600, d(-1), { merchant: 'Lim Photography', category: 'Creative', project: PROJECT }],
  ['Printing — workbooks and name tags', 'filed', 480, d(-2), { merchant: 'Speedy Print PJ', category: 'Printing', project: PROJECT }],
  ['Zoom Webinar plan — August', 'filed', 320, d(-6), { merchant: 'Zoom', category: 'Software', project: PROJECT }],
]

// CUSTOMERS — who has bought, what they still owe, when they were last touched.
const customers = [
  ['Sunway Group', 'open', 3970, { owes: 3970, last_touch: d(-2), next: 'Send the PO and seat list' }],
  ['Vertex Digital', 'open', 2200, { owes: 2200, last_touch: d(-9), next: 'Chase the overdue audit invoice' }],
  ['Dianna Toh', 'open', 3800, { owes: 3800, last_touch: d(-4), next: 'Confirm August scope before invoicing' }],
  ['Rachel Ong', 'won', 0, { owes: 0, last_touch: d(-3), next: 'Onboard for the 8 Aug workshop' }],
  ['YJ Consulting', 'won', 0, { owes: 0, last_touch: d(-2), next: 'Send pre-work pack' }],
  ['HRD Corp', 'open', 2400, { owes: 2400, last_touch: d(-6), next: 'Follow up on the claim status' }],
  ['SME Summit', 'won', 0, { owes: 0, last_touch: d(-20), next: 'Ask about the November slot' }],
  ['Kestrel Advisory', 'open', 0, { owes: 0, last_touch: d(-14), next: 'Re-pitch the workshop for their team' }],
]

// LEADS — a handful across the stages so the river has a shape after the
// opt-in stage. Real client leads already fill the top of the funnel.
const leads = [
  ['Nadia Rahman — Kestrel Advisory', 'appointment', 3970, { source: 'Workshop — 8 Aug', next: 'Discovery call Thursday 3pm', potential: 3970 }],
  ['Wei Sheng — Tanaka Foods', 'appointment', 1985, { source: 'Workshop — 8 Aug', next: 'Send corporate seat pricing', potential: 1985 }],
  ['Priya M — Lotus Clinic Group', 'appointment', 1191, { source: 'Workshop — 8 Aug', next: 'Confirm 3 seats for 22 Aug', potential: 1191 }],
  ['Hafiz Zulkifli — Zul Logistics', 'appointment', 794, { source: 'Workshop — 8 Aug', next: 'Waiting on HRD Corp approval', potential: 794 }],
  ['Rachel Ong', 'closed', 397, { source: 'Image Ads 1', next: 'Paid — onboard', potential: 397 }],
  ['YJ', 'closed', 397, { source: 'Video Testi Ads 1', next: 'Paid — onboard', potential: 397 }],
  ['Amirah Yusof — Bloom Studio', 'closed', 397, { source: 'Image Ads 1', next: 'Paid — send receipt', potential: 397 }],
  ['Daniel Teoh — Northside Dental', 'closed', 794, { source: 'Image Ads 1', next: 'Paid for 2 seats', potential: 794 }],
  ['Suriani Abdullah — Cempaka Trading', 'nurture', 397, { source: 'Workshop — 8 Aug', next: 'Wants the 22 Aug cohort instead', potential: 397 }],
  ['Kelvin Loh — Loh & Sons', 'nurture', 397, { source: 'Video Ads 2 - Angel Testi', next: 'Budget approval in September', potential: 397 }],
  ['Farah Idris — Idris Legal', 'contacted', 397, { source: 'Image Ads 1', next: 'WhatsApp sent, awaiting reply', potential: 397 }],
  ['Ben Chua — Chua Interiors', 'contacted', 397, { source: 'Instagram_Stories', next: 'Call back Monday', potential: 397 }],
]

// TASKS — what the week actually looks like.
const tasks = [
  ['Call the 15 coldest workshop leads before the 8 Aug session', 'open', d(0), { owner: 'Leo' }],
  ['Chase Vertex Digital — invoice 5 days overdue', 'open', d(0), { owner: 'Leo' }],
  ['Submit HRD Corp claim forms for the August cohort', 'open', d(2), { owner: 'Admin' }],
  ['Refresh Image Ads 1 creative before it fatigues', 'open', d(3), { owner: 'Leo' }],
  ['Book photographer and catering for the 22 Aug cohort', 'open', d(6), { owner: 'Admin' }],
  ['Send the 8 Aug replay link to everyone who did not attend', 'open', d(1), { owner: 'Admin' }],
]

// THE FUNNEL MIDDLE — the only two numbers nothing is recording yet.
// The master sheet still owns opt-ins, payments and revenue; these fill the gap
// between "opted in" and "paid" so the river is continuous.
const funnel = [
  // date, leads, attended, appointments, signups, cash — nulls stay null.
  [WEBINAR, null, 41, 9, null, null],
  [d(-1), null, null, 4, null, null],
  [d(-2), null, null, 4, null, null],
]

// ---------------------------------------------------------------- run
const SAMPLE_FILTER = ['meta->>sample', 'eq', 'true']

async function status() {
  const { count: recs } = await db.from('records').select('id', { count: 'exact', head: true }).filter(...SAMPLE_FILTER)
  const { count: pf } = await db.from('project_funnel').select('id', { count: 'exact', head: true }).eq('source', 'sample')
  console.log(`sample rows present: ${recs ?? 0} in records · ${pf ?? 0} in project_funnel`)
  return { recs: recs ?? 0, pf: pf ?? 0 }
}

async function purge() {
  const before = await status()
  const { error: e1 } = await db.from('records').delete().filter(...SAMPLE_FILTER)
  if (e1) { console.error('records purge failed:', e1.message); process.exitCode = 1 }
  const { error: e2 } = await db.from('project_funnel').delete().eq('source', 'sample')
  if (e2) { console.error('project_funnel purge failed:', e2.message); process.exitCode = 1 }
  const after = await status()
  console.log(`purged ${before.recs - after.recs} record(s) and ${before.pf - after.pf} funnel row(s). Real data untouched.`)
}

async function seed() {
  // Idempotent: clear our own previous batch first so re-running never doubles.
  await purge()

  const rows = [
    ...cashIn.map(([title, status, amount, due, meta]) => ({ title, status, amount, category: 'cash_in', due_date: due, meta: mark(meta) })),
    ...cashOut.map(([title, status, amount, due, meta]) => ({ title, status, amount, category: 'cash_out', due_date: due, meta: mark(meta) })),
    ...customers.map(([title, status, amount, meta]) => ({ title, status, amount, category: 'customer', due_date: null, meta: mark(meta) })),
    ...leads.map(([title, status, amount, meta]) => ({ title, status, amount, category: 'lead', due_date: null, meta: mark(meta) })),
    ...tasks.map(([title, status, due, meta]) => ({ title, status, amount: 0, category: 'task', due_date: due, meta: mark(meta) })),
  ]
  const { data, error } = await db.from('records').insert(rows).select('id')
  if (error) { console.error('records insert failed:', error.message); process.exit(1) }
  console.log(`inserted ${data.length} sample records`)

  const funnelRows = funnel.map(([date, leads, attended, appointments, signups, cash]) => ({
    project: PROJECT, date, leads, attended, appointments, signups, cash_collected: cash, source: 'sample',
  }))
  const { error: e2 } = await db.from('project_funnel').upsert(funnelRows, { onConflict: 'project,date' })
  if (e2) { console.error('project_funnel insert failed:', e2.message); process.exit(1) }
  console.log(`inserted ${funnelRows.length} sample funnel rows for ${PROJECT}`)

  const owed = cashIn.filter(([, s]) => s !== 'paid').reduce((n, [, , a]) => n + a, 0)
  console.log(`\nready — RM ${owed.toLocaleString()} outstanding across ${cashIn.filter(([, s]) => s !== 'paid').length} invoices,`)
  console.log(`        RM ${cashOut.reduce((n, [, , a]) => n + a, 0).toLocaleString()} of project expenses, ${tasks.length} tasks, ${leads.length} leads.`)
  console.log('remove it all with:  node --env-file-if-exists=.env scripts/sample-data.mjs --purge')
}

if (MODE === 'status') await status()
else if (MODE === 'purge') await purge()
else await seed()
