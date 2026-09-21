// Re-score a client's STORED competitor ads against the relevance terms in
// lib/ad-clients.ts — zero Adyntel credits, seconds per run.
//
//   node --env-file-if-exists=.env scripts/adyntel-rescore.ts --client=starcity-global
//   ... --why=優選良屋        which terms matched / which exclusion fired, per ad, for one advertiser
//   ... --off                 list the OFF-topic advertisers with a copy snippet each (the teaching material)
//
// THE LOOP THIS EXISTS FOR: the first pull for a new market is a guess at the
// vocabulary. Tune terms, re-score here, repeat until the off-topic list is
// genuinely off-topic and no known-good advertiser is rejected — and only THEN
// spend credits re-pulling with better keywords. Every ad's raw payload is
// stored, so the paid call is never needed to test a filter change.
//
// Two traps this has already caught (2026-09-21):
//   · a bare country name is not a market signal — in HK, '馬來西亞' mostly
//     labels furniture origin, SIM cards and package tours;
//   · CJK terms match as SUBSTRINGS (no word boundaries), so a short exclusion
//     like 保险 also kills 保险库 (a vault, a KL condo selling point).
import { createClient } from '@supabase/supabase-js'
import { normaliseAd, isRelevant, type NormalisedAd } from '../lib/adyntel.ts'
import { AD_CLIENTS } from '../lib/ad-clients.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const clientId = arg('client')
const why = arg('why')
const showOff = process.argv.includes('--off')

const client = AD_CLIENTS.find((c) => c.id === clientId)
if (!client) {
  console.error(`--client must be one of: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const { data, error } = await db
  .from('competitor_ads')
  .select('competitor, keywords, run_days, is_active, cta_text, display_format, raw_payload')
  .eq('client', client.id)
if (error) throw error
const rows = (data ?? []).map((r) => ({ r, a: normaliseAd(r.raw_payload as Record<string, unknown>) }))

// Same matcher as isRelevant(), exposed so --why can name the culprit.
const hayOf = (a: NormalisedAd) =>
  `${a.title ?? ''} ${a.body_text} ${a.caption ?? ''} ${a.link_description ?? ''} ${a.link_url ?? ''}`.toLowerCase()
const hits = (h: string, terms: string[]) =>
  terms.filter((t) => {
    const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m)
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(h)
  })

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const on = rows.filter((x) => isRelevant(x.a, client.relevanceTerms, client.excludeTerms))
const off = rows.filter((x) => !on.includes(x))
console.log(`${client.name}: stored ${rows.length} · on-topic ${on.length} (${rows.length ? Math.round((on.length / rows.length) * 100) : 0}%) · off-topic ${off.length}`)

const group = (list: typeof rows) => {
  const m = new Map<string, typeof rows>()
  for (const x of list) m.set(x.r.competitor, [...(m.get(x.r.competitor) ?? []), x])
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
}

console.log('\nON-TOPIC advertisers:')
for (const [adv, list] of group(on)) {
  const longest = Math.max(...list.map((x) => x.r.run_days ?? 0))
  console.log(`  ${String(list.length).padStart(2)}× ${adv} · longest ${longest}d · ${[...new Set(list.map((x) => x.r.cta_text ?? '-'))].join('/')}`)
}

if (showOff) {
  console.log('\nOFF-TOPIC advertisers (read these by name — anything that belongs here is a missing term):')
  for (const [adv, list] of group(off)) {
    const x = list[0]
    const ex = hits(`${x.a.page_name} ${hayOf(x.a)}`.toLowerCase(), client.excludeTerms ?? [])
    console.log(`  ${String(list.length).padStart(2)}× ${adv}${ex.length ? ` · EXCLUDED by ${ex.join(',')}` : ''}`)
    console.log(`      ${clean(x.a.title).slice(0, 80)} — ${clean(x.a.body_text).slice(0, 160)}`)
  }
}

if (why) {
  const target = rows.filter((x) => x.r.competitor.toLowerCase().includes(why.toLowerCase()))
  console.log(`\nWHY — ${target.length} ad(s) from advertisers matching "${why}":`)
  for (const x of target) {
    const h = hayOf(x.a)
    const groups = (client.relevanceTerms ?? []).map((g, i) => `g${i + 1}: ${hits(h, g).join(',') || '∅'}`)
    const ex = hits(`${x.a.page_name} ${h}`.toLowerCase(), client.excludeTerms ?? [])
    console.log(`  ${on.includes(x) ? '✓' : '✗'} ${x.r.competitor} · ${x.r.run_days ?? '?'}d · ${groups.join(' · ')} · excluded by: ${ex.join(',') || 'nothing'}`)
    console.log(`      ${clean(x.a.body_text).slice(0, 200)}`)
  }
}
