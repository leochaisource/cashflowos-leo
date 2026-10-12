import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'

// THE BUYING-INTENT VERDICT CACHE (cost pass, owner 2026-10-12).
//
// The same WhatsApp chats were judged up to four times a day: by the 9am,
// 12pm and 6pm hot-leads refresh (each re-judging ALL of today's chats) and by
// the 8am run (all of yesterday's). A chat nobody wrote in since the last run
// gets the same verdict, so it isn't sent to the model again.
//
// Key = a fingerprint of exactly what the model would read for that chat (its
// transcript, the product line, the prompt version): any new message, a new
// event date or a changed prompt makes a new key, so a stale verdict can't be
// reused. Kept in a PRIVATE Supabase Storage bucket (verdicts quote leads),
// one JSON file per project, entries older than 3 days dropped on write.

const BUCKET = 'cfo-cache'
const KEEP_MS = 3 * 864e5

export type CachedVerdict = {
  intent: 'hot' | 'warm' | 'cold' | 'not_a_lead'
  reason: string
  next: string
  interest: string | null
  objection: string | null
  event: string | null
}
type Entry = { v: CachedVerdict; at: string }
export type IntentCache = Map<string, Entry>

export const verdictKey = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)

const path = (project: string) => `intent/${project}.json`

export async function loadIntentCache(db: SupabaseClient, project: string): Promise<IntentCache> {
  const { data, error } = await db.storage.from(BUCKET).download(path(project))
  if (error || !data) return new Map() // first run, or no bucket yet — judge everything
  try {
    const obj = JSON.parse(await data.text()) as Record<string, Entry>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

export async function saveIntentCache(db: SupabaseClient, project: string, cache: IntentCache): Promise<void> {
  const cutoff = Date.now() - KEEP_MS
  const obj: Record<string, Entry> = {}
  for (const [k, e] of cache) if (Date.parse(e.at) >= cutoff) obj[k] = e
  const body = JSON.stringify(obj)
  const put = () => db.storage.from(BUCKET).upload(path(project), body, { upsert: true, contentType: 'application/json' })
  let { error } = await put()
  if (error && /bucket/i.test(error.message)) {
    await db.storage.createBucket(BUCKET, { public: false })
    ;({ error } = await put())
  }
  if (error) throw new Error(`intent cache not saved: ${error.message}`)
}
