// THE WATCHDOG from the laptop (owner, 2026-11-10). A dry run: it reads
// everything the 9am check reads and prints what the 9am message would carry,
// but retries nothing, sends nothing and writes nothing.
//
//   node --env-file-if-exists=.env --env-file-if-exists=../.env scripts/watchdog.ts            this morning's section
//   ... scripts/watchdog.ts --monday     also show the Monday "still alive" line
//   ... scripts/watchdog.ts --json       the full report
//   ... scripts/watchdog.ts --at=2026-11-08T09:30:00+08:00   replay a past morning (today's data, that day's clock:
//                                        the brief check is exact; checks of live state, such as Meta sync, read now)
//
// The real run is part of /api/cron-daily (lib/watchdog.ts).
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { runWatchdog, watchdogSection, weekSummary } from '../lib/watchdog.ts'

const has = (k: string) => process.argv.includes(`--${k}`)
const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) throw new Error('SUPABASE_URL is missing or a placeholder: run with --env-file pointing at the real .env')
const db = createClient(url, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(), { auth: { persistSession: false } })

// focusProjects() lives in a server-only file; this is the same rule (ranked, not demo, top 4).
const focus = AD_CLIENTS.filter((c) => typeof c.rank === 'number' && !c.demo)
  .sort((a, b) => (a.rank as number) - (b.rank as number))
  .slice(0, 4)

const at = process.argv.find((a) => a.startsWith('--at='))?.slice(5)
const now = at ? new Date(at) : undefined
if (now && Number.isNaN(now.getTime())) throw new Error(`--at is not a date: ${at}`)
const report = await runWatchdog({ db, focus, now })
const week = has('monday') && !report.problems.length && !report.fixed.length ? await weekSummary(db, report.day) : null
const section = watchdogSection(report, { week })
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

console.log(`Focus: ${focus.map((c) => c.id).join(', ')}\n`)
console.log(section ? plain(section) : '(nothing wrong: the 9am message would carry no watchdog section)')
console.log('\nChecks:')
for (const c of report.checks) console.log(`  ${c.status.padEnd(8)} ${c.name}${c.detail ? `: ${c.detail}` : ''}`)
if (report.wouldRetry.length) console.log(`\nA real run would retry: ${report.wouldRetry.join('; ')}`)
if (has('json')) console.log(`\n${JSON.stringify(report, null, 2)}`)
