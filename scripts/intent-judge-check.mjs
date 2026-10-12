// Would a cheaper model give the same hot/warm/cold labels as the current judge?
// Owner's rule (2026-10-12): run this on one past day before changing INTENT_MODEL
// in lib/followups.ts. It judges the day twice with the reference model (the gap
// between those two runs is the noise floor) and once with each candidate.
//
//   node --env-file=.env scripts/intent-judge-check.mjs --day=2026-10-11 claude-sonnet-5-5 claude-haiku-5-5
//
// Spends real API credit: one judging pass per run (~$0.10-0.25 each on Opus).
// A candidate qualifies when it keeps every lead the reference calls hot in both
// runs, and its overall match is within ~5 points of the noise floor.
import Anthropic from '@anthropic-ai/sdk'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { dayBounds } from '../lib/ghl.ts'
import { eventFor } from '../lib/deal.ts'
import { buildFollowups } from '../lib/followups.ts'

const args = process.argv.slice(2)
const day = args.find((a) => a.startsWith('--day='))?.slice(6) ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10)
const reference = args.find((a) => a.startsWith('--ref='))?.slice(6) ?? 'claude-opus-5-5'
const candidates = args.filter((a) => !a.startsWith('--'))
if (!candidates.length) throw new Error('name at least one candidate model, e.g. claude-sonnet-5-5')

const c = AD_CLIENTS.find((x) => x.id === 'claude-malaysia')
const g = c.ghl
const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
const { start, end } = dayBounds(day, tz)
const next = eventFor(c.deal, new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10))
const product =
  `${c.client ?? c.name} one-day Claude AI workshop on ${next.to}, tickets ` +
  `RM${c.deal.ticketPrices.general} General / RM${c.deal.ticketPrices.vip} VIP`
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() })

const runs = [['refA', reference], ['refB', reference], ...candidates.map((m) => [m, m])]
const L = {}
const names = {}
for (const [k, model] of runs) {
  const t0 = Date.now()
  const f = await buildFollowups({
    locationId: process.env[g.locationEnv].trim(),
    token: process.env[g.tokenEnv].trim(),
    day,
    dayStartISO: start,
    dayEndISO: end,
    salesSinceISO: dayBounds(next.from, tz).start,
    includeSources: g.includeOrderSources ?? [],
    product,
    anthropic,
    notLeads: g.notLeads,
    intentModel: model,
    intentEffort: 'low',
  })
  L[k] = {}
  for (const ch of f.chats) {
    if (ch.intent !== 'unknown') L[k][ch.contactId] = ch.intent
    names[ch.contactId] = (ch.name ?? '?').slice(0, 22)
  }
  console.log(`${k} (${model}): ${Object.keys(L[k]).length} chats, ${Math.round((Date.now() - t0) / 1000)}s, error ${f.intentError ?? 'none'}`)
}

const ids = Object.keys(L.refA).filter((id) => runs.every(([k]) => L[k][id]))
const pct = (n) => `${n}/${ids.length} (${Math.round((100 * n) / ids.length)}%)`
const agree = (a, b) => ids.filter((id) => L[a][id] === L[b][id]).length
const counts = (k) => ['hot', 'warm', 'cold', 'not_a_lead'].map((i) => `${i} ${ids.filter((id) => L[k][id] === i).length}`).join(' · ')
const stableHot = ids.filter((id) => L.refA[id] === 'hot' && L.refB[id] === 'hot')
const anyHot = new Set(ids.filter((id) => L.refA[id] === 'hot' || L.refB[id] === 'hot'))
const floor = agree('refA', 'refB')

console.log(`\n${day} · ${ids.length} chats judged by every run · reference ${reference}`)
for (const [k] of runs) console.log(`  ${k.padEnd(18)} ${counts(k)}`)
console.log(`\nNoise floor (reference vs its own re-run): ${pct(floor)}`)
for (const k of candidates) {
  const a = agree(k, 'refA')
  const b = agree(k, 'refB')
  const missed = stableHot.filter((id) => L[k][id] !== 'hot')
  const extra = ids.filter((id) => L[k][id] === 'hot' && !anyHot.has(id))
  const ok = !missed.length && Math.max(a, b) >= floor - Math.ceil(ids.length * 0.05)
  console.log(`\n${k}: ${ok ? 'QUALIFIES' : 'does not qualify'} · match ${pct(a)} / ${pct(b)}`)
  console.log(`  reference hot in both runs: ${stableHot.length} · missed: ${missed.map((id) => `${names[id]} (${L[k][id]})`).join(', ') || 'none'}`)
  console.log(`  extra hot (reference says otherwise): ${extra.map((id) => `${names[id]} (${L.refA[id]}/${L.refB[id]})`).join(', ') || 'none'}`)
}
