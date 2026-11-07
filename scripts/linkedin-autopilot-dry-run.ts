// The LinkedIn autopilot, by hand — the EXACT step the 9am cron runs
// (agents/linkedin/autopilot.ts), so what you see here is what the cloud does.
// Each run does the one step this week still needs: research → write + check → schedule.
//
//   node --env-file-if-exists=.env --env-file-if-exists=../.env scripts/linkedin-autopilot-dry-run.ts
//        DRY: does the step but saves nothing and schedules nothing. Prints the
//        brief, the drafts with every check result, or renders the slides to --out.
//   … scripts/linkedin-autopilot-dry-run.ts --out <dir>     where dry-run slides go (default: ./tmp-autopilot)
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
const now = new Date()
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const key = process.env.ANTHROPIC_API_KEY?.trim()
if (!key) throw new Error('ANTHROPIC_API_KEY missing in .env')
const anthropic = claudeClient('script-linkedin-autopilot', { apiKey: key, timeout: 240_000, maxRetries: 0 })

const block = postingBlock(now)
console.log(`${run ? 'REAL RUN' : 'DRY RUN'} · week ${block.week} · slots ${block.slots.map((s) => s.label).join(', ')} · opens ${block.opens.toISOString().slice(0, 10)}`)

const t0 = Date.now()
const r = await autopilotStep({
  db,
  anthropic,
  now,
  pexelsKey: process.env.PEXELS_API_KEY?.trim() || null,
  neverName: PROJECTS.flatMap((p) => [p.name.split(' — ')[0].replace(/ Ads$/, ''), ...(p.watchPages ?? []).map((w) => w.name)]),
  dryRun: !run,
  log: (s) => console.log(`  ${s}`),
})
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
for (const n of r.notes) console.log(`· ${n}`)
for (const c of r.cards) console.log(`\n--- card ${c.idempotencyKey}\n${c.text.replace(/<[^>]+>/g, '')}`)

const p: any = r.preview
if (typeof p === 'string') console.log(`\n===== RESEARCH BRIEF =====\n${p}`)
else if (Array.isArray(p)) {
  for (const [i, c] of p.entries()) {
    console.log(`\n===== DRAFT ${i + 1} · ${c.post.hook_type} · ${c.post.topic} · ${c.problems.length ? `DROPPED (${c.problems.length})` : 'PASSES'} =====`)
    console.log(c.post.body)
    console.log(`\nsource: ${c.post.source_url || '(none)'}\npage: ${c.page}\nleo_link: ${c.post.leo_link}`)
    for (const x of c.problems) console.log(`  ✗ ${x}`)
  }
} else if (p?.slides) {
  const out = arg('--out') ?? join(process.cwd(), 'tmp-autopilot')
  mkdirSync(out, { recursive: true })
  p.slides.forEach((b: Buffer, i: number) => writeFileSync(join(out, `slide-${String(i + 1).padStart(2, '0')}.png`), b))
  console.log(`\n${p.slides.length} slides for ${p.slot} → ${out}\nphotos: ${p.images.ids.join(', ')}\nfirst comment: ${p.firstComment}`)
}
