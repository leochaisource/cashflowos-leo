import type { SupabaseClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from './ad-clients.ts'
import { klToday, workDay } from './format.ts'

// CLIENT PROGRESS (owner, 2026-11-10): what got done for each client, and what's
// still to do, from wherever the work happened.
//
//   Code sessions    → claude-mem summaries, posted by the laptop (scripts/progress-sync.ts)
//                      and sorted to a client by Claude (lib/progress-sort.ts)
//   claude.ai/Cowork → the "SpeakFunnels dashboard" connector (app/api/mcp/[key])
//   Telegram         → the bot's log_progress / complete_task tools
//
// "Done" lines go to `progress_log` (supabase/progress.sql). To-dos stay what they
// always were: `records` tasks with meta.project, so the dashboard ticks them as
// before. A to-do added from here carries meta.from = 'code' | 'chat' | 'telegram',
// which is what the owner's rules key on:
//   · only a Claude-added to-do (meta.from set) may be ticked automatically;
//     one he typed gets a "Looks done?" line instead (meta.looks_done_at);
//   · at most MAX_CLAUDE_OPEN open Claude to-dos per client;
//   · an undated Claude to-do is asked about on Mondays and closes after 28 days.
// Clients only: job hunt, LinkedIn, his own brand (Firstin5) and app-wide
// dashboard work never land here.
//
// Shared with scripts, so explicit .ts imports and the Supabase client comes in
// as a parameter. Raw session summaries are never stored — only the lines.

export type ProgressSource = 'code' | 'chat' | 'telegram'
export type ProgressClient = { id: string; name: string; hint: string }
export type ProgressLine = { id: number; project: string; happened_at: string; happened_on: string; text: string; source: ProgressSource }
export type TaskRow = { id: number; title: string; status: string; due_date: string | null; meta: Record<string, any>; created_at: string }

export const MAX_CLAUDE_OPEN = 8
export const STALE_DAYS = 28
const DAY = 86_400_000

const NOT_CLIENTS = new Set(['firstin5'])
const CLOSED = new Set(['done', 'completed', 'complete', 'closed', 'shipped', 'reversed', 'dismissed', 'expired'])
export const isOpen = (t: { status: string | null }) => !CLOSED.has((t.status || '').toLowerCase())

// What a session or chat calls each client — the sorter matches on these. A new
// client works without an entry (its name is used); add one when sessions call it
// something else.
const HINTS: Record<string, string> = {
  'claude-malaysia':
    'Kingsley; Claude Malaysia / claudemy; the CM1D one-day Claude AI workshop and the weekly webinar; Ariella (closer) and Ari ' +
    '(the WhatsApp bot); hot leads sheet, closing coach, Funnel X-ray, EventOps, "your share"',
  'starcity-global': 'Starcity / 星匯國際, Florence 火姐; Malaysian property sold to Hong Kong buyers; MM2H seminars and leads sheet',
  'mr-money-academy': 'Mr Money Academy; financial education, pre-launch / in negotiation',
  'prominds-ai-speaker': 'Prominds Academy, Nicsman Tay; 《AI讲师影响力》 course and its webinar; Mok, Bowie; Nicsman testimonial videos',
  'dr-tariq-website': 'Dr Tariq; website malware fix, hosting, invoice',
  'sandra-migration': 'Sandra; landing page and Mailchimp migration',
  'trisen-markethon': 'Trisen Tan; Markethon workshop materials',
  'savwee-closer': 'Savwee; closer / sales follow-up',
}

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** Every client progress can be filed to: real ad clients plus open work projects, not his own brand. */
export async function loadClients(db: SupabaseClient): Promise<ProgressClient[]> {
  const { data } = await db.from('records').select('title, status, meta').eq('category', 'project')
  const work = (data ?? [])
    .filter((r) => isOpen(r))
    .map((r) => {
      const meta = (r.meta ?? {}) as Record<string, any>
      const id = (meta.slug as string) || slugify(r.title)
      return { id, name: (meta.client as string) || r.title, hint: [r.title, meta.phase].filter(Boolean).join(' — ') }
    })
  const ads = AD_CLIENTS.filter((c) => !c.demo).map((c) => ({ id: c.id, name: c.client ?? c.name, hint: c.name }))
  return [...ads, ...work]
    .filter((c) => !NOT_CLIENTS.has(c.id))
    .map((c) => ({ ...c, hint: HINTS[c.id] ? `${c.hint}; ${HINTS[c.id]}` : c.hint }))
}

/** The same line, however it's punctuated or capitalised. */
export const textKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** One tidy line: no leading bullet, single spaces, at most `max` characters. */
export function cleanLine(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').replace(/^[\s•\-*·✅✓]+/, '').trim()
  const chars = Array.from(t)
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : t
}

/** A due date the model or a chat gave: kept only if it's a real date from today to 120 days out. */
export function validDue(s: string | null | undefined, today = klToday()): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) return null
  if (s < today || Date.parse(s) - Date.parse(today) > 120 * DAY) return null
  return s
}

/** Every task row that belongs to a project, paged (getRecords() stops at 1,000 rows). */
export async function allTasks(db: SupabaseClient): Promise<TaskRow[]> {
  const out: TaskRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('records')
      .select('id, title, status, due_date, meta, created_at')
      .eq('category', 'task')
      .not('meta->>project', 'is', null)
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(`tasks unreadable: ${error.message}`)
    out.push(...((data ?? []) as TaskRow[]))
    if (!data || data.length < 1000) return out
  }
}

export type LogEntry = { project: string; text: string; source: ProgressSource; at?: string; sourceRef?: string; sessionRef?: string }

/** Log "done" lines. The same line on the same work day for a client is one row. Returns how many are new. */
export async function logProgress(db: SupabaseClient, entries: LogEntry[], opts: { dry?: boolean } = {}): Promise<number> {
  const seen = new Set<string>()
  const rows = entries
    .map((e) => {
      const at = e.at ?? new Date().toISOString()
      const text = cleanLine(e.text, 300)
      return {
        project: e.project,
        happened_at: at,
        happened_on: workDay(at),
        text,
        text_key: textKey(text),
        source: e.source,
        source_ref: e.sourceRef ?? null,
        session_ref: e.sessionRef ?? null,
      }
    })
    .filter((r) => {
      const k = `${r.project}|${r.happened_on}|${r.text_key}`
      if (!r.text_key || seen.has(k)) return false
      seen.add(k)
      return true
    })
  if (!rows.length) return 0
  if (opts.dry) return rows.length
  const { data, error } = await db
    .from('progress_log')
    .upsert(rows, { onConflict: 'project,happened_on,text_key', ignoreDuplicates: true })
    .select('id')
  if (error) throw new Error(`progress not logged: ${error.message}`)
  return data?.length ?? 0
}

export type TodoIn = { title: string; due?: string | null }

/**
 * Add to-dos to a client. Skips one already there — open, or added in the last 45
 * days and since closed, so a to-do he ticked doesn't come back from a later
 * session's notes — and stops at MAX_CLAUDE_OPEN open Claude to-dos per client.
 */
export async function addTodos(
  db: SupabaseClient,
  project: string,
  todos: TodoIn[],
  opts: { from: ProgressSource; ref?: string; dry?: boolean; tasks?: TaskRow[]; today?: string },
): Promise<string[]> {
  const today = opts.today ?? klToday()
  const tasks = (opts.tasks ?? (await allTasks(db))).filter((t) => t.meta?.project === project)
  const recent = tasks.filter((t) => isOpen(t) || Date.now() - Date.parse(t.created_at) < 45 * DAY)
  const keys = recent.map((t) => textKey(t.title))
  const same = (a: string, b: string) => a === b || (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a)))
  let openClaude = tasks.filter((t) => isOpen(t) && t.meta?.from).length
  const rows: Record<string, unknown>[] = []
  for (const td of todos) {
    const title = cleanLine(td.title, 140)
    const k = textKey(title)
    if (!k || keys.some((x) => same(x, k))) continue
    if (openClaude >= MAX_CLAUDE_OPEN) break
    rows.push({
      category: 'task',
      title,
      status: 'open',
      due_date: validDue(td.due, today),
      meta: { project, from: opts.from, ...(opts.ref ? { ref: opts.ref } : {}) },
    })
    keys.push(k)
    openClaude++
  }
  if (rows.length && !opts.dry) {
    const { error } = await db.from('records').insert(rows)
    if (error) throw new Error(`to-dos not added: ${error.message}`)
  }
  return rows.map((r) => String(r.title))
}

/** Tick a to-do (an open task of a client). Returns its title, or null when it isn't one. */
export async function completeTodo(
  db: SupabaseClient,
  id: number,
  opts: { by: ProgressSource | 'claude'; ref?: string; clientIds?: string[]; dry?: boolean },
): Promise<{ title: string; project: string } | null> {
  const { data } = await db.from('records').select('id, title, status, meta').eq('id', id).eq('category', 'task').maybeSingle()
  if (!data || !isOpen(data)) return null
  const meta = (data.meta ?? {}) as Record<string, any>
  if (!meta.project || (opts.clientIds && !opts.clientIds.includes(meta.project))) return null
  if (!opts.dry) {
    const { error } = await db
      .from('records')
      .update({ status: 'done', meta: { ...meta, done_by: opts.by, done_at: new Date().toISOString(), ...(opts.ref ? { done_ref: opts.ref } : {}) } })
      .eq('id', id)
      .eq('category', 'task')
    if (error) throw new Error(`not ticked: ${error.message}`)
  }
  return { title: data.title, project: meta.project }
}

/** A to-do he typed that a session says is finished: flagged for the Today message, not ticked. */
export async function markLooksDone(db: SupabaseClient, id: number, ref: string): Promise<void> {
  const { data } = await db.from('records').select('meta, status').eq('id', id).eq('category', 'task').maybeSingle()
  if (!data || !isOpen(data)) return
  await db.from('records').update({ meta: { ...(data.meta ?? {}), looks_done_at: new Date().toISOString(), looks_done_ref: ref } }).eq('id', id)
}

/** Done lines since an instant, newest first (all clients, or one). */
export async function progressSince(db: SupabaseClient, sinceIso: string, project?: string): Promise<ProgressLine[]> {
  let q = db
    .from('progress_log')
    .select('id, project, happened_at, happened_on, text, source')
    .gte('happened_at', sinceIso)
    .order('happened_at', { ascending: false })
    .limit(300)
  if (project) q = q.eq('project', project)
  const { data, error } = await q
  if (error) throw new Error(`progress unreadable: ${error.message}`)
  return (data ?? []) as ProgressLine[]
}

/** Close undated Claude to-dos nobody touched for STALE_DAYS (they can be reopened on the dashboard). */
export async function expireStaleTodos(db: SupabaseClient, tasks: TaskRow[], opts: { dry?: boolean } = {}): Promise<string[]> {
  const stale = tasks.filter((t) => isOpen(t) && t.meta?.from && !t.due_date && Date.now() - Date.parse(t.created_at) > STALE_DAYS * DAY)
  if (stale.length && !opts.dry) {
    for (const t of stale)
      await db.from('records').update({ status: 'expired', meta: { ...t.meta, expired_at: new Date().toISOString() } }).eq('id', t.id).eq('category', 'task')
  }
  return stale.map((t) => t.title)
}

// ------------------------------------------------------------------ the digest
// One read of everything the Today message, the 8am lines and the Home band show.
// Pure over what it is given, so the renderers below can be tested from a script.

export type ClientDay = {
  client: ProgressClient
  overdue: TaskRow[]
  dueToday: TaskRow[]
  open: TaskRow[] // the rest, soonest due first, undated last
  progress: ProgressLine[]
}

export type Digest = {
  today: string
  since: string
  clientIds: string[] // every client, with or without something today
  clients: ClientDay[]
  ticked: TaskRow[] // closed by Claude since `since`
  looksDone: TaskRow[] // his own to-dos a session says are finished
  stale: TaskRow[] // Monday: the oldest undated Claude to-dos
  chatAdds: TaskRow[] // to-dos a chat or Telegram added since `since`
}

export function buildDigest(args: { clients: ProgressClient[]; tasks: TaskRow[]; progress: ProgressLine[]; today: string; since: string }): Digest {
  const { clients, tasks, progress, today, since } = args
  const ids = new Set(clients.map((c) => c.id))
  const mine = tasks.filter((t) => ids.has(t.meta?.project))
  const open = mine.filter(isOpen)
  const byDue = (a: TaskRow, b: TaskRow) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.id - b.id
  const days = clients
    .map((client) => {
      const o = open.filter((t) => t.meta.project === client.id).sort(byDue)
      return {
        client,
        overdue: o.filter((t) => !!t.due_date && t.due_date < today),
        dueToday: o.filter((t) => t.due_date === today),
        open: o.filter((t) => !t.due_date || t.due_date > today),
        progress: progress.filter((p) => p.project === client.id),
      }
    })
    .filter((d) => d.overdue.length || d.dueToday.length || d.open.length || d.progress.length)
  const after = (iso: unknown) => typeof iso === 'string' && iso >= since
  const monday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1
  return {
    today,
    since,
    clientIds: clients.map((c) => c.id),
    clients: days,
    ticked: mine.filter((t) => (t.status || '').toLowerCase() === 'done' && t.meta?.done_by && t.meta.done_by !== 'dashboard' && after(t.meta.done_at)),
    looksDone: open.filter((t) => !t.meta?.from && after(t.meta?.looks_done_at)),
    stale: monday ? open.filter((t) => t.meta?.from && !t.due_date).sort((a, b) => a.id - b.id).slice(0, 5) : [],
    chatAdds: open.filter((t) => (t.meta?.from === 'chat' || t.meta?.from === 'telegram') && after(t.created_at)),
  }
}

// "Since yesterday's message" = since the last Today message actually went out
// (cfo-cache), so a missed morning doesn't lose a day's progress — capped at 3
// days so a long gap can't flood the message.
const TODAY_MARK = 'progress/today-sent.json'

export async function lastTodaySent(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.storage.from('cfo-cache').download(TODAY_MARK)
  if (!data) return null
  try {
    return (JSON.parse(await data.text()) as { at?: string }).at ?? null
  } catch {
    return null
  }
}

export async function markTodaySent(db: SupabaseClient, at = new Date().toISOString()): Promise<void> {
  await db.storage.from('cfo-cache').upload(TODAY_MARK, JSON.stringify({ at }), { upsert: true, contentType: 'application/json' })
}

/** Everything the Today message, the 8am lines and the Home band show, in one read. */
export async function loadDigest(db: SupabaseClient, opts: { since?: string; today?: string } = {}): Promise<Digest & { tasks: TaskRow[] }> {
  const today = opts.today ?? klToday()
  const floor = new Date(Date.now() - 3 * DAY).toISOString()
  const marked = opts.since ?? (await lastTodaySent(db)) ?? new Date(Date.now() - DAY).toISOString()
  const since = marked < floor ? floor : marked
  const [clients, tasks, progress] = await Promise.all([loadClients(db), allTasks(db), progressSince(db, since)])
  return { ...buildDigest({ clients, tasks, progress, today, since }), tasks }
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const FROM: Record<string, string> = { code: 'Code', chat: 'chat', telegram: 'Telegram' }
const daysLate = (due: string, today: string) => Math.round((Date.parse(today) - Date.parse(due)) / DAY)
const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`)
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`
}

/**
 * The client part of the 9am Today message (Telegram HTML). Code, not a model:
 * it must arrive even when the API is down. Capped so one busy client can't push
 * the rest out of the message.
 */
export function renderTodaySection(d: Digest, opts: { notes?: string[]; dashboardUrl?: string } = {}): string {
  const parts: string[] = []
  const work = d.clients.filter((c) => c.overdue.length || c.dueToday.length || c.open.length)
  if (work.length) {
    const blocks = work.slice(0, 8).map((c) => {
      const lines = [`<b>${esc(c.client.name)}</b>`]
      for (const t of c.overdue.slice(0, 3)) lines.push(`🔴 ${esc(t.title)} <i>(overdue ${daysLate(t.due_date!, d.today)}d)</i>`)
      for (const t of c.dueToday.slice(0, 3)) lines.push(`🟡 ${esc(t.title)} <i>(today)</i>`)
      const room = Math.max(0, 3 - c.overdue.length - c.dueToday.length)
      for (const t of c.open.slice(0, room)) lines.push(`• ${esc(t.title)}${t.due_date ? ` <i>(${shortDate(t.due_date)})</i>` : ''}`)
      const more = c.overdue.length + c.dueToday.length + c.open.length - (lines.length - 1)
      if (more > 0) lines.push(`<i>+${more} more</i>`)
      return lines.join('\n')
    })
    parts.push(`📋 <b>To do</b>\n${blocks.join('\n\n')}` + (work.length > 8 ? `\n\n<i>+${work.length - 8} more clients on the dashboard</i>` : ''))
  }
  const done = d.clients.filter((c) => c.progress.length)
  if (done.length) {
    const lines = done.slice(0, 8).map((c) => {
      const shown = c.progress.slice(0, 3).map((p) => `   ✓ ${esc(p.text)}`)
      const more = c.progress.length > 3 ? `\n   <i>+${c.progress.length - 3} more</i>` : ''
      return `<b>${esc(c.client.name)}</b>\n${shown.join('\n')}${more}`
    })
    parts.push(`✅ <b>Done since yesterday's message</b>\n${lines.join('\n')}`)
  }
  if (d.ticked.length)
    parts.push(`☑️ <b>Ticked off for you</b> (a session said they're finished)\n${d.ticked.slice(0, 6).map((t) => `• ${esc(t.title)}`).join('\n')}`)
  if (d.looksDone.length)
    parts.push(`❓ <b>Looks done?</b> Tick them on the dashboard if so\n${d.looksDone.slice(0, 5).map((t) => `• ${esc(t.title)}`).join('\n')}`)
  if (d.chatAdds.length)
    parts.push(
      `➕ <b>Added from your chats</b>\n${d.chatAdds.slice(0, 6).map((t) => `• ${esc(t.title)} <i>(${FROM[t.meta?.from] ?? t.meta?.from})</i>`).join('\n')}`,
    )
  if (d.stale.length)
    parts.push(
      `🧹 <b>Still relevant?</b> Claude added these with no date. Untouched ones close after ${STALE_DAYS} days\n` +
        d.stale.map((t) => `• ${esc(t.title)}`).join('\n'),
    )
  if (opts.notes?.length) parts.push(`⚙️ ${opts.notes.map(esc).join('\n⚙️ ')}`)
  if (!parts.length) parts.push('Nothing on your client list today. Enjoy it.')
  if (opts.dashboardUrl) parts.push(`<a href="${opts.dashboardUrl}">Open the Command Centre</a>`)
  return parts.join('\n\n')
}

/** The 8am brief's operator-only lines for one client: what moved, what's next. Null when there's nothing. */
export function renderClientLines(c: ClientDay | undefined, today: string): string | null {
  if (!c) return null
  const out: string[] = []
  if (c.progress.length) out.push(`📌 Done since yesterday: ${c.progress.slice(0, 2).map((p) => p.text).join('; ')}${c.progress.length > 2 ? ` (+${c.progress.length - 2})` : ''}`)
  const next = [...c.overdue, ...c.dueToday, ...c.open].slice(0, 2)
  if (next.length)
    out.push(
      `📌 Next: ${next
        .map((t) => `${t.title}${t.due_date ? (t.due_date < today ? ' (overdue)' : t.due_date === today ? ' (today)' : ` (${shortDate(t.due_date)})`) : ''}`)
        .join('; ')}`,
    )
  return out.length ? out.join('\n') : null
}
