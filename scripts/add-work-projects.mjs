// One-off: the work projects Leo listed on 2026-08-16, plus their next steps.
// REAL data — no sample markers. Idempotent: a project slug or a task title
// that already exists under the same project is never inserted twice.
//
//   node --env-file-if-exists=.env scripts/add-work-projects.mjs
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)

// Dates as given on 2026-08-16 (Sunday): "meeting tomorrow" = Mon 17th,
// "done by next Tuesday" = Tue 18th. Undated tasks are ones Leo gave no
// deadline for — the dashboard shows them as "no deadline set".
const PROJECTS = [
  { slug: 'mr-money-academy', title: 'Mr Money Academy', client: 'Mr Money Academy', status: 'negotiation', phase: 'In negotiation', due: null,
    notes: 'Still in negotiation — meeting 17 Aug. Timing/schedule pending from their side.' },
  { slug: 'dr-tariq-website', title: 'Dr Tariq — website malware fix', client: 'Dr Tariq', status: 'active', phase: 'Fixing / cleanup', due: '2026-08-18',
    notes: 'Debugging + malware removal. Target: done by Tuesday 18 Aug.' },
  { slug: 'sandra-migration', title: 'Sandra — landing page & Mailchimp migration', client: 'Sandra', status: 'active', phase: 'Build & migrate', due: null, notes: null },
  { slug: 'trisen-markethon', title: 'Trisen Markethon', client: 'Trisen', status: 'active', phase: 'Materials prep', due: null,
    notes: 'Teaching materials and slides to prepare.' },
  { slug: 'firstin5', title: 'Firstin5 — own sub-brand', client: 'Firstin5 (own brand)', status: 'active', phase: 'Website & landing page', due: null,
    notes: 'Build the website and landing page so marketing activities can start.' },
]

// meta.project ties a step to its project — the same convention receipts use.
// Ad-client ids (claude-malaysia, starcity-global) work here too.
const TASKS = [
  ['starcity-global', 'Connect Starcity Meta ad account (account id + token into Vercel)', '2026-08-19'],
  ['mr-money-academy', 'Meeting with Mr Money Academy — confirm scope', '2026-08-17'],
  ['mr-money-academy', 'Get proposed timing / schedule from MMA', '2026-08-19'],
  ['dr-tariq-website', 'Finish malware cleanup and verify the site is clean', '2026-08-18'],
  ['sandra-migration', 'Build Sandra’s landing page', null],
  ['sandra-migration', 'Migrate the email list to Mailchimp', null],
  ['trisen-markethon', 'Prepare teaching materials and slides', null],
  ['claude-malaysia', 'Review the deal profitability and decide the best arrangement to continue', null],
  ['firstin5', 'Build the Firstin5 website', null],
  ['firstin5', 'Build the Firstin5 landing page for marketing', null],
]

let inserted = 0
for (const p of PROJECTS) {
  const { data: existing } = await db
    .from('records')
    .select('id')
    .eq('category', 'project')
    .eq('meta->>slug', p.slug)
    .limit(1)
  if (existing?.length) { console.log(`  project ${p.slug} — already there`); continue }
  const { error } = await db.from('records').insert({
    title: p.title, status: p.status, amount: 0, category: 'project', due_date: p.due, notes: p.notes,
    meta: { slug: p.slug, client: p.client, phase: p.phase },
  })
  if (error) { console.error(`  project ${p.slug} FAILED: ${error.message}`); process.exitCode = 1 } else { inserted++; console.log(`  project ${p.slug} ✓`) }
}

for (const [project, title, due] of TASKS) {
  const { data: existing } = await db
    .from('records')
    .select('id')
    .eq('category', 'task')
    .eq('title', title)
    .eq('meta->>project', project)
    .limit(1)
  if (existing?.length) { console.log(`  task "${title.slice(0, 40)}…" — already there`); continue }
  const { error } = await db.from('records').insert({
    title, status: 'open', amount: 0, category: 'task', due_date: due, notes: null,
    meta: { project },
  })
  if (error) { console.error(`  task "${title}" FAILED: ${error.message}`); process.exitCode = 1 } else { inserted++; console.log(`  task ✓ ${title.slice(0, 56)}`) }
}
console.log(`\ninserted ${inserted} row(s)`)
