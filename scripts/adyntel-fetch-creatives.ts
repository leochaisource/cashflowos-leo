// Offline w.r.t. Adyntel — this only fetches media from Meta's CDN.
// Run: node scripts/adyntel-fetch-creatives.ts [limit]
//
// Refuses to save an HTML error page as an image or a video: fbcdn URLs are
// signed and expire, and an expired one returns a 403 HTML body with a 200-ish
// shape often enough that "the file exists" is not evidence it is a picture.
import fs from 'node:fs'
import path from 'node:path'
import { mediaUrls } from '../lib/adyntel.ts'
import type { NormalisedAd } from '../lib/adyntel.ts'

const LIMIT = Number(process.argv[2] ?? 5)
const ROOT = 'data/competitor-creatives'
const DIRS = { images: `${ROOT}/images`, videos: `${ROOT}/videos`, thumbnails: `${ROOT}/thumbnails` }
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true })

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

type Rec = {
  ad_archive_id: string
  competitor: string
  kind: 'image' | 'video' | 'thumbnail'
  url_host: string
  status: number | string
  content_type: string | null
  bytes: number
  file: string | null
  ok: boolean
  reason?: string
}

const extFor = (ct: string | null, kind: string) => {
  if (ct?.includes('jpeg')) return '.jpg'
  if (ct?.includes('png')) return '.png'
  if (ct?.includes('webp')) return '.webp'
  if (ct?.includes('gif')) return '.gif'
  if (ct?.includes('mp4')) return '.mp4'
  if (ct?.includes('video')) return '.mp4'
  return kind === 'video' ? '.mp4' : '.jpg'
}

async function grab(url: string, kind: Rec['kind'], ad: NormalisedAd, idx: number): Promise<Rec> {
  const base: Rec = {
    ad_archive_id: ad.ad_archive_id,
    competitor: ad.page_name,
    kind,
    url_host: (() => { try { return new URL(url).host } catch { return 'invalid-url' } })(),
    status: 'n/a',
    content_type: null,
    bytes: 0,
    file: null,
    ok: false,
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow', // fbcdn 302s to a regional edge
      headers: { 'User-Agent': UA, Accept: kind === 'video' ? 'video/*,*/*' : 'image/avif,image/webp,image/*,*/*' },
      signal: AbortSignal.timeout(90000),
    })
    base.status = res.status
    base.content_type = res.headers.get('content-type')
    if (!res.ok) return { ...base, reason: `HTTP ${res.status}` }

    const ct = base.content_type ?? ''
    if (ct.includes('text/html') || ct.includes('application/json')) {
      return { ...base, reason: `refused: server returned ${ct}, not media` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    base.bytes = buf.length
    // Second guard: sniff the bytes. An HTML body mislabelled as an image is
    // still an HTML body.
    const head = buf.subarray(0, 16).toString('latin1').toLowerCase()
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      return { ...base, reason: 'refused: body is HTML despite content-type' }
    }
    if (buf.length < 512) return { ...base, reason: `refused: only ${buf.length} bytes` }

    const dir = kind === 'image' ? DIRS.images : kind === 'video' ? DIRS.videos : DIRS.thumbnails
    const file = path.join(dir, `${ad.ad_archive_id}-${idx}${extFor(base.content_type, kind)}`)
    fs.writeFileSync(file, buf)
    return { ...base, file, ok: true }
  } catch (e) {
    return { ...base, status: 'error', reason: (e as Error).message }
  }
}

const { ads } = JSON.parse(fs.readFileSync('data/adyntel-ads-normalised.json', 'utf8')) as { ads: NormalisedAd[] }
const withMedia = ads.filter((a) => {
  const m = mediaUrls(a)
  return m.images.length > 0 || m.videos.length > 0
})
// --video moves ads that actually carry video to the front, so the video path
// (different URL signing, different failure modes) gets exercised too.
const chosen = process.argv.includes('--video')
  ? [...withMedia].sort((a, b) => mediaUrls(b).videos.length - mediaUrls(a).videos.length).slice(0, LIMIT)
  : withMedia.slice(0, LIMIT)

console.log(`ads with at least one media URL: ${withMedia.length} / ${ads.length}`)
console.log(`downloading the first ${chosen.length}\n`)

const records: Rec[] = []
for (const ad of chosen) {
  const m = mediaUrls(ad)
  console.log(`— ${ad.ad_archive_id}  ${ad.page_name}  [${ad.display_format}]`)
  let i = 0
  for (const u of m.images.slice(0, 3)) records.push(await grab(u, 'image', ad, i++))
  i = 0
  for (const u of m.videos.slice(0, 2)) records.push(await grab(u, 'video', ad, i++))
  i = 0
  for (const u of m.thumbs.slice(0, 2)) records.push(await grab(u, 'thumbnail', ad, i++))
  for (const r of records.filter((r) => r.ad_archive_id === ad.ad_archive_id))
    console.log(
      `   ${r.ok ? 'OK ' : 'FAIL'} ${r.kind.padEnd(9)} ${String(r.status).padEnd(6)} ${(r.content_type ?? '-').padEnd(12)} ` +
        `${r.bytes ? (r.bytes / 1024).toFixed(0) + 'KB' : ''} ${r.file ? path.basename(r.file) : r.reason ?? ''}`,
    )
}

// Merge with any previous run so a targeted second pass doesn't erase the first.
const prev: Rec[] = fs.existsSync(`${ROOT}/manifest.json`)
  ? (JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8')).records as Rec[])
  : []
const merged = [...prev.filter((p) => !records.some((r) => r.ad_archive_id === p.ad_archive_id && r.kind === p.kind)), ...records]
fs.writeFileSync(`${ROOT}/manifest.json`, JSON.stringify({ fetched_at: new Date().toISOString(), records: merged }, null, 2))
const ok = records.filter((r) => r.ok)
console.log(`\ndownloaded ${ok.length} / ${records.length} files`)
console.log(`  images ${ok.filter((r) => r.kind === 'image').length} · videos ${ok.filter((r) => r.kind === 'video').length} · thumbnails ${ok.filter((r) => r.kind === 'thumbnail').length}`)
for (const f of records.filter((r) => !r.ok)) console.log(`  FAILED ${f.kind} ${f.ad_archive_id}: ${f.reason}`)
console.log(`manifest → ${ROOT}/manifest.json`)
