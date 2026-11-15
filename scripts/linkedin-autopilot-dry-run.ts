// The LinkedIn autopilot, by hand — the EXACT step the 9am cron runs
// (agents/linkedin/autopilot.ts), so what you see here is what the cloud does.
// Each run does the one step this week still needs: research → write + check → schedule.
//
//   node --env-file-if-exists=.env --env-file-if-exists=../.env scripts/linkedin-autopilot-dry-run.ts
//        DRY: does the step but saves nothing and schedules nothing. Prints the
//        brief, the drafts with every check result, or renders the slides to --out.
//   … scripts/linkedin-autopilot-dry-run.ts --out <dir>     where dry-run slides go (default: ./tmp-autopilot)
//   … --now 2026-11-21T01:27:00Z      run as if it were that moment (picks the day's step: Sat research,
//                                     Sun write, Mon schedule). Dry runs only.
//   … --thin-search 2026-W47          replay a thin week: that week's saved brief stands in for the first
//                                     web search, so the quality gate and the second search run on it
//   … --thin-brief 2026-W47           that week's saved brief stands in for this week's saved one, so the
//                                     writer, the checks and the second writing pass run on it
//   … scripts/linkedin-autopilot-dry-run.ts --run           REAL: saves the step, and the schedule
//        step really schedules on Leo's LinkedIn. Same as the cron, minus the Telegram cards
//        (they're printed instead).
//
// ../.env is the workspace .env, where PEXELS_API_KEY lives on the laptop.
import { registerHooks } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

// Plain node can't resolve 'next/og' without its extension (the Next build can).
registerHooks({ resolve: (spec: string, ctx: any, next: any) => next(spec === 'next/og' ? 'next/og.js' : spec, ctx) })

const { claudeClient } = await import('../lib/claude-usage.ts')
const { PROJECTS } = await import('../lib/ad-clients.ts')
const { autopilotStep, postingBlock } = await import('../agents/linkedin/autopilot.ts')

const has = (f: string) => process.argv.includes(f)
const arg = (f: string) => (process.argv.indexOf(f) > -1 ? process.argv[process.argv.indexOf(f) + 1] : undefined)
const run = has('--run')
const now = arg('--now') ? new Date(arg('--now')!) : new Date()
if (Number.isNaN(now.getTime())) throw new Error('--now needs an ISO time, e.g. 2026-11-21T01:27:00Z')
if (run && (arg('--now') || arg('--thin-search') || arg('--thin-brief'))) throw new Error('--now, --thin-search and --thin-brief are for dry runs only')
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const key = process.env.ANTHROPIC_API_KEY?.trim()
if (!key) throw new Error('ANTHROPIC_API_KEY missing in .env')
const anthropic = claudeClient('script-linkedin-autopilot', { apiKey: key, timeout: 240_000, maxRetries: 0 })

// A known (thin) week's saved brief, to replay it.
const thinWeek = arg('--thin-search') ?? arg('--thin-brief')
let test: { brief: string; as: 'search' | 'saved' } | undefined
if (thinWeek) {
  const { data, error } = await db.from('linkedin_autopilot').select('data').eq('kind', 'research').eq('week', thinWeek).maybeSingle()
  if (error || !data) throw new Error(`no saved brief for ${thinWeek}${error ? `: ${error.message}` : ''}`)
  test = { brief: String((data as any).data?.text ?? ''), as: arg('--thin-search') ? 'search' : 'saved' }
}

const block = postingBlock(now)
console.log(
  `${run ? 'REAL RUN' : 'DRY RUN'} · ${now.toISOString()} · week ${block.week} · slots ${block.slots.map((s) => s.label).join(', ')} · opens ${block.opens.toISOString().slice(0, 10)}` +
    (test ? ` · ${thinWeek}'s brief as the ${test.as === 'search' ? 'first search' : 'saved brief'}` : ''),
)

const t0 = Date.now()
const r = await autopilotStep({
  db,
  anthropic,
  now,
  pexelsKey: process.env.PEXELS_API_KEY?.trim() || null,
  neverName: PROJECTS.flatMap((p) => [p.name.split(' — ')[0].replace(/ Ads$/, ''), ...(p.watchPages ?? []).map((w) => w.name)]),
  dryRun: !run,
  test,
  log: (s) => console.log(`  ${s}`),
})
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
for (const n of r.notes) console.log(`· ${n}`)
for (const c of r.cards) console.log(`\n--- card ${c.idempotencyKey}\n${c.text.replace(/<[^>]+>/g, '')}`)

const p: any = r.preview
const graded = (title: string, g: any) => {
  console.log(`\n===== ${title}: ${g.usable.length} usable of ${g.items.length} item(s) =====`)
  for (const i of g.usable) console.log(`  ✓ ${i.kind} · ${i.source} · ${i.url}`)
  for (const u of g.unusable) console.log(`  ✗ ${u.item.kind} · ${u.item.source} · ${u.why}`)
}
if (p?.kind === 'research') {
  graded('FIRST BRIEF', p.first)
  if (p.more) {
    console.log(`\n===== SECOND SEARCH (new items) =====\n${p.more}`)
    graded('BRIEF AFTER THE SECOND SEARCH', p.final)
  } else if (!test) console.log(`\n===== RESEARCH BRIEF =====\n${p.brief}`)
} else if (p?.checked) {
  for (const [i, c] of p.checked.entries()) {
    console.log(`\n===== PASS ${c.pass} · DRAFT ${i + 1} · ${c.post.hook_type} · ${c.post.topic} · ${c.problems.length ? `DROPPED (${c.problems.length})` : 'PASSES'} =====`)
    console.log(c.post.body)
    console.log(`\nsource: ${c.post.source_url || '(none)'}\npage: ${c.page}\nleo_link: ${c.post.leo_link}${c.post.leo_notes_used?.length ? `\nLeo's notes used: ${c.post.leo_notes_used.join(', ')}` : ''}`)
    for (const x of c.problems) console.log(`  ✗ ${x}`)
  }
  if (p.decisions.length) {
    console.log('\n===== SLOTS (what a real run would save) =====')
    for (const d of p.decisions) console.log(`  pass ${d.pass} · ${d.slot}: ${d.status}${d.hook ? ` · "${d.hook}"` : ''}${d.why ? ` · ${d.why}` : ''}`)
  }
  const sch = p.scheduled
  if (sch?.slides) {
    const out = arg('--out') ?? join(process.cwd(), 'tmp-autopilot')
    mkdirSync(out, { recursive: true })
    sch.slides.forEach((b: Buffer, i: number) => writeFileSync(join(out, `slide-${String(i + 1).padStart(2, '0')}.png`), b))
    console.log(`\n${sch.slides.length} slides for ${sch.slot} → ${out}\nphotos: ${sch.images.ids.join(', ')}\ncover: ${sch.cover ? `Leo's photo ${sch.cover.name} (${sch.cover.why})` : 'stock'}\nfirst comment: ${sch.firstComment}`)
  }
}
