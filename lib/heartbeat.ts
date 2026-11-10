import type { SupabaseClient } from '@supabase/supabase-js'

// HEARTBEATS (owner, 2026-11-10): proof that a job driven by an outside clock ran.
//
// The hot leads sheet's Apps Script fires /api/hotleads-sync five times a day and
// /api/hotlist-tick every hour. Each route already tells the owner when a run FAILS.
// What nobody would notice is the clock stopping: a trigger deleted, or Google
// dropping the script's authorisation. Then nothing fails, because nothing runs.
//
// So each run drops a beat here, ok or not, and the 9am watchdog (lib/watchdog.ts)
// checks how long ago the last one was. State: cfo-cache `heartbeat/<job>.json`,
// the last KEEP beats. Read-modify-write: two runs landing in the same second can
// lose one beat, which is harmless for a "when did it last run?" check.
//
// Shared with scripts/watchdog.ts, so explicit-extension imports only and the
// Supabase client comes in as a parameter.

const BUCKET = 'cfo-cache'
const KEEP = 50

export type Beat = { at: string; ok: boolean; error?: string }

const path = (job: string) => `heartbeat/${job}.json`

/** The stored beats, newest last. null = this job has never reported (not tracked yet). */
export async function readBeats(db: SupabaseClient, job: string): Promise<Beat[] | null> {
  const { data, error } = await db.storage.from(BUCKET).download(path(job))
  if (error || !data) return null
  try {
    const parsed = JSON.parse(await data.text()) as { beats?: Beat[] }
    return Array.isArray(parsed.beats) ? parsed.beats : null
  } catch {
    return null
  }
}

/** Record one run. Never throws: a heartbeat must never cost the job it records. */
export async function beat(db: SupabaseClient, job: string, ok: boolean, error?: string): Promise<void> {
  try {
    const beats = (await readBeats(db, job)) ?? []
    beats.push({ at: new Date().toISOString(), ok, ...(error ? { error: String(error).slice(0, 300) } : {}) })
    await db.storage
      .from(BUCKET)
      .upload(path(job), JSON.stringify({ job, beats: beats.slice(-KEEP) }), { upsert: true, contentType: 'application/json' })
  } catch (e) {
    console.error(`[CFO] heartbeat ${job} not recorded:`, (e as Error).message)
  }
}
