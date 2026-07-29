// Offline. Reads the captured raw response, writes the normalised ads.
// No network calls. Run: node scripts/adyntel-normalise.ts
import fs from 'node:fs'
import { flattenAds, normaliseAd } from '../lib/adyntel.ts'

const RAW = 'data/adyntel-raw-latest.json'
const OUT = 'data/adyntel-ads-normalised.json'

const json = JSON.parse(fs.readFileSync(RAW, 'utf8'))
const raw = flattenAds(json)
const ads = raw.map((a) => normaliseAd(a))

fs.writeFileSync(
  OUT,
  JSON.stringify(
    { source: RAW, normalised_at: new Date().toISOString(), number_of_ads: json.number_of_ads, count: ads.length, ads },
    null,
    2,
  ),
  'utf8',
)

const n = (f: (a: (typeof ads)[number]) => boolean) => ads.filter(f).length
console.log('raw individual ads found :', raw.length)
console.log('normalised successfully  :', ads.length)
console.log('with primary copy        :', n((a) => a.body_text.length > 0))
console.log('with headline (title)    :', n((a) => !!a.title))
console.log('with start_date          :', n((a) => a.start_date !== null))
console.log('with end_date            :', n((a) => a.end_date !== null))
console.log('with image URLs          :', n((a) => a.images.length > 0))
console.log('with video URLs          :', n((a) => a.videos.length > 0))
console.log('with cards               :', n((a) => a.cards.length > 0))
console.log('with link_url            :', n((a) => !!a.link_url))
console.log('run_days unknown         :', n((a) => a.run_days_basis === 'unknown'))
console.log('run_days >= 7            :', n((a) => (a.run_days ?? 0) >= 7))
console.log('run_days >= 30           :', n((a) => (a.run_days ?? 0) >= 30))
console.log('\nlongest-running active:')
for (const a of ads.filter((x) => x.is_active && x.run_days !== null).sort((x, y) => y.run_days! - x.run_days!).slice(0, 3))
  console.log(`  ${String(a.run_days).padStart(3)}d  ${a.page_name}  [${a.display_format}]  "${(a.title ?? a.body_text).slice(0, 60)}"`)
console.log('\nwrote', OUT)
