// Populate ONE client's competitor set from a live Adyntel search.
//
//   node --env-file-if-exists=.env scripts/adyntel-seed-client.ts --client=lotus-clinic
//   node --env-file-if-exists=.env scripts/adyntel-seed-client.ts --client=lotus-clinic --replace
//   ... --pages=2      (deeper, costs one credit per page per keyword)
//
// Runs EVERY keyword the client has, not just today's rotation — a new client
// starts with an empty market and the morning brief's "new since last fetch"
// diff is meaningless until there's a baseline to diff against.
//
// Costs: keywords × countries × pages credits. It prints the bill before spending.
// Sends nothing to Telegram and calls no model.
import { createClient } from '@supabase/supabase-js'
import { flattenAds, normaliseAd, mediaUrls, isRelevant, type NormalisedAd } from '../lib/adyntel.ts'
import { AD_CLIENTS } from '../lib/ad-clients.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const ID = arg('client')
const PAGES = Math.min(Math.max(Number(arg('pages')) || 1, 1), 5)
const REPLACE = process.argv.includes('--replace')

const client = AD_CLIENTS.find((c) => c.id === ID)
if (!client) {
  console.error(`unknown client "${ID}" — known: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const api_key = (process.env.ADYNTEL_API_KEY ?? '').trim()
const email = (process.env.ADYNTEL_EMAIL ?? '').trim()
if (!api_key || !email) { console.error('ADYNTEL_API_KEY / ADYNTEL_EMAIL not set'); process.exit(1) }

const jobs = client.keywords.flatMap((k) => client.countries.map((c) => [k, c] as const))
console.log(`${client.name}: ${jobs.length} search(es) × up to ${PAGES} page(s) = up to ${jobs.length * PAGES} credits`)

async function search(keyword: string, country: string) {
  const out = new Map<string, NormalisedAd>()
  let token: string | null = null
  for (let page = 0; page < PAGES; page++) {
    const res = await fetch('https://api.adyntel.com/facebook_ad_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key, email, keyword, country_code: country, ...(token ? { continuation_token: token } : {}) }),
      signal: AbortSignal.timeout(90000),
    })
    if (res.status === 402) throw new Error('Adyntel is out of credits — top up at app.adyntel.com')
    if (!res.ok) throw new Error(`Adyntel ${res.status} on "${keyword}"`)
    const json = (await res.json()) as { continuation_token?: string | null; is_result_complete?: boolean }
    for (const raw of flattenAds(json)) {
      const ad = normaliseAd(raw)
      if (ad.ad_archive_id && !out.has(ad.ad_archive_id)) out.set(ad.ad_archive_id, ad)
    }
    token = json.continuation_token ?? null
    if (json.is_result_complete === true || !token) break
  }
  return [...out.values()]
}

if (REPLACE) {
  const { count } = await db.from('competitor_ads').select('id', { count: 'exact', head: true }).eq('client', client.id)
  await db.from('competitor_ads').delete().eq('client', client.id)
  console.log(`cleared ${count ?? 0} existing ad(s) for ${client.id}`)
}

const byId = new Map<string, NormalisedAd>()
const keywordsByAd = new Map<string, Set<string>>()
let credits = 0
for (const [keyword, country] of jobs) {
  try {
    const ads = await search(keyword, country)
    credits += 1
    for (const ad of ads) {
      if (!byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
      const set = keywordsByAd.get(ad.ad_archive_id) ?? new Set<string>()
      set.add(keyword)
      keywordsByAd.set(ad.ad_archive_id, set)
    }
    const onTopic = ads.filter((a) => isRelevant(a, client.relevanceTerms, client.excludeTerms)).length
    console.log(`  "${keyword}" (${country}): ${ads.length} ads, ${onTopic} on-topic`)
  } catch (e) {
    console.error(`  "${keyword}" (${country}) FAILED: ${(e as Error).message}`)
    if ((e as Error).message.includes('out of credits')) break
  }
}

const ads = [...byId.values()]
if (!ads.length) { console.log('nothing fetched — nothing written'); process.exit(0) }

const iso = (u: number | null) => (u === null ? null : new Date(u * 1000).toISOString())
const rows = ads.map((a) => {
  const media = mediaUrls(a)
  return {
    client: client.id,
    competitor: a.page_name,
    page_id: a.page_id,
    ad_archive_id: a.ad_archive_id,
    last_seen_at: new Date().toISOString(),
    keywords: [...(keywordsByAd.get(a.ad_archive_id) ?? [])],
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
    image_urls: media.images,
    video_urls: media.videos,
    thumbnail_urls: media.thumbs,
    page_like_count: a.page_like_count,
    page_categories: a.page_categories,
    page_profile_uri: a.page_profile_uri,
    raw_payload: a.raw_payload,
    updated_at: new Date().toISOString(),
  }
})

const write = (payload: Record<string, unknown>[]) =>
  db.from('competitor_ads').upsert(payload, { onConflict: 'client,competitor,ad_archive_id' }).select('id')

let { data, error } = await write(rows)
if (error && /page_like_count|page_categories|page_profile_uri|schema cache/i.test(error.message)) {
  // supabase/competitor-ads-enrich.sql hasn't been run. A missing follower count
  // is not worth throwing away five credits of freshly-fetched ads.
  console.log('note: advertiser-context columns missing — writing without them (run supabase/competitor-ads-enrich.sql to enable)')
  const trimmed = rows.map(({ page_like_count, page_categories, page_profile_uri, ...rest }) => rest)
  ;({ data, error } = await write(trimmed))
}
if (error || !data) { console.error('upsert failed:', error?.message); process.exit(1) }

const onTopic = ads.filter((a) => isRelevant(a, client.relevanceTerms, client.excludeTerms))
console.log(
  `\nstored ${data.length} ad(s) from ${new Set(ads.map((a) => a.page_name)).size} advertisers · ` +
    `${onTopic.length} on-topic (${Math.round((onTopic.length / ads.length) * 100)}%) · ${credits} credits spent`,
)
console.log('on-topic advertisers:', [...new Set(onTopic.map((a) => a.page_name))].slice(0, 10).join(' · '))
