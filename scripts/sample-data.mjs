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

// ---------------------------------------------------------------- demo projects
// Two extra clients with no ad account of their own. Their numbers are written
// into the SAME tables a real client fills from Meta, so the dashboard, the
// morning brief and the Telegram bot treat them identically — no demo mode
// threaded through the app, just seeded rows.
//
// The shapes are deliberately different from each other and from the real
// client, so a portfolio view shows contrast rather than three of the same:
//   Lotus  — high volume, cheap-ish leads, comfortably under target
//   Kestrel— lower volume, expensive leads, over target (the one to worry about)
const DEMO_PROJECTS = [
  {
    project: 'lotus-clinic',
    currency: 'RM',
    campaign: 'Aesthetics — Lead Form (MY)',
    dailySpend: [118, 132, 145, 139, 151, 128, 96, 142, 155, 149, 133, 127, 141, 138, 152, 147, 129, 118, 136, 144, 158, 151, 139, 126, 133, 148, 142, 137, 145, 130],
    cplBase: 28,
    ads: [
      ['Before After — Skin Reset 30s', 'ACTIVE', 0.34, 0.82],
      ['Testimonial — Aunty Mei 45s', 'ACTIVE', 0.26, 0.71],
      ['Carousel — Package Pricing', 'ACTIVE', 0.18, 1.24],
      ['Static — Free Consult Offer', 'ACTIVE', 0.12, 1.02],
      ['Video — Doctor Explains Filler', 'PAUSED', 0.07, 1.51],
      ['Static — Slimming Trial RM99', 'PAUSED', 0.03, 2.35],
    ],
    funnel: { leads: 148, attended: null, appointments: 52, signups: 11, cash: 27500 },
  },
  {
    project: 'kestrel-advisory',
    currency: 'RM',
    campaign: 'Leadership Bootcamp — Webinar Reg',
    dailySpend: [88, 94, 102, 97, 111, 86, 74, 99, 108, 103, 91, 88, 96, 101, 107, 99, 84, 79, 93, 98, 104, 96, 89, 83, 92, 100, 95, 90, 97, 87],
    cplBase: 47,
    ads: [
      ['Webinar Reg — 5 Mistakes Managers Make', 'ACTIVE', 0.41, 0.94],
      ['Webinar Reg — HRD Corp Claimable', 'ACTIVE', 0.29, 1.11],
      ['Video — Client Story, Manufacturing SME', 'ACTIVE', 0.19, 0.68],
      ['Static — Cohort Starts 19 Aug', 'PAUSED', 0.08, 0.52],
      ['Carousel — Curriculum Breakdown', 'PAUSED', 0.03, 0.41],
    ],
    funnel: { leads: 61, attended: 38, appointments: 14, signups: 6, cash: 11280 },
  },
]

/** Deterministic jitter so re-seeding produces the same numbers, not new ones. */
const jitter = (seed, spread = 0.18) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return 1 + ((x - Math.floor(x)) * 2 - 1) * spread
}

function demoAdRows(cfg) {
  const rows = []
  const now = new Date()
  cfg.dailySpend.forEach((daySpend, i) => {
    // dailySpend is oldest-first across the last 30 days.
    const date = new Date(now)
    date.setDate(date.getDate() - (cfg.dailySpend.length - 1 - i))
    const iso = date.toISOString().slice(0, 10)
    cfg.ads.forEach(([name, status, share, cplMult], j) => {
      const spend = Math.round(daySpend * share * jitter(i * 7 + j) * 100) / 100
      if (spend <= 0) return
      const cpl = cfg.cplBase * cplMult * jitter(i * 13 + j, 0.12)
      // Leads are whole people: round, and let a thin day legitimately produce 0.
      const leads = Math.max(0, Math.round(spend / cpl))
      const impressions = Math.round(spend * 42 * jitter(i * 3 + j, 0.25))
      const linkClicks = Math.round(impressions * 0.019 * jitter(i * 5 + j, 0.3))
      rows.push({
        project: cfg.project,
        date: iso,
        ad_id: `demo-${cfg.project}-${j}`,
        ad_name: name,
        campaign_name: cfg.campaign,
        adset_name: 'Broad — MY 25-55',
        effective_status: status,
        spend,
        impressions,
        reach: Math.round(impressions * 0.78),
        clicks: Math.round(linkClicks * 1.6),
        link_clicks: linkClicks,
        leads,
        currency: cfg.currency,
        synced_at: new Date().toISOString(),
      })
    })
  })
  return rows
}

/**
 * Give each demo project a market to talk about by filing a slice of the ads
 * already stored for the real clients under the demo project's id. Same shape,
 * same raw_payload, so the brief's competitor section is genuinely rebuilt
 * rather than faked — and it costs no Adyntel credit.
 */
async function seedDemoCompetitors(projectId, sourceClient, limit) {
  const { data, error } = await db
    .from('competitor_ads')
    .select('*')
    .eq('client', sourceClient)
    .not('body_text', 'is', null)
    .limit(limit)
  if (error || !data?.length) { console.log(`  no source ads to copy from ${sourceClient}`); return 0 }
  const rows = data.map(({ id, created_at, ...rest }) => ({ ...rest, client: projectId }))
  const { data: ins, error: e2 } = await db
    .from('competitor_ads')
    .upsert(rows, { onConflict: 'client,competitor,ad_archive_id' })
    .select('id')
  if (e2) { console.error(`  competitor copy failed: ${e2.message}`); return 0 }
  return ins?.length ?? 0
}

// ---------------------------------------------------------------- run
const SAMPLE_FILTER = ['meta->>sample', 'eq', 'true']
const DEMO_IDS = DEMO_PROJECTS.map((p) => p.project)

async function status() {
  const { count: recs } = await db.from('records').select('id', { count: 'exact', head: true }).filter(...SAMPLE_FILTER)
  const { count: pf } = await db.from('project_funnel').select('id', { count: 'exact', head: true }).eq('source', 'sample')
  const { count: ads } = await db.from('ad_daily').select('id', { count: 'exact', head: true }).in('project', DEMO_IDS)
  const { count: comp } = await db.from('competitor_ads').select('id', { count: 'exact', head: true }).in('client', DEMO_IDS)
  console.log(`sample rows: ${recs ?? 0} records · ${pf ?? 0} project_funnel · ${ads ?? 0} ad_daily · ${comp ?? 0} competitor_ads`)
  return { recs: recs ?? 0, pf: pf ?? 0, ads: ads ?? 0, comp: comp ?? 0 }
}

async function purge() {
  const before = await status()
  const { error: e1 } = await db.from('records').delete().filter(...SAMPLE_FILTER)
  if (e1) { console.error('records purge failed:', e1.message); process.exitCode = 1 }
  const { error: e2 } = await db.from('project_funnel').delete().eq('source', 'sample')
  if (e2) { console.error('project_funnel purge failed:', e2.message); process.exitCode = 1 }
  // Demo projects own their id, so everything filed under it is ours to remove.
  // Real clients' ad_daily and competitor_ads are never touched by this filter.
  const { error: e3 } = await db.from('ad_daily').delete().in('project', DEMO_IDS)
  if (e3) { console.error('ad_daily purge failed:', e3.message); process.exitCode = 1 }
  const { error: e4 } = await db.from('competitor_ads').delete().in('client', DEMO_IDS)
  if (e4) { console.error('competitor_ads purge failed:', e4.message); process.exitCode = 1 }
  const after = await status()
  console.log(
    `purged ${before.recs - after.recs} record(s), ${before.pf - after.pf} funnel row(s), ` +
      `${before.ads - after.ads} ad-day(s), ${before.comp - after.comp} competitor ad(s). Real data untouched.`,
  )
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

  // ---- the two demo projects: ads, funnel, and a market to talk about ----
  for (const cfg of DEMO_PROJECTS) {
    const adRows = demoAdRows(cfg)
    const { data: ins, error: e3 } = await db
      .from('ad_daily')
      .upsert(adRows, { onConflict: 'project,date,ad_id' })
      .select('id')
    if (e3) { console.error(`${cfg.project} ad_daily failed:`, e3.message); process.exit(1) }
    const spend = adRows.reduce((n, r) => n + r.spend, 0)
    const leads = adRows.reduce((n, r) => n + r.leads, 0)

    // The funnel is written on one date inside the window; the scorecard sums
    // the window, so a single row is enough and keeps the intent readable.
    const f = cfg.funnel
    const { error: e4 } = await db.from('project_funnel').upsert(
      [{ project: cfg.project, date: d(-1), leads: f.leads, attended: f.attended, appointments: f.appointments, signups: f.signups, cash_collected: f.cash, source: 'sample' }],
      { onConflict: 'project,date' },
    )
    if (e4) { console.error(`${cfg.project} project_funnel failed:`, e4.message); process.exit(1) }

    const copied = await seedDemoCompetitors(cfg.project, cfg.project === 'lotus-clinic' ? PROJECT : 'dianna-nlp', 45)
    console.log(
      `${cfg.project}: ${ins.length} ad-days (RM ${spend.toFixed(0)}, ${leads} leads, CPL RM ${(spend / leads).toFixed(2)}), ` +
        `funnel ${f.leads} → ${f.signups} sign-ups, ${copied} competitor ads`,
    )
  }

  const owed = cashIn.filter(([, s]) => s !== 'paid').reduce((n, [, , a]) => n + a, 0)
  console.log(`\nready — RM ${owed.toLocaleString()} outstanding across ${cashIn.filter(([, s]) => s !== 'paid').length} invoices,`)
  console.log(`        RM ${cashOut.reduce((n, [, , a]) => n + a, 0).toLocaleString()} of project expenses, ${tasks.length} tasks, ${leads.length} leads.`)
  console.log('remove it all with:  node --env-file-if-exists=.env scripts/sample-data.mjs --purge')
}

if (MODE === 'status') await status()
else if (MODE === 'purge') await purge()
else await seed()
