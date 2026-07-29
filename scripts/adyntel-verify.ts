// Phase 7 verification. Replays the ACTUAL report code (lib/adyntel.ts) against
// the captured raw response. No Adyntel call, no Telegram message, no writes.
// Run: node scripts/adyntel-verify.ts
import fs from 'node:fs'
import { flattenAds, normaliseAd, competitorSection, mediaUrls, groupConcepts, type PriorAd } from '../lib/adyntel.ts'

const j = JSON.parse(fs.readFileSync('data/adyntel-raw-latest.json', 'utf8'))
const raw = flattenAds(j)
const ads = raw.map((a) => normaliseAd(a))

const manifest = fs.existsSync('data/competitor-creatives/manifest.json')
  ? JSON.parse(fs.readFileSync('data/competitor-creatives/manifest.json', 'utf8')).records
  : []
const localMedia: Record<string, string[]> = {}
for (const r of manifest.filter((r: { ok: boolean }) => r.ok))
  (localMedia[r.ad_archive_id] ??= []).push(r.file)

const n = (f: (a: (typeof ads)[number]) => boolean) => ads.filter(f).length

console.log('═══ PHASE 7 · VERIFICATION (offline, against data/adyntel-raw-latest.json) ═══\n')
console.log('raw individual ads found            :', raw.length, `(API reported number_of_ads = ${j.number_of_ads})`)
console.log('successfully normalised             :', ads.length)
console.log('containing primary copy             :', n((a) => a.body_text.length > 0))
console.log('containing headlines                :', n((a) => !!a.title))
console.log('containing start dates              :', n((a) => a.start_date !== null))
console.log('containing image URLs               :', n((a) => a.images.length > 0))
console.log('containing video URLs               :', n((a) => a.videos.length > 0))
console.log('containing carousel cards           :', n((a) => a.cards.length > 0))
console.log('containing a landing URL            :', n((a) => !!a.link_url))
console.log('run_days computed                   :', n((a) => a.run_days !== null), `(unknown: ${n((a) => a.run_days === null)})`)
console.log('creatives downloaded to disk        :', manifest.filter((r: { ok: boolean }) => r.ok).length,
  `across ${Object.keys(localMedia).length} ads`)
console.log('records prepared for Supabase       :', ads.length)

// Fields the API genuinely did not send, on any ad.
const absent: string[] = []
const check: Record<string, (a: (typeof ads)[number]) => boolean> = {
  'snapshot.body.markup.__html (Meta HTML form)': (a) => a.body_html !== null,
  'snapshot.ad_creative_id': (a) => a.ad_creative_id !== null,
  'snapshot.creation_time': (a) => a.creation_time !== null,
  'snapshot.extra_videos': (a) => a.extra_videos.length > 0,
}
for (const [k, f] of Object.entries(check)) if (!ads.some(f)) absent.push(k)
console.log('\nfields genuinely ABSENT from the raw response (0 of 27 ads):')
for (const a of absent) console.log('  -', a)

const partial = [
  ['total_active_time', raw.filter((r) => r.total_active_time != null).length],
  ['snapshot.title', n((a) => !!a.title)],
  ['snapshot.cards', n((a) => a.cards.length > 0)],
  ['snapshot.extra_texts', n((a) => a.extra_texts.length > 0)],
] as const
console.log('\nfields present on only SOME ads:')
for (const [k, c] of partial) console.log(`  ${String(c).padStart(3)}/27  ${k}`)

// Simulate a first run (empty table) and a second run (everything already known).
const asPrior = (): PriorAd[] =>
  ads.map((a) => ({ ad_archive_id: a.ad_archive_id, competitor: a.page_name, is_active: a.is_active, title: a.title, body_text: a.body_text }))

const first = competitorSection(ads, [], 'MY', localMedia)
const second = competitorSection(ads, asPrior(), 'MY', localMedia)
console.log('\nfirst run (empty table)  → fresh:', first.stats.fresh, '· new concepts:', first.stats.new_concepts, '· variations:', first.stats.new_variations)
console.log('second run (all known)   → fresh:', second.stats.fresh, '· no longer listed:', second.stats.no_longer_listed)
console.log('active:', first.stats.active, '· advertisers:', first.stats.advertisers, '· 7d+:', first.stats.running_7d, '· 30d+:', first.stats.running_30d)

const withMedia = ads.filter((a) => mediaUrls(a).images.length || mediaUrls(a).videos.length).length
console.log('ads carrying at least one media URL :', withMedia)

console.log('\n─── the block that now goes to the model (first run) ───\n')
console.log(first.text)
