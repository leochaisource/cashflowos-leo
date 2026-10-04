// 📬💼 Inbox digest + job shortlist — runs on YOUR laptop. Pure Node, no extra installs.
// Works the SAME on Mac, Windows PowerShell and Linux.
//
// Reads TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// from your .env (via --env-file-if-exists) and talks to Telegram + your database
// directly — no server route, no extra password.
//
//   npm run inbox -- check                          is everything connected?
//   npm run inbox -- digest .inbox/digest.json      post the weekly digest to your Telegram
//   npm run inbox -- shortlist .inbox/jobs.json     one ✅/❌ card per job
//   npm run inbox -- approved                       jobs you ✅'d that aren't applied yet (JSON)
//   npm run inbox -- result <id> <outcome> "note"   applied | needs_you | failed | skipped
//
// Called by the /inbox-digest (Saturday) and /apply-jobs (Sunday) commands. Never prints
// a secret. Never reads, sends or deletes email — that's the command's job, read-only.
// Tapping ✅ on a job card goes to your normal Jarvis webhook, which only QUEUES it.

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// Same forgiving clean-up as lib/supabase.ts + scripts/import.mjs.
const SB_URL = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, '')
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
const OWNER = (process.env.OWNER_CHAT_ID ?? '').trim()

const MAX_CHUNKS = 10
const MAX_JOBS = 15
const JOB_EXPIRES_H = 7 * 24
const nowISO = () => new Date().toISOString()
const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WHERE = {
  TELEGRAM_BOT_TOKEN: 'Telegram → @BotFather → /mybots → your bot → API Token',
  OWNER_CHAT_ID: 'Telegram → @userinfobot → your numeric Id',
  SUPABASE_URL: 'Supabase → Project Settings → Data API → Project URL (base URL only)',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase → Project Settings → API Keys → service_role → Reveal',
}
const present = {
  TELEGRAM_BOT_TOKEN: !!TG_TOKEN && !/your-bot-token/i.test(TG_TOKEN),
  OWNER_CHAT_ID: /^-?\d+$/.test(OWNER),
  SUPABASE_URL: !!SB_URL && !/YOUR-PROJECT|placeholder/i.test(SB_URL),
  SUPABASE_SERVICE_ROLE_KEY: !!SB_KEY && !/placeholder|your-service_role/i.test(SB_KEY),
}

function fail(msg) {
  console.error(`\n⚠️  ${msg}\n`)
  process.exit(1)
}
function needAll() {
  const missing = Object.keys(present).filter((k) => !present[k])
  if (missing.length) {
    fail(
      `Missing in your .env: ${missing.join(', ')}\n` +
        missing.map((k) => `   • ${k}: ${WHERE[k]}`).join('\n') +
        '\n   Add them, save the file, and run this again. Nothing was sent.',
    )
  }
}

// ---- Telegram (HTML parse mode, same as the app) -------------------------
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function tg(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) return { ok: false, error: body.description || `HTTP ${res.status}` }
    return { ok: true, result: body.result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

const sendText = (text, keyboard) =>
  tg('sendMessage', {
    chat_id: OWNER,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })

// ---- Supabase REST -------------------------------------------------------
async function sb(method, table, { query, body, prefer } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : ''
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new Error(`database said HTTP ${res.status}: ${data?.message || text.slice(0, 200)}`)
  return data
}

// One line in the Activity feed (same shape as lib/runs.ts). Never fails the command.
async function logRun(agentKey, outcome, detail = {}) {
  try {
    await sb('POST', 'agent_runs', {
      body: { agent_key: agentKey, started_at: nowISO(), finished_at: nowISO(), outcome, detail },
      prefer: 'return=minimal',
    })
  } catch (e) {
    console.warn(`(couldn't write the activity log: ${e.message})`)
  }
}

// Insert once per idempotency_key (same as propose()/runAutopilot in lib/actions.ts).
// Returns the new row, or null if that key already exists.
async function insertOnce(row) {
  const data = await sb('POST', 'agent_actions', {
    query: { on_conflict: 'idempotency_key' },
    body: row,
    prefer: 'resolution=ignore-duplicates,return=representation',
  })
  return data?.[0] ?? null
}

const patchAction = (filters, body) =>
  sb('PATCH', 'agent_actions', { query: filters, body, prefer: 'return=representation' })

function readJson(path) {
  if (!path) fail('Give me the JSON file to send, e.g.  npm run inbox -- digest .inbox/digest.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(`Couldn't read ${path}: ${e.message}`)
  }
}

// Pack blocks into messages of at most `max` chars without splitting a block (unless a
// single block is longer than `max` — then it's split at line breaks).
function chunkMessage(blocks, max = 3800) {
  const out = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const b of blocks) {
    if (b.length > max) {
      flush()
      for (const line of b.split('\n')) {
        const piece = line.length > max ? line.slice(0, max - 1) + '…' : line
        if (cur && cur.length + 1 + piece.length > max) flush()
        cur = cur ? `${cur}\n${piece}` : piece
      }
      flush()
      continue
    }
    if (cur && cur.length + 2 + b.length > max) flush()
    cur = cur ? `${cur}\n\n${b}` : b
  }
  flush()
  return out
}

// ==========================================================================
// check
// ==========================================================================
async function check() {
  let ok = true
  console.log('\nInbox robot — connection check\n')
  for (const k of Object.keys(present)) {
    console.log(`${present[k] ? '✅' : '❌'} ${k}${present[k] ? '' : `  → ${WHERE[k]}`}`)
    ok &&= present[k]
  }
  if (present.TELEGRAM_BOT_TOKEN) {
    const me = await tg('getMe', {})
    console.log(me.ok ? `✅ Telegram bot: @${me.result.username}` : `❌ Telegram said: ${me.error}`)
    ok &&= me.ok
    if (me.ok && present.OWNER_CHAT_ID) {
      const chat = await tg('getChat', { chat_id: OWNER })
      console.log(chat.ok ? '✅ Your chat is reachable' : `❌ Can't reach OWNER_CHAT_ID (${chat.error}) — press Start in your bot first`)
      ok &&= chat.ok
    }
  }
  if (present.SUPABASE_URL && present.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      await sb('GET', 'agent_actions', { query: { select: 'id', limit: '1' } })
      console.log('✅ Database: agent_actions table reachable')
    } catch (e) {
      console.log(`❌ Database: ${e.message}`)
      ok = false
    }
  }
  console.log(ok ? '\nAll good — the weekend robots can run. 🎉\n' : '\nFix the ❌ lines above, then run this again.\n')
  process.exit(ok ? 0 : 1)
}

// ==========================================================================
// digest <file.json>   { key, title, sections: [{ heading, lines: [] }] }
// ==========================================================================
async function digest(path) {
  needAll()
  const b = readJson(path)
  const rawKey = typeof b?.key === 'string' ? b.key.trim() : ''
  const title = typeof b?.title === 'string' ? b.title.trim().slice(0, 200) : ''
  if (!/^[\w:.-]{1,80}$/.test(rawKey)) fail('"key" must be letters/numbers/-/_/:/. only, e.g. "2026-W40".')
  if (!title || !Array.isArray(b?.sections)) fail('The digest needs a "title" and a "sections" list.')
  const key = rawKey.startsWith('inbox-digest:') ? rawKey : `inbox-digest:${rawKey}`
  const sections = b.sections.slice(0, 20).map((s) => ({
    heading: String(s?.heading ?? '').trim().slice(0, 120) || 'Untitled',
    lines: (Array.isArray(s?.lines) ? s.lines : [])
      .slice(0, 60)
      .map((l) => String(l ?? '').trim().slice(0, 600))
      .filter(Boolean),
  }))

  const blocks = [`📬 <b>${escapeHtml(title)}</b>`]
  for (const s of sections) {
    const lines = s.lines.map((l) => `• ${escapeHtml(l)}`).join('\n')
    blocks.push(`<b>${escapeHtml(s.heading)}</b>\n${lines || '<i>nothing new</i>'}`)
  }
  let chunks = chunkMessage(blocks)
  if (chunks.length > MAX_CHUNKS) fail(`That digest is ${chunks.length} messages long (max ${MAX_CHUNKS}). Shorten it.`)
  if (chunks.length > 1) {
    chunks = chunks.map((c, i) => (i === 0 ? c : `<i>${escapeHtml(title)} — part ${i + 1}/${chunks.length}</i>\n\n${c}`))
  }

  // Reserve the key. A brief, not a wish — so it goes straight to 'executing' and never
  // shows as "needs your YES". approver_chat_id stays null = the robot decided.
  const now = nowISO()
  let row = await insertOnce({
    agent_key: 'inbox-digest',
    idempotency_key: key,
    payload: { text: `📬 ${title}`, chat_id: OWNER, sections: sections.map((s) => s.heading) },
    status: 'executing',
    proposed_at: now,
    decided_at: now,
    expires_at: hoursFromNow(1),
  })
  if (!row) {
    // Already there. Only a previously FAILED send may go again.
    const retry = await patchAction(
      { idempotency_key: `eq.${key}`, status: 'eq.failed' },
      { status: 'executing', decided_at: now, error: null },
    )
    row = retry?.[0] ?? null
  }
  if (!row) {
    await logRun('inbox-digest', 'noop', { key, deduped: true })
    console.log(`Already sent "${key}" — nothing sent again.`)
    return
  }

  let sent = 0
  let lastErr = ''
  for (const c of chunks) {
    const r = await sendText(c)
    if (!r.ok) {
      lastErr = r.error
      break
    }
    sent++
    if (sent < chunks.length) await sleep(350)
  }
  if (sent < chunks.length) {
    await patchAction({ id: `eq.${row.id}` }, { status: 'failed', error: `sent ${sent}/${chunks.length}: ${lastErr}` })
    await logRun('inbox-digest', 'failed', { key, sent, of: chunks.length })
    fail(`Telegram refused part ${sent + 1} of ${chunks.length} (${lastErr}). Run the same command again to retry.`)
  }
  await patchAction({ id: `eq.${row.id}` }, { status: 'executed', executed_at: nowISO(), result: { kind: 'digest', chunks: sent } })
  await logRun('inbox-digest', 'ok', { key, title, chunks: sent })
  console.log(`✅ Digest sent to Telegram (${sent} message${sent > 1 ? 's' : ''}). key=${key}`)
}

// ==========================================================================
// shortlist <file.json>   { jobs: [{ id, title, company, location, url, source, why }] }
// ==========================================================================
function cleanJob(j) {
  const url = typeof j?.url === 'string' ? j.url.trim() : ''
  const title = String(j?.title ?? '').trim().slice(0, 160)
  const company = String(j?.company ?? '').trim().slice(0, 120)
  if (!/^https:\/\/\S+$/.test(url) || !title || !company) return null
  const given = String(j?.id ?? '').trim()
  const id = /^[\w:.-]{1,100}$/.test(given) ? given : createHash('sha1').update(url).digest('hex').slice(0, 16)
  return {
    id,
    title,
    company,
    url: url.slice(0, 500),
    location: String(j?.location ?? '').trim().slice(0, 80),
    source: String(j?.source ?? '').trim().slice(0, 40),
    why: String(j?.why ?? '').trim().slice(0, 300),
  }
}

function jobCard(j) {
  const lines = [`💼 <b>${escapeHtml(j.title)}</b> — ${escapeHtml(j.company)}`]
  const where = [j.location, j.source].filter(Boolean).map(escapeHtml).join(' · ')
  if (where) lines.push(where)
  if (j.why) lines.push(`<i>${escapeHtml(j.why)}</i>`)
  lines.push(escapeHtml(j.url), '', 'Approve = Claude applies on Sunday in your browser (nothing is sent before then).')
  return lines.join('\n')
}

async function shortlist(path) {
  needAll()
  const b = readJson(path)
  const raw = Array.isArray(b?.jobs) ? b.jobs : []
  const jobs = raw.map(cleanJob).filter(Boolean).slice(0, MAX_JOBS)
  const skipped = raw.length - jobs.length
  if (!jobs.length) fail('No valid jobs in that file (each needs a title, a company and an https:// url).')

  let proposed = 0
  let duplicates = 0
  for (const job of jobs) {
    // Same as proposeAndNotify() in lib/actions.ts: propose once, send buttons, remember the message.
    const row = await insertOnce({
      agent_key: 'job_apply',
      idempotency_key: `job:${job.id}`,
      payload: { ...job, note: `${job.title} — ${job.company}` },
      status: 'proposed',
      proposed_at: nowISO(),
      expires_at: hoursFromNow(JOB_EXPIRES_H),
    })
    if (!row) {
      duplicates++
      continue
    }
    const keyboard = [[{ text: '✅ Approve', callback_data: `apr:${row.id}` }, { text: '❌ Reject', callback_data: `rej:${row.id}` }]]
    const sent = await sendText(jobCard(job), keyboard)
    if (sent.ok) {
      await patchAction({ id: `eq.${row.id}` }, { notify_chat_id: Number(OWNER), notify_message_id: sent.result.message_id })
    } else {
      console.warn(`(card for "${job.title}" didn't send: ${sent.error} — you can still approve it in the app under Approvals)`)
    }
    proposed++
    await sleep(350)
  }
  await logRun('job_apply', proposed ? 'escalated' : 'noop', { proposed, duplicates, skipped })
  console.log(`✅ ${proposed} job card(s) sent · ${duplicates} already sent before · ${skipped} skipped (missing title/company/https url)`)
}

// ==========================================================================
// approved   → JSON list for the Sunday run
// ==========================================================================
async function approved() {
  needAll()
  const rows = await sb('GET', 'agent_actions', {
    query: {
      select: 'id,payload,decided_at',
      agent_key: 'eq.job_apply',
      status: 'eq.executed',
      'result->>kind': 'eq.job_queued',
      order: 'decided_at.asc',
      limit: '25',
    },
  })
  const jobs = (rows || []).map((r) => ({ action_id: r.id, approved_at: r.decided_at, ...r.payload }))
  console.log(JSON.stringify({ jobs }, null, 2))
}

// ==========================================================================
// result <action_id> <applied|needs_you|failed|skipped> "<note>"
// ==========================================================================
const OUTCOMES = ['applied', 'needs_you', 'failed', 'skipped']
async function result(idArg, outcome, ...noteParts) {
  needAll()
  const id = Number(idArg)
  if (!Number.isInteger(id) || !OUTCOMES.includes(outcome)) {
    fail(`Usage: npm run inbox -- result <action_id> <${OUTCOMES.join('|')}> "short note"`)
  }
  const note = noteParts.join(' ').trim().slice(0, 500)
  const queued = { id: `eq.${id}`, agent_key: 'eq.job_apply', 'result->>kind': 'eq.job_queued' }
  const rows = await sb('GET', 'agent_actions', { query: { select: 'result', ...queued } })
  if (!rows?.length) fail(`Job #${id} isn't waiting in the queue (already reported, not approved, or wrong id).`)
  const updated = await patchAction(queued, {
    result: { ...(rows[0].result || {}), kind: `job_${outcome}`, note, reported_at: nowISO() },
  })
  if (!updated?.length) fail(`Job #${id} was reported by someone else just now — nothing changed.`)
  const runOutcome = outcome === 'applied' ? 'ok' : outcome === 'needs_you' ? 'escalated' : outcome
  await logRun('job_apply', runOutcome, { action_id: id, note })
  console.log(`✅ Job #${id} marked ${outcome}.`)
}

// ==========================================================================
const [cmd, ...args] = process.argv.slice(2)
const COMMANDS = { check, digest, shortlist, approved, result }
if (!COMMANDS[cmd]) {
  console.log('Usage: npm run inbox -- <check | digest <file> | shortlist <file> | approved | result <id> <outcome> "note">')
  process.exit(cmd ? 1 : 0)
}
try {
  await COMMANDS[cmd](...args)
} catch (e) {
  fail(`${e.message}\n   Check your internet, and that supabase/schema.sql has been run once.`)
}
