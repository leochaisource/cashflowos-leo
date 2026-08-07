// Shows exactly what the Head of Marketing WOULD recommend — and writes nothing.
//
//   node --env-file-if-exists=.env scripts/marketing-dry-run.ts
//
// READ-ONLY BY CONSTRUCTION: it selects from `ad_daily` and prints. It never
// imports lib/actions.ts, so there is no propose(), no claim(), no executor, and
// no Telegram call reachable from this file.
//
// It imports the SAME definition.ts + prompt.ts the cron uses, so what you read
// here is what the head will actually say — not a second implementation that can
// drift. (Both of those files are deliberately runtime-import-free, which is what
// lets plain node run them without Next's `@/` alias or `server-only`.)

import {
  aggregate,
  baseline,
  findings,
  wastedSpend,
  windowDays,
  minSpend,
  minWaste,
  minLeadsToWin,
  maxProposals,
} from '../agents/marketing/definition.ts'
import { headline, suggest } from '../agents/marketing/prompt.ts'

const url = process.env.SUPABASE_URL?.trim()
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — is .env filled in?')
  process.exit(1)
}

const rm = (n: number) => 'RM ' + Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 2 })
const int = (n: number) => Number(n || 0).toLocaleString('en-MY')
const strip = (s: string) => s.replace(/<\/?b>/g, '')

const since = new Date()
since.setDate(since.getDate() - windowDays())
const sinceISO = since.toISOString().slice(0, 10)

const res = await fetch(
  `${url}/rest/v1/ad_daily?select=*&date=gte.${sinceISO}&limit=20000`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
)
if (!res.ok) {
  console.error(`Supabase read failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const days = await res.json()

console.log('\n📣  HEAD OF MARKETING — DRY RUN (nothing will be written)\n')
console.log(
  `Dials: last ${windowDays()} days · ignore ads under ${rm(minSpend())} spend · ` +
    `flag once ${rm(minWaste())} above baseline · winner needs ${minLeadsToWin()} leads · cap ${maxProposals()}\n`,
)

const ads = aggregate(days)
const base = baseline(ads)

console.log(`${int(days.length)} ad-days since ${sinceISO} → ${ads.length} ads.`)
if (!base) {
  console.log('\nNo spend or no leads in the window. The head would stay silent today.\n')
  process.exit(0)
}

console.log(
  `\nYOUR BASELINE\n  ${rm(base.spend)} spend → ${int(base.leads)} leads across ${base.ads} ads\n` +
    `  ${rm(base.cpl)} per lead`,
)

console.log('\nEVERY AD, BIGGEST LEAK FIRST')
console.log(
  '  ' + 'ad'.padEnd(38) + 'spend'.padStart(10) + 'leads'.padStart(7) + 'CPL'.padStart(11) + 'vs base'.padStart(11),
)
for (const a of [...ads].sort((x, y) => wastedSpend(y, base) - wastedSpend(x, base))) {
  const w = wastedSpend(a, base)
  console.log(
    '  ' +
      a.name.slice(0, 36).padEnd(38) +
      a.spend.toFixed(2).padStart(10) +
      int(a.leads).padStart(7) +
      (a.cpl === null ? 'no leads' : a.cpl.toFixed(2)).padStart(11) +
      `${w >= 0 ? '+' : ''}${w.toFixed(0)}`.padStart(11),
  )
}

const list = findings(ads, base)
console.log(`\n${'─'.repeat(80)}`)
console.log(`WOULD PROPOSE: ${list.length} recommendation(s) — 🟡 every one needs your YES\n`)

if (list.length === 0) console.log('  Nothing to say — no ad is leaking above the floor.\n')

list.forEach((f, i) => {
  const id = `marketing-triage:${f.issue}:${f.ad.adId}:${Math.floor(f.ad.spend / 100)}`
  console.log(`${i + 1}. [${f.issue.toUpperCase()}]  ${strip(headline(f, base))}`)
  console.log(`   idempotency: ${id}`)
  console.log('   ' + suggest(f, base).split('\n').join('\n   '))
  console.log()
})

console.log('─'.repeat(80))
console.log('Nothing was written. To make these real, run the daily cron.\n')
