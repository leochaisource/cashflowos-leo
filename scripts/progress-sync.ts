// CLIENT PROGRESS — the laptop half (owner, 2026-11-10).
//
// claude-mem writes a summary of every Claude Code session into its local
// database. This reads the last week of them (read-only) and posts them to the
// dashboard, which sorts each session to a client, logs what got done and adds
// the to-dos (app/api/progress → lib/progress-sort.ts). Sending the whole week
// every time is deliberate: the server skips what it has already sorted, so a
// laptop that was off for days loses nothing.
//
//   node --env-file=.env scripts/progress-sync.ts            post (production)
//   ... --print        list what would be sent; no network
//   ... --dry          the server sorts and answers, writes nothing
//   ... --flush        don't wait for a session to go quiet for an hour
//   ... --days=7       how far back to read
//   ... --local        post to http://localhost:3007 instead (next dev)
//   ... --todos-from=3 to-dos only from chunks this many days old (backfill)
//   ... --sessions=a,b only these session ids (prefixes), for testing
//
// Run every 30 minutes by Windows Task Scheduler ("SpeakFunnels progress sync",
// see docs/progress-sync.md). It never prints the secret, keeps a short log in
// %LOCALAPPDATA%\SpeakFunnels\progress-sync.log, and always exits 0 so the task
// never shows as failing for a passing problem (the 9am message reports a
// laptop that hasn't synced for two days).

import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const has = (k: string) => process.argv.includes(`--${k}`)
const DAYS = Number(arg('days') ?? 7)
const PRINT = has('print')
const BASE = has('local') ? 'http://localhost:3007' : (process.env.APP_URL?.trim() || 'https://cashflowos-leo.vercel.app').replace(/\/+$/, '')

const MEM_DIR = join(homedir(), '.claude-mem')
const DB_PATH = join(MEM_DIR, 'claude-mem.db')
const LOG_DIR = join(process.env.LOCALAPPDATA || homedir(), 'SpeakFunnels')
const LOG = join(LOG_DIR, 'progress-sync.log')

function log(line: string) {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, text + '\n')
  } catch {
    /* a log that can't be written must not stop the sync */
  }
}

type Row = {
  memory_session_id: string
  project: string | null
  request: string | null
  completed: string | null
  next_steps: string | null
  notes: string | null
  created_at_epoch: number
}

/** The database is in WAL mode and claude-mem's worker writes to it; a busy read is retried. */
async function readSummaries(): Promise<Row[]> {
  const since = Date.now() - DAYS * 86_400_000
  for (let attempt = 1; ; attempt++) {
    try {
      const db = new DatabaseSync(DB_PATH, { readOnly: true })
      try {
        return db
          .prepare(
            `select memory_session_id, project, request, completed, next_steps, notes, created_at_epoch
             from session_summaries where created_at_epoch >= ? order by created_at_epoch`,
          )
          .all(since) as unknown as Row[]
      } finally {
        db.close()
      }
    } catch (e) {
      if (attempt >= 3 || !/busy|locked/i.test((e as Error).message)) throw e
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

async function main() {
  if (!existsSync(DB_PATH)) return log(`no claude-mem database at ${DB_PATH} — nothing to send`)
  const only = arg('sessions')?.split(',').filter(Boolean)
  const rows = (await readSummaries())
    .filter((r) => r.memory_session_id && (r.project ?? '').toLowerCase() !== 'jobhunt')
    .filter((r) => !only || only.some((p) => r.memory_session_id.startsWith(p)))
  const items = rows.map((r) => ({
    ref: `mem:${r.memory_session_id}:${r.created_at_epoch}`,
    session: r.memory_session_id,
    at: new Date(r.created_at_epoch).toISOString(),
    project: r.project ?? undefined,
    request: r.request ?? '',
    completed: r.completed ?? '',
    next_steps: r.next_steps ?? '',
    notes: r.notes ?? '',
  }))
  const newest = rows.length ? new Date(rows[rows.length - 1].created_at_epoch).toISOString() : null
  // claude-mem leaves this file when its worker dies; it's only news if it's newer than the last summary.
  const brokenFile = join(MEM_DIR, 'CAPTURE_BROKEN')
  const captureBroken = existsSync(brokenFile) && (!newest || statSync(brokenFile).mtimeMs > Date.parse(newest))

  if (PRINT) {
    const sessions = new Map<string, number>()
    for (const i of items) sessions.set(i.session, (sessions.get(i.session) ?? 0) + 1)
    console.log(`${items.length} summaries from ${sessions.size} sessions in the last ${DAYS} days · newest ${newest ?? '—'} · capture ${captureBroken ? 'BROKEN' : 'ok'}`)
    for (const [s, n] of sessions) console.log(`  ${s}  ${n} chunk(s)`)
    return
  }

  const secret = process.env.PROGRESS_SECRET?.trim()
  if (!secret) return log('PROGRESS_SECRET is not set in .env — nothing sent')
  const q = new URLSearchParams()
  if (has('dry')) q.set('dry', '1')
  if (has('flush')) q.set('flush', '1')
  if (arg('todos-from')) q.set('todosFromDays', String(Number(arg('todos-from'))))
  if (arg('model')) q.set('model', arg('model')!) // dry runs only, server-side checked
  const url = `${BASE}/api/progress${q.size ? `?${q}` : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ items, health: { captureBroken, newestAt: newest } }),
    signal: AbortSignal.timeout(290_000),
  })
  const body = (await res.json().catch(() => null)) as Record<string, any> | null
  if (!res.ok || !body) return log(`server answered ${res.status} — will retry next run`)
  const sorted = (body.sessions ?? []) as { status: string; client: string | null; lines: number; todos: string[]; ticked: string[]; note?: string }[]
  const summary = sorted.map((s) => `${s.status}:${s.client ?? '-'}(+${s.lines} done, +${s.todos?.length ?? 0} to-do${s.ticked?.length ? `, ✓${s.ticked.length}` : ''})`).join(' ')
  log(
    `${has('dry') ? 'DRY ' : ''}sent ${body.received ?? items.length} · new ${body.fresh ?? 0} · waiting ${body.waiting ?? 0} · ` +
      `${body.ok ? 'ok' : `error: ${String(body.error ?? '').slice(0, 160)}`}${summary ? ` · ${summary}` : ''}`,
  )
  if (has('dry') || has('verbose')) console.log(JSON.stringify(body, null, 2))
}

main().catch((e) => log(`failed: ${(e as Error).message.slice(0, 200)}`))
