// Print the client part of tomorrow's 9am Today message, from live data, without
// sending anything or closing any to-do (lib/progress.ts, the same code the cron runs).
//
//   node --env-file=.env scripts/today-preview.ts
//   ... --since=2026-11-09T01:00:00Z   progress since this instant (default: since the last Today message)
//   ... --client=starcity-global      also print that client's 8am brief lines

import { createClient } from '@supabase/supabase-js'
import { loadDigest, expireStaleTodos, renderTodaySection, renderClientLines } from '../lib/progress.ts'
import { trackingNotes } from '../lib/progress-sort.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const digest = await loadDigest(db, { since: arg('since') })
const wouldExpire = await expireStaleTodos(db, digest.tasks, { dry: true })
const notes = await trackingNotes(db, digest.since)
if (wouldExpire.length) notes.push(`Would close ${wouldExpire.length} old Claude to-do(s) (no date, untouched for 28 days).`)

console.log(`since ${digest.since} · ${digest.clientIds.length} clients · ${digest.clients.length} with something today\n`)
console.log(renderTodaySection(digest, { notes }).replace(/<[^>]+>/g, ''))
const one = arg('client')
if (one) {
  console.log(`\n--- 8am brief lines for ${one} ---`)
  console.log(renderClientLines(digest.clients.find((c) => c.client.id === one), digest.today) ?? '(nothing for this client)')
}
