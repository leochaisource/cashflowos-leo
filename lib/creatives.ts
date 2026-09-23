import type { SupabaseClient } from '@supabase/supabase-js'

// Competitor creatives, kept.
//
// Meta's CDN URLs are SIGNED and expire (the `oe=` parameter — weeks, not
// months). The archive stores those URLs, so without this every card in the
// competitor library would fade to a broken image within a month of being
// found. This saves ONE thumbnail per ad into Supabase Storage at the moment the
// ad is first seen, while its URL still works.
//
// One thumbnail, never the video: the still is what identifies a creative when
// scanning a library, a video is 1-20 MB against a 1 GB free tier, and the
// permanent Meta Ad Library link opens the real thing anyway.
//
// Takes the Supabase client as a PARAMETER rather than importing lib/supabase.ts
// (which is server-only): the backfill script has to run exactly this code, and
// two copies of a download guard is how one of them ends up saving an HTML error
// page as a JPEG.

export const CREATIVES_BUCKET = 'competitor-creatives'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export type FetchedMedia =
  | { ok: true; bytes: Uint8Array; contentType: string; ext: string }
  | { ok: false; reason: string; expired: boolean }

const extFor = (ct: string) =>
  ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg'

/**
 * Download one image, refusing anything that is not actually an image.
 *
 * Lifted from scripts/adyntel-fetch-creatives.ts, whose guards were learned the
 * hard way: an expired fbcdn URL often answers with an HTML error body and a
 * success-shaped response, so "the request worked" is not evidence the bytes
 * are a picture. Three checks — status, content-type, and a sniff of the first
 * bytes — plus a floor on size, because a 200-byte "image" is a tracking pixel
 * or an error, never a creative.
 *
 * `expired` marks the refusals that mean "this URL is dead", so a backfill can
 * stop walking into ever-older ads once it hits a run of them.
 */
export async function fetchMedia(url: string, timeoutMs = 8000): Promise<FetchedMedia> {
  try {
    const res = await fetch(url, {
      redirect: 'follow', // fbcdn 302s to a regional edge
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, expired: res.status === 403 || res.status === 404 || res.status === 410 }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('text/html') || ct.includes('application/json'))
      return { ok: false, reason: `server returned ${ct}, not an image`, expired: true }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 16)).toLowerCase()
    if (head.startsWith('<!doctype') || head.startsWith('<html'))
      return { ok: false, reason: 'body is HTML despite the content-type', expired: true }
    if (bytes.length < 512) return { ok: false, reason: `only ${bytes.length} bytes`, expired: true }
    if (ct && !ct.startsWith('image/')) return { ok: false, reason: `not an image (${ct})`, expired: false }
    return { ok: true, bytes, contentType: ct || 'image/jpeg', ext: extFor(ct) }
  } catch (e) {
    return { ok: false, reason: (e as Error).message, expired: false }
  }
}

export type ThumbCandidate = {
  ad_archive_id: string
  /** Best still first: a video's preview frame, then the ad's images. */
  urls: string[]
}

export type ThumbResult = {
  saved: number
  skipped: number
  failed: number
  expired: number
  /** The bucket does not exist — supabase/competitor-archive.sql has not been run. */
  bucketMissing: boolean
}

/** Where an ad's thumbnail lives in the bucket. Stable, so a re-run overwrites. */
export const creativePath = (clientId: string, adArchiveId: string, ext: string) =>
  `${clientId}/${adArchiveId}.${ext}`

/**
 * Save one thumbnail per ad and record it on the ad's row (`local_media`).
 *
 * Bounded twice — `max` ads per call and `concurrency` downloads in flight —
 * because this runs inside the 8am cron, which has 300 seconds on Vercel Hobby
 * for every client combined and whose real job is the brief. Never throws: a
 * creative that cannot be saved is a missing picture, not a failed morning.
 */
export async function persistThumbnails(
  db: SupabaseClient,
  clientId: string,
  candidates: ThumbCandidate[],
  opts: { max?: number; concurrency?: number; timeoutMs?: number } = {},
): Promise<ThumbResult> {
  const max = opts.max ?? 30
  const concurrency = opts.concurrency ?? 6
  const timeoutMs = opts.timeoutMs ?? 6000
  const queue = candidates.filter((c) => c.urls.length).slice(0, max)
  const out: ThumbResult = { saved: 0, skipped: candidates.length - queue.length, failed: 0, expired: 0, bucketMissing: false }

  const one = async (c: ThumbCandidate) => {
    // Try each URL in turn: a carousel's first card can be dead while its
    // second still loads.
    let got: FetchedMedia | null = null
    for (const url of c.urls.slice(0, 3)) {
      got = await fetchMedia(url, timeoutMs)
      if (got.ok) break
    }
    if (!got || !got.ok) {
      if (got && !got.ok && got.expired) out.expired++
      else out.failed++
      return
    }
    const path = creativePath(clientId, c.ad_archive_id, got.ext)
    const up = await db.storage
      .from(CREATIVES_BUCKET)
      .upload(path, got.bytes, { contentType: got.contentType, upsert: true })
    if (up.error) {
      if (/bucket not found|not found/i.test(up.error.message)) out.bucketMissing = true
      out.failed++
      return
    }
    const { error } = await db
      .from('competitor_ads')
      .update({
        local_media: [
          { kind: 'thumb', path, content_type: got.contentType, bytes: got.bytes.length, fetched_at: new Date().toISOString() },
        ],
      })
      .eq('client', clientId)
      .eq('ad_archive_id', c.ad_archive_id)
    if (error) out.failed++
    else out.saved++
  }

  for (let i = 0; i < queue.length; i += concurrency) {
    await Promise.all(queue.slice(i, i + concurrency).map(one))
  }
  return out
}

/** The public URL of a stored thumbnail. Synchronous — the bucket is public. */
export const publicThumbUrl = (db: SupabaseClient, path: string) =>
  db.storage.from(CREATIVES_BUCKET).getPublicUrl(path).data.publicUrl
