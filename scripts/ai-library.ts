// The AI Library, by hand — the EXACT step the cloud runs (agents/ai-library/run.ts).
//
//   node --env-file-if-exists=.env --env-file-if-exists=../.env scripts/ai-library.ts --research --focus=marketing-sales
//        DRY (default): researches and checks, prints every case and why any was left out. Saves nothing.
//   … --research --focus=<f> --run      REAL: saves the cases to ai_library (the run is keyed by today's
//        date, so it counts as today's research; add --force to run again the same day).
//   … --suggest                         DRY: writes this week's 3 ideas from the library and prints the
//        Telegram cards. Saves nothing, sends nothing.
//   … --suggest --run                   REAL: saves the ideas. Still sends nothing: cards go out only from
//        the cloud route (/api/ai-library), so a laptop test can never send Leo a duplicate.
//   … --list                            the library's newest 20 cases and this week's runs.
//
// Focuses: marketing-sales | ops-finance-admin | solo-small-team | malaysia-sea
// Costs Claude API credit (research ≈ US$0.15–0.40 a run, ideas ≈ US$0.10), metered as script-ai-library.
import { createClient } from '@supabase/supabase-js'

const { claudeClient } = await import('../lib/claude-usage.ts')
const { PROJECTS } = await import('../lib/ad-clients.ts')
const { libraryStep, isoWeek } = await import('../agents/ai-library/run.ts')
const { FOCUSES } = await import('../agents/ai-library/research.ts')

const has = (f: string) => process.argv.includes(f)
const opt = (f: string) => process.argv.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1)
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const appUrl = (process.env.APP_URL?.trim() || 'https://cashflowos-leo.vercel.app').replace(/\/+$/, '')

if (has('--list')) {
  const { data, count } = await db.from('ai_library').select('id, created_at, who, title, check_status, relevance, found_by', { count: 'exact' }).order('created_at', { ascending: false }).limit(20)
  console.log(`${count ?? '?'} case(s) in the library; newest ${data?.length ?? 0}:`)
  for (const c of data ?? []) console.log(`#${c.id} ${c.created_at.slice(0, 10)} [${c.check_status}, ${c.relevance}/5, ${c.found_by}] ${c.who}: ${c.title}`)
  const { data: runs } = await db.from('ai_library_runs').select('*').order('started_at', { ascending: false }).limit(8)
  console.log('\nRecent runs:')
  for (const r of runs ?? []) console.log(`${r.key} ${r.status} added=${r.added} ${JSON.stringify(r.notes).slice(0, 300)}`)
  process.exit(0)
}

const step = has('--suggest') ? 'suggest' : has('--research') ? 'research' : null
if (!step) throw new Error('say --research, --suggest or --list')
const focus = opt('--focus')
if (step === 'research' && (!focus || !(focus in FOCUSES))) throw new Error(`--focus= one of ${Object.keys(FOCUSES).join(', ')}`)
const key = process.env.ANTHROPIC_API_KEY?.trim()
if (!key) throw new Error('ANTHROPIC_API_KEY missing in .env')
const run = has('--run')
const now = new Date()
console.log(`${run ? 'REAL RUN' : 'DRY RUN'} · ${step}${focus ? ` · ${focus}` : ''} · week ${isoWeek(now)}`)

const t0 = Date.now()
const r = await libraryStep({
  db,
  anthropic: claudeClient('script-ai-library', { apiKey: key, timeout: 240_000, maxRetries: 0 }),
  now,
  step,
  focus: focus as any,
  dryRun: !run,
  force: has('--force'),
  liveFacts: [
    `Ad clients on the focus list: ${PROJECTS.filter((p) => p.rank).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((p) => `${p.rank}. ${p.name}`).join('; ')}`,
  ],
  appUrl,
  log: (s) => console.log(`… ${s}`),
})
console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)}s\nnotes:\n${r.notes.map((n) => `- ${n}`).join('\n')}`)
if (r.preview) console.log('\nPREVIEW:\n' + JSON.stringify(r.preview, null, 2))
for (const c of r.cards) console.log(`\n--- card (${c.kind}) ---\n${c.text.replace(/<[^>]+>/g, '')}`)
