// Offline. Upserts data/adyntel-ads-normalised.json into competitor_ads.
// No network calls to Adyntel. Run: node scripts/adyntel-upsert.ts [--apply]
//
// Upsert key is (competitor, ad_archive_id), so re-running updates the same
// advertisement instead of duplicating it. first_seen_at is deliberately NOT in
// the payload: on insert the column default stamps it, on update it is left
// alone, which is what makes "first seen by our system" meaningful.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { NormalisedAd } from '../lib/adyntel.ts'

const APPLY = process.argv.includes('--apply')
const KEYWORD = process.argv.find((a) => a.startsWith('--keyword='))?.split('=')[1] ?? 'NLP practitioner'

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const iso = (u: number | null) => (u === null ? null : new Date(u * 1000).toISOString())

const { ads } = JSON.parse(fs.readFileSync('data/adyntel-ads-normalised.json', 'utf8')) as { ads: NormalisedAd[] }

const rows = ads.map((a) => ({
  competitor: a.page_name,
  page_id: a.page_id,
  ad_archive_id: a.ad_archive_id,
  last_seen_at: new Date().toISOString(),
  keywords: [KEYWORD],
  meta_start_date: iso(a.start_date),
  meta_end_date: iso(a.end_date),
  is_active: a.is_active,
  run_days: a.run_days,
  run_days_basis: a.run_days_basis,
  body_text: a.body_text || null,
  body_html: a.body_html,
  title: a.title,
  caption: a.caption,
  link_description: a.link_description,
  cta_text: a.cta_text,
  cta_type: a.cta_type,
  link_url: a.link_url,
  display_format: a.display_format,
  publisher_platform: a.publisher_platform,
  collation_count: a.collation_count,
  image_urls: a.images.map((i) => i.original_image_url ?? i.resized_image_url).filter(Boolean),
  video_urls: a.videos.map((v) => v.video_hd_url ?? v.video_sd_url).filter(Boolean),
  thumbnail_urls: a.videos.map((v) => v.video_preview_image_url).filter(Boolean),
  raw_payload: a.raw_payload,
  updated_at: new Date().toISOString(),
}))

console.log(`prepared ${rows.length} rows for competitor_ads (keyword "${KEYWORD}")`)
console.log(`  advertisers: ${new Set(rows.map((r) => r.competitor)).size}`)
console.log(`  with copy: ${rows.filter((r) => r.body_text).length} · headlines: ${rows.filter((r) => r.title).length}`)
console.log(`  with image urls: ${rows.filter((r) => r.image_urls.length).length} · video urls: ${rows.filter((r) => r.video_urls.length).length}`)

if (!APPLY) { console.log('\n(preview only — nothing written; pass --apply)'); process.exit(0) }

const { data, error } = await s
  .from('competitor_ads')
  .upsert(rows, { onConflict: 'competitor,ad_archive_id' })
  .select('id')
if (error) { console.error('upsert failed:', error.message); process.exit(1) }
console.log(`\nwrote ${data?.length ?? 0} rows`)

const { count } = await s.from('competitor_ads').select('*', { count: 'exact', head: true })
console.log('competitor_ads now holds', count, 'rows')
