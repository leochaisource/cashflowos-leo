// Shows exactly what the Head of Marketing WOULD recommend — and writes nothing.
//
//   node --env-file-if-exists=.env scripts/marketing-dry-run.ts
//
// READ-ONLY BY CONSTRUCTION: it selects from `records` and prints. It never
// imports lib/actions.ts, so there is no propose(), no claim(), no executor, and
// no Telegram call reachable from this file.
//
// It imports the SAME definition.ts + prompt.ts the cron uses, so what you read
// here is what the head will actually say — not a second implementation that can
// drift. (Both of those files are deliberately runtime-import-free, which is what
// lets plain node run them without Next's `@/` alias.)

import {
  adStats,
  baseline,
  findings,
  minClicks,
  cvrFloor,
  maxProposals,
  scaleMinClicks,
} from '../agents/marketing/definition.ts'
import { headline, suggest } from '../agents/marketing/prompt.ts'

const url = process.env.SUPABASE_URL?.trim()
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — is .env filled in?')
  process.exit(1)
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const int = (n: number) => Number(n || 0).toLocaleString('en-MY')
const strip = (s: string) => s.replace(/<\/?b>/g, '')

const res = await fetch(`${url}/rest/v1/records?select=*&category=eq.content`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error(`Supabase read failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const rows = (await res.json()).map((r: any) => ({ ...r, meta: r.meta ?? {} }))

console.log('\n📣  HEAD OF MARKETING — DRY RUN (nothing will be written)\n')
console.log(
  `Dials: min ${minClicks()} clicks · flag below ${cvrFloor() * 100}% of average CVR · ` +
    `cap ${maxProposals()} problems · winner needs ${scaleMinClicks()} clicks\n`,
)

const stats = adStats(rows)
const base = baseline(stats)

console.log(`${rows.length} content rows → ${stats.length} ads with enough clicks to judge.`)
if (!base) {
  console.log('\nNo qualifying ads. The head would stay silent today.\n')
  process.exit(0)
}

console.log(
  `\nYOUR BASELINE (pooled across ${base.ads} ads)\n` +
    `  ${int(base.leads)} leads · ${int(base.clicks)} clicks · ${int(base.views)} views · ${int(base.reach)} reach\n` +
    `  ${pct(base.ctr)} CTR   ${pct(base.cvr)} click→lead   (flag below ${pct(base.cvr * cvrFloor())})`,
)

console.log('\nEVERY AD, WORST CONVERTER FIRST')
console.log('  ' + 'ad'.padEnd(36) + 'clicks'.padStart(8) + 'leads'.padStart(7) + 'CTR'.padStart(9) + 'CVR'.padStart(9))
for (const s of [...stats].sort((a, b) => a.cvr - b.cvr)) {
  console.log(
    '  ' +
      s.title.slice(0, 34).padEnd(36) +
      int(s.clicks).padStart(8) +
      int(s.leads).padStart(7) +
      pct(s.ctr).padStart(9) +
      pct(s.cvr).padStart(9),
  )
}

const list = findings(stats, base)
console.log(`\n${'─'.repeat(78)}`)
console.log(`WOULD PROPOSE: ${list.length} recommendation(s) — 🟡 every one needs your YES\n`)

if (list.length === 0) console.log('  Nothing to say — no ad is below your floor.\n')

list.forEach((f, i) => {
  const id = `marketing-triage:${f.issue}:${f.stat.id}:${Math.floor(f.stat.clicks / 100)}`
  console.log(`${i + 1}. [${f.issue.toUpperCase()}]  ${strip(headline(f, base))}`)
  console.log(`   idempotency: ${id}`)
  console.log(
    '   ' + suggest(f, base).split('\n').join('\n   '),
  )
  console.log()
})

console.log('─'.repeat(78))
console.log('Nothing was written. To make these real, run the daily cron.\n')
