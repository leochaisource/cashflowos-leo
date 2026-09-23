// Save thumbnails for competitor ads that were stored BEFORE the cron started
// keeping creatives.
//
//   node --env-file-if-exists=.env scripts/creatives-backfill.ts --client=claude-malaysia
//   ... --limit=300        stop after this many ads (default 400)
//   ... --all              include off-topic ads too (default: on-topic only)
//
// URGENT THE FIRST TIME: Meta's CDN URLs are signed and expire within weeks, so
// every day this waits, more of the existing archive's images die for good.
// Walks newest first — the newest URLs are the likeliest still to load — and
// stops after a run of expired URLs, because everything older than a dead link
// is almost certainly dead too.
//
// Uses lib/creatives.ts, the same code the cron runs, so a backfilled thumbnail
// is indistinguishable from one saved on the morning the ad was found.
// Safe to re-run: ads that already have a saved thumbnail are skipped.
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { persistThumbnails, type ThumbCandidate } from '../lib/creatives.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const ID = arg('client')
const LIMIT = Math.max(1, Number(arg('limit') ?? 400))
const ALL = process.argv.includes('--all')
const STOP_AFTER_EXPIRED = 15

const client = AD_CLIENTS.find((c) => c.id === ID)
if (!client) {
  console.error(`--client must be one of: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)

type Row = { ad_archive_id: string; thumbnail_urls: string[]; image_urls: string[]; local_media: unknown[] | null }

// Newest first, only rows with no saved thumbnail yet, paged under the
// 1,000-row response cap.
const pending: Row[] = []
for (let from = 0; pending.length < LIMIT; from += 1000) {
  let q = db
    .from('competitor_ads')
    .select('ad_archive_id, thumbnail_urls, image_urls, local_media')
    .eq('client', client.id)
    .eq('local_media', '[]')
    .order('first_seen_at', { ascending: false })
    .range(from, from + 999)
  if (!ALL) q = q.eq('on_topic', true)
  const { data, error } = await q
  if (error) {
    console.error(`✗ ${error.message}`)
    if (/on_topic/.test(error.message)) console.error('  → run supabase/competitor-archive.sql, then scripts/adyntel-rescore.ts --write first.')
    process.exit(1)
  }
  pending.push(...((data ?? []) as Row[]))
  if (!data || data.length < 1000) break
}

const queue: ThumbCandidate[] = pending
  .slice(0, LIMIT)
  .map((r) => ({ ad_archive_id: r.ad_archive_id, urls: [...(r.thumbnail_urls ?? []), ...(r.image_urls ?? [])] }))
  .filter((c) => c.urls.length)

console.log(
  `${client.name}: ${queue.length} ad(s) without a saved thumbnail${ALL ? '' : ' (on-topic only)'}, newest first`,
)

// In batches of 20, so a long run of dead links can stop the walk early.
const total = { saved: 0, expired: 0, failed: 0 }
let expiredRun = 0
for (let i = 0; i < queue.length; i += 20) {
  const batch = queue.slice(i, i + 20)
  const r = await persistThumbnails(db, client.id, batch, { max: 20, concurrency: 5, timeoutMs: 10000 })
  if (r.bucketMissing) {
    console.error('✗ the competitor-creatives bucket does not exist — run supabase/competitor-archive.sql first.')
    process.exit(1)
  }
  total.saved += r.saved
  total.expired += r.expired
  total.failed += r.failed
  expiredRun = r.saved === 0 ? expiredRun + r.expired : 0
  console.log(`  ${String(i + batch.length).padStart(4)}/${queue.length}  saved ${r.saved} · expired ${r.expired} · failed ${r.failed}`)
  if (expiredRun >= STOP_AFTER_EXPIRED) {
    console.log(`  stopping: ${expiredRun} expired in a row — older URLs are past Meta's expiry.`)
    break
  }
}

console.log(`\n${total.saved} thumbnail(s) saved · ${total.expired} already expired · ${total.failed} failed`)
