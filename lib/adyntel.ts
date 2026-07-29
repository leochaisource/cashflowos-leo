// Adyntel → normalised competitor ads.
//
// WHAT THE API ACTUALLY RETURNS (verified against a captured raw response,
// data/adyntel-raw-latest.json, 27 ads):
//   • Top level: { number_of_ads, is_result_complete, continuation_token, results }
//   • `results` is an ARRAY OF ARRAYS — one inner array per collated ad group.
//   • Ad-level fields are snake_case: ad_archive_id, page_id, page_name,
//     is_active, start_date, end_date, publisher_platform, total_active_time.
//   • `snapshot.body` is { text } — PLAIN TEXT, not { markup: { __html } }.
//   • start_date / end_date are UNIX SECONDS (numbers), not ISO strings.
//   • total_active_time is present on only a minority of ads, so run length
//     MUST be derived from the dates, not from that field.
//
// Meta's own Ad Library uses camelCase (adArchiveID, startDate, body.markup.__html)
// and Adyntel's docs describe that shape, so every getter below accepts BOTH
// spellings. If Adyntel ever switches, this keeps working instead of silently
// returning empty strings — which is exactly the bug this module replaces.

export type MediaImage = { original_image_url: string | null; resized_image_url: string | null }
export type MediaVideo = {
  video_hd_url: string | null
  video_sd_url: string | null
  video_preview_image_url: string | null
}

export type NormalisedAd = {
  ad_archive_id: string
  ad_id: string | null
  page_id: string | null
  page_name: string
  is_active: boolean
  start_date: number | null // unix seconds
  end_date: number | null // unix seconds
  run_days: number | null // null === unknown
  run_days_basis: 'active' | 'ended' | 'unknown'
  publisher_platform: string[]
  collation_count: number | null
  display_format: string | null
  ad_creative_id: string | null
  creation_time: number | null
  title: string | null
  caption: string | null
  link_description: string | null
  cta_text: string | null
  cta_type: string | null
  link_url: string | null
  body_text: string // readable plain text
  body_html: string | null // original HTML when the API sends markup
  images: MediaImage[]
  videos: MediaVideo[]
  cards: Record<string, unknown>[]
  extra_images: unknown[]
  extra_videos: unknown[]
  extra_texts: unknown[]
  extra_links: unknown[]
  raw_payload: Record<string, unknown> // untouched, for debugging
}

type Obj = Record<string, unknown>

const ID_KEYS = ['ad_archive_id', 'adArchiveID', 'adArchiveId'] as const

/** First non-empty value among the given keys. Casing-agnostic by design. */
function pick(o: Obj | undefined, ...keys: string[]): unknown {
  if (!o) return undefined
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v))

/** Unix seconds from a number, a numeric string, or an ISO date. */
function unix(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? Math.round(v / 1000) : Math.round(v)
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.round(n / 1000) : Math.round(n)
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : Math.round(t / 1000)
}

function isAd(n: unknown): n is Obj {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return false
  return ID_KEYS.some((k) => (n as Obj)[k] !== undefined && (n as Obj)[k] !== null && (n as Obj)[k] !== '')
}

/**
 * Recursively flattens EVERY individual ad out of `results`, whatever the
 * nesting. Handles results[], results[][], and any deeper shape the API
 * invents later. An "ad" is any object carrying an archive id.
 */
export function flattenAds(json: unknown): Obj[] {
  const out: Obj[] = []
  const seen = new Set<unknown>()
  const walk = (n: unknown, depth = 0) => {
    if (depth > 12 || n === null || typeof n !== 'object') return
    if (seen.has(n)) return
    seen.add(n)
    if (Array.isArray(n)) {
      for (const v of n) walk(v, depth + 1)
      return
    }
    if (isAd(n)) {
      out.push(n as Obj)
      return // don't descend into snapshot looking for more ads
    }
    for (const v of Object.values(n as Obj)) walk(v, depth + 1)
  }
  walk((json as { results?: unknown })?.results ?? json)
  return out
}

/** Strips tags and decodes the handful of entities Meta actually emits. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * run_days, per the rule that matters:
 *   active   → today − start_date
 *   ended    → end_date − start_date
 *   no start → unknown (never 0, because 0 and "we don't know" are different)
 */
export function runDays(
  startUnix: number | null,
  endUnix: number | null,
  active: boolean,
  nowUnix = Math.floor(Date.now() / 1000),
): { run_days: number | null; run_days_basis: 'active' | 'ended' | 'unknown' } {
  if (startUnix === null) return { run_days: null, run_days_basis: 'unknown' }
  if (active) return { run_days: Math.max(0, Math.floor((nowUnix - startUnix) / 86400)), run_days_basis: 'active' }
  if (endUnix !== null) return { run_days: Math.max(0, Math.floor((endUnix - startUnix) / 86400)), run_days_basis: 'ended' }
  return { run_days: null, run_days_basis: 'unknown' }
}

export function normaliseAd(a: Obj, nowUnix = Math.floor(Date.now() / 1000)): NormalisedAd {
  const snap = ((pick(a, 'snapshot') as Obj) ?? {}) as Obj
  const bodyNode = (pick(snap, 'body') ?? {}) as Obj

  // body arrives as { text } from Adyntel and { markup: { __html } } from Meta.
  const markup = (pick(bodyNode, 'markup') as Obj) ?? {}
  const body_html = str(pick(markup, '__html'))
  const plain = str(pick(bodyNode, 'text'))
  const body_text = plain ?? (body_html ? htmlToText(body_html) : '')

  const start_date = unix(pick(a, 'start_date', 'startDate'))
  const end_date = unix(pick(a, 'end_date', 'endDate'))
  const is_active = pick(a, 'is_active', 'isActive') === true

  const platforms = pick(a, 'publisher_platform', 'publisherPlatform')

  const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])

  return {
    ad_archive_id: String(pick(a, ...ID_KEYS) ?? ''),
    ad_id: str(pick(a, 'ad_id', 'adid')),
    page_id: str(pick(a, 'page_id', 'pageID') ?? pick(snap, 'page_id', 'pageID')),
    page_name: String(pick(a, 'page_name', 'pageName') ?? pick(snap, 'page_name', 'pageName') ?? 'Unknown page'),
    is_active,
    start_date,
    end_date,
    ...runDays(start_date, end_date, is_active, nowUnix),
    publisher_platform: Array.isArray(platforms) ? platforms.map(String) : platforms ? [String(platforms)] : [],
    collation_count: Number.isFinite(Number(pick(a, 'collation_count', 'collationCount')))
      ? Number(pick(a, 'collation_count', 'collationCount'))
      : null,
    display_format: str(pick(snap, 'display_format', 'displayFormat')),
    ad_creative_id: str(pick(snap, 'ad_creative_id', 'adCreativeId')),
    creation_time: unix(pick(snap, 'creation_time', 'creationTime')),
    title: str(pick(snap, 'title')),
    caption: str(pick(snap, 'caption')),
    link_description: str(pick(snap, 'link_description', 'linkDescription')),
    cta_text: str(pick(snap, 'cta_text', 'ctaText')),
    cta_type: str(pick(snap, 'cta_type', 'ctaType')),
    link_url: str(pick(snap, 'link_url', 'linkUrl')),
    body_text,
    body_html,
    images: arr(pick(snap, 'images')).map((i) => ({
      original_image_url: str(pick(i, 'original_image_url', 'originalImageUrl')),
      resized_image_url: str(pick(i, 'resized_image_url', 'resizedImageUrl')),
    })),
    videos: arr(pick(snap, 'videos')).map((v) => ({
      video_hd_url: str(pick(v, 'video_hd_url', 'videoHdUrl')),
      video_sd_url: str(pick(v, 'video_sd_url', 'videoSdUrl')),
      video_preview_image_url: str(pick(v, 'video_preview_image_url', 'videoPreviewImageUrl')),
    })),
    cards: arr(pick(snap, 'cards')),
    extra_images: arr(pick(snap, 'extra_images', 'extraImages')),
    extra_videos: arr(pick(snap, 'extra_videos', 'extraVideos')),
    extra_texts: arr(pick(snap, 'extra_texts', 'extraTexts')),
    extra_links: Array.isArray(pick(snap, 'extra_links', 'extraLinks'))
      ? (pick(snap, 'extra_links', 'extraLinks') as unknown[])
      : [],
    raw_payload: a, // nothing is silently discarded
  }
}

// ---------------------------------------------------------------- analysis
// Kept here rather than inside the route so it can be replayed offline against
// a captured raw response, with no API call and no Telegram message.

export type PriorAd = {
  ad_archive_id: string
  competitor: string
  is_active: boolean
  title: string | null
  body_text: string | null
}

const flat = (s: string, n = 150) => s.replace(/\s+/g, ' ').trim().slice(0, n)

const seedOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 45)

/** A concept = one advertiser's reusable idea. Variations share it. */
export function conceptKey(a: NormalisedAd): string {
  return `${a.page_name}::${seedOf(a.title ?? a.body_text)}`
}

export function priorConceptKey(p: PriorAd): string {
  return `${p.competitor}::${seedOf(p.title ?? p.body_text ?? '')}`
}

export type CompetitorStats = {
  seen: number
  active: number
  advertisers: number
  concepts: number
  fresh: number
  new_concepts: number
  new_variations: number
  no_longer_listed: number
  turned_off: number
  running_7d: number
  running_30d: number
  data_quality: string[]
}

/**
 * fbcdn URLs are 400+ characters of signing parameters. The full URL is stored
 * in Supabase; the briefing only needs enough to identify the file, and a wall
 * of query strings actively degrades the model's read of the copy.
 */
function shortUrl(u: string | null): string {
  if (!u) return 'none'
  try {
    const { host, pathname } = new URL(u)
    const file = pathname.split('/').filter(Boolean).pop() ?? ''
    return `${host}/…/${file.slice(0, 40)}`
  } catch {
    return u.slice(0, 60)
  }
}

/** One concept = the reusable idea; the ads inside it are its creatives. */
export type Concept = {
  key: string
  advertiser: string
  ads: NormalisedAd[]
  lead: NormalisedAd // longest-running member, used as the representative
}

export function groupConcepts(ads: NormalisedAd[]): Concept[] {
  const by = new Map<string, NormalisedAd[]>()
  for (const a of ads) {
    const k = conceptKey(a)
    ;(by.get(k) ?? by.set(k, []).get(k)!).push(a)
  }
  return [...by.entries()]
    .map(([key, list]) => {
      const lead = [...list].sort((x, y) => (y.run_days ?? -1) - (x.run_days ?? -1))[0]
      return { key, advertiser: lead.page_name, ads: list, lead }
    })
    .sort((x, y) => (y.lead.run_days ?? -1) - (x.lead.run_days ?? -1))
}

export function describeConcept(c: Concept, localMedia: Record<string, string[]> = {}): string {
  const a = c.lead
  const runs = c.ads.map((x) => x.run_days).filter((d): d is number => d !== null)
  const span = runs.length === 0 ? 'run length unknown' : runs.length === 1 || Math.min(...runs) === Math.max(...runs) ? `${runs[0]}d` : `${Math.min(...runs)}–${Math.max(...runs)}d`
  const formats = [...new Set(c.ads.map((x) => x.display_format ?? '?'))].join('/')
  const media = a.videos.length
    ? `video ${shortUrl(a.videos[0].video_hd_url ?? a.videos[0].video_sd_url)}`
    : a.images.length
      ? `image ${shortUrl(a.images[0].original_image_url)}`
      : 'no media URL'
  const files = c.ads.flatMap((x) => localMedia[x.ad_archive_id] ?? []).map((f) => f.replace(/\\/g, '/'))
  return (
    `  · ${c.advertiser} [${formats}] · ${c.ads.length} live creative${c.ads.length > 1 ? 's' : ''} of this one idea · running ${span}\n` +
    `    headline: ${a.title ? flat(a.title, 90) : '(none)'}\n` +
    `    copy: ${flat(a.body_text, 260) || '(none)'}\n` +
    `    CTA: ${a.cta_text ?? '(none)'} → ${a.link_url ?? '(no landing URL)'}\n` +
    `    creative: ${media}` +
    (files.length ? `\n    saved locally: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` (+${files.length - 4} more)` : ''}` : '')
  )
}

/**
 * Everything the daily brief says about the market. Returns the text block that
 * goes to the model, plus the counts the route returns as JSON.
 *
 * Deliberately says "no longer appearing for these keywords" rather than
 * "stopped": an ad missing from a keyword search has not been proven dead.
 */
export function competitorSection(
  ads: NormalisedAd[],
  prior: PriorAd[],
  country: string,
  localMedia: Record<string, string[]> = {},
): { text: string; stats: CompetitorStats } {
  const priorById = new Map(prior.map((p) => [p.ad_archive_id, p]))
  const priorConcepts = new Set(prior.map(priorConceptKey))

  const active = ads.filter((a) => a.is_active)
  const fresh = ads.filter((a) => !priorById.has(a.ad_archive_id))

  // Group FIRST, then classify. Five creatives carrying the same headline are
  // one idea with five executions, not five ideas — reporting them as five
  // "new concepts" is the noisiest possible way to be technically correct.
  const concepts = groupConcepts(ads)
  const activeConcepts = groupConcepts(active)
  const freshConcepts = groupConcepts(fresh)
  const newConcepts = freshConcepts.filter((c) => !priorConcepts.has(c.key))
  const variationConcepts = freshConcepts.filter((c) => priorConcepts.has(c.key))
  const variationCount = variationConcepts.reduce((n, c) => n + c.ads.length, 0)

  const seenNow = new Set(ads.map((a) => a.ad_archive_id))
  const vanished = prior.filter((p) => p.is_active && !seenNow.has(p.ad_archive_id))
  const turnedOff = ads.filter((a) => !a.is_active && priorById.get(a.ad_archive_id)?.is_active)

  const d = (a: NormalisedAd) => a.run_days ?? -1
  const over7 = active.filter((a) => d(a) >= 7)
  const over30 = active.filter((a) => d(a) >= 30)
  const longest = activeConcepts.slice(0, 3)

  // A hook repeated across several DISTINCT advertisers is a market-wide
  // pattern; repeated by one advertiser it is just their rotation, already
  // captured by the creative count above.
  const hookPages = new Map<string, Set<string>>()
  for (const a of ads) {
    const h = flat(a.title ?? a.body_text, 60).toLowerCase()
    if (h) (hookPages.get(h) ?? hookPages.set(h, new Set()).get(h)!).add(a.page_name)
  }
  const repeated = [...hookPages.entries()]
    .filter(([, pages]) => pages.size > 1)
    .sort((x, y) => y[1].size - x[1].size)
    .slice(0, 5)

  const data_quality: string[] = []
  if (ads.length) {
    const noStart = ads.filter((a) => a.start_date === null).length
    const noCopy = ads.filter((a) => !a.body_text).length
    const noMedia = ads.filter((a) => !a.images.length && !a.videos.length).length
    const noSnap = ads.filter((a) => !a.raw_payload || !(a.raw_payload as Record<string, unknown>).snapshot).length
    if (noStart) data_quality.push(`${noStart} ad(s) have no start date — run length unknown, not zero`)
    if (noCopy) data_quality.push(`${noCopy} ad(s) returned no body copy`)
    if (noMedia) data_quality.push(`${noMedia} ad(s) returned no image or video URL`)
    if (noSnap) data_quality.push(`${noSnap} ad(s) returned no snapshot object`)
    if (!Object.keys(localMedia).length)
      data_quality.push('creative files were not downloaded on this run — URLs cited instead')
  }

  const text = [
    `COMPETITOR ADS IN ${country}`,
    `- ${active.length} active ads from ${new Set(ads.map((a) => a.page_name)).size} advertisers, carrying ${activeConcepts.length} distinct concepts (${ads.length} ads seen in total)`,
    `- new since last fetch: ${fresh.length} ad(s) — ${newConcepts.length} genuinely new concept(s), ${variationCount} fresh variation(s) of concepts already tracked`,
    `- no longer appearing for these keywords: ${vanished.length}; flipped to inactive: ${turnedOff.length}`,
    `- ads running 7+ days: ${over7.length} · 30+ days: ${over30.length}`,
    '',
    'LONGEST-RUNNING ACTIVE CONCEPTS:',
    ...longest.map((c) => describeConcept(c, localMedia)),
    '',
    newConcepts.length ? 'NEW CONCEPTS:' : 'NEW CONCEPTS: none since the last fetch',
    ...newConcepts.slice(0, 5).map((c) => describeConcept(c, localMedia)),
    variationConcepts.length
      ? `\nFRESH VARIATIONS OF CONCEPTS ALREADY TRACKED:\n` +
        variationConcepts
          .slice(0, 5)
          .map((c) => `  · ${c.advertiser}: ${c.ads.length} new execution(s) of "${flat(c.lead.title ?? c.lead.body_text, 60)}"`)
          .join('\n')
      : '',
    repeated.length ? '\nHOOKS USED BY MORE THAN ONE ADVERTISER:' : '',
    ...repeated.map(([h, pages]) => `  · ${pages.size} advertisers: "${h}"`),
    data_quality.length ? '\nDATA QUALITY: ' + data_quality.join(' | ') : '',
  ]
    .filter((l) => l !== '')
    .join('\n')

  return {
    text,
    stats: {
      seen: ads.length,
      active: active.length,
      advertisers: new Set(ads.map((a) => a.page_name)).size,
      concepts: activeConcepts.length,
      fresh: fresh.length,
      new_concepts: newConcepts.length,
      new_variations: variationCount,
      no_longer_listed: vanished.length,
      turned_off: turnedOff.length,
      running_7d: over7.length,
      running_30d: over30.length,
      data_quality,
    },
  }
}

/** Every media URL on an ad, in the priority order Phase 5 asks for. */
export function mediaUrls(ad: NormalisedAd): { images: string[]; videos: string[]; thumbs: string[] } {
  const cardImgs = ad.cards.map((c) => str(pick(c, 'original_image_url', 'resized_image_url'))).filter(Boolean) as string[]
  const cardVids = ad.cards.map((c) => str(pick(c, 'video_hd_url', 'video_sd_url'))).filter(Boolean) as string[]
  const cardThumbs = ad.cards.map((c) => str(pick(c, 'video_preview_image_url'))).filter(Boolean) as string[]
  return {
    images: [...ad.images.map((i) => i.original_image_url ?? i.resized_image_url).filter(Boolean), ...cardImgs] as string[],
    videos: [...ad.videos.map((v) => v.video_hd_url ?? v.video_sd_url).filter(Boolean), ...cardVids] as string[],
    thumbs: [...ad.videos.map((v) => v.video_preview_image_url).filter(Boolean), ...cardThumbs] as string[],
  }
}
