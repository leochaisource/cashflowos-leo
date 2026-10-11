import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/webinar-reminder.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { sendMessage } from './telegram.ts'

// THE WEBINAR HYPE-UP REMINDER (owner, 2026-10-11). Before every webinar the
// follow-up owner (Ariella) posts the WhatsApp community hype-up sequence —
// one post a day from T-5 to webinar day, from the "WhatsApp Community Posts"
// tab of the CS brief sheet — and tends to forget. So on the morning of T-5 she
// gets a Telegram reminder with the dated schedule, then a one-line nudge each
// morning from T-4 to webinar day; the owner gets a copy of each.
//
// The webinar date is GHL's custom value {{custom_values.cm1d_webinar__date}},
// e.g. "13 October  (Tuesday)" — no year, so the year is the one where the
// weekday matches (or the nearest upcoming date). Sent once per webinar date;
// if the T-5 run is missed, it still goes on T-4 or T-3, worded as a catch-up.

const API = 'https://services.leadconnectorhq.com'
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The CS brief sheet with the "WhatsApp Community Posts" tab (Kingsley's team). */
export const COMMUNITY_POSTS_SHEET = 'https://docs.google.com/spreadsheets/d/1vGZAhr5bQx1ctnv938RJOF6K-2oXFh27hU3B6E2eCWs/edit'

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5)
const label = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`)
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}`
}
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * "13 October  (Tuesday)" / "Tue, 13 Oct 2026" / "October 13" → "2026-10-13".
 * Without a year: the year in which the stated weekday matches; with no
 * weekday either, the first one not more than 30 days in the past.
 */
export function parseWebinarDate(raw: string, today: string): string | null {
  const s = raw.toLowerCase()
  const isoMatch = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}[a-z]*\\b`).test(s))
  const day = Number(s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)?.[1])
  if (month < 0 || !(day >= 1 && day <= 31)) return null
  const year = Number(s.match(/\b(20\d{2})\b/)?.[1])
  const weekday = DAYS.findIndex((d) => new RegExp(`\\b${d.slice(0, 3)}[a-z]*\\b`).test(s))
  const iso = (y: number) => `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (year) return iso(year)
  const thisYear = Number(today.slice(0, 4))
  const years = [thisYear, thisYear + 1, thisYear - 1]
  if (weekday >= 0) {
    const hit = years.find((y) => new Date(`${iso(y)}T12:00:00Z`).getUTCDay() === weekday)
    if (hit) return iso(hit)
  }
  return years.map(iso).find((d) => dayDiff(d, today) >= -30) ?? null
}

export type Webinar = { date: string; raw: string; name: string | null; time: string | null; community: string | null }

/** The webinar as GHL's custom values describe it (cm1d_webinar__*). */
export async function readWebinar(locationId: string, token: string, today: string): Promise<Webinar | null> {
  const res = await fetch(`${API}/locations/${encodeURIComponent(locationId)}/customValues`, {
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`GHL custom values: ${res.status}`)
  const list = ((await res.json()).customValues ?? []) as { fieldKey?: string; value?: string }[]
  const val = (key: string) => list.find((v) => (v.fieldKey ?? '').includes(`custom_values.${key} `) || (v.fieldKey ?? '').includes(`custom_values.${key}}`))?.value?.trim() || null
  const raw = val('cm1d_webinar__date')
  if (!raw) return null
  const date = parseWebinarDate(raw, today)
  if (!date) throw new Error(`can't read the webinar date "${raw}"`)
  return { date, raw, name: val('cm1d_webinar__name'), time: val('cm1d_webinar__time'), community: val('cm1d_webinar__whatsapp_community_link') }
}

export function renderReminder(w: Webinar, today: string, closer: string): string {
  const until = dayDiff(w.date, today)
  const start = addDays(w.date, -5)
  const lines = [
    until === 5
      ? `📣 <b>${esc(closer)}, the webinar hype-up starts TODAY</b>`
      : `📣 <b>${esc(closer)}, the webinar hype-up should have started on ${label(start)}</b>`,
    '',
    `Webinar: <b>${esc(w.name ?? 'Claude Malaysia webinar')}</b> — ${label(w.date)}${w.time ? `, ${esc(w.time)}` : ''} (in ${until} day${until === 1 ? '' : 's'})`,
    '',
    until === 5
      ? 'Please <b>REMEMBER</b> to post the WhatsApp community hype-up sequence in the WA community group, one post a day:'
      : 'Please <b>REMEMBER</b> to post the WhatsApp community hype-up sequence — catch up on any day you missed and post today’s:',
  ]
  for (let t = 5; t >= 0; t--) {
    const d = addDays(w.date, -t)
    const tag = t === 0 ? 'Webinar day' : `T-${t}`
    const isToday = d === today
    lines.push(`${isToday ? '👉' : '•'} ${tag} · ${label(d)}${isToday ? ' — <b>today</b>' : ''}`)
  }
  lines.push('', `📄 The posts, times and images: CS brief → <b>WhatsApp Community Posts</b> tab\n${COMMUNITY_POSTS_SHEET}`)
  if (w.community) lines.push(`💬 WA community: ${esc(w.community)}`)
  return lines.join('\n')
}

/**
 * The daily one-liner, T-4 → webinar day (owner, 2026-10-11 — one T-5 message
 * wasn't enough for a sequence she tends to forget):
 *   📣 Ariella — WA hype-up, post 3 of 6: post T-3 today (Sat 10 Oct) in the WA community.
 */
export function renderNudge(w: Webinar, today: string, closer: string): string {
  const until = dayDiff(w.date, today)
  const n = 6 - until
  const what = until === 0 ? 'the <b>webinar-day</b> post' : `<b>T-${until}</b>`
  return [
    `📣 ${esc(closer)} — WA hype-up, post ${n} of 6: post ${what} today (${label(today)}) in the WA community group.`,
    `Webinar: <b>${esc(w.name ?? 'Claude Malaysia webinar')}</b> — ${until === 0 ? '<b>TODAY</b>' : label(w.date)}${w.time ? `, ${esc(w.time)}` : ''}`,
    `📄 CS brief → WhatsApp Community Posts tab: ${COMMUNITY_POSTS_SHEET}`,
  ].join('\n')
}

const LIMIT = 3800
async function sendAll(chatId: string, text: string): Promise<string | null> {
  for (let i = 0; i < text.length; i += LIMIT) {
    const r = await sendMessage(chatId, text.slice(i, i + LIMIT), { noPreview: true })
    if (!r.ok) return r.error ?? 'send failed'
  }
  return null
}

export type ReminderRun = { ok: boolean; skipped?: string; webinar?: string; text?: string; sentTo: string[]; error?: string }

/**
 * For the webinar in GHL, today's message if any:
 *   T-5                        → the full reminder (dated schedule + links)
 *   T-4, T-3 with T-5 missed   → the full reminder, worded as a catch-up
 *   T-4 … webinar day          → the one-line nudge for today's post
 * Each once (the full reminder once per webinar, the nudge once per day).
 * `today` and `force` are for previews; `to: 'owner'` previews to the owner.
 */
export async function runWebinarReminder(args: {
  client: AdClient
  db?: SupabaseClient | null
  to: 'closer' | 'owner' | 'none'
  today?: string
  force?: boolean
}): Promise<ReminderRun> {
  const g = args.client.ghl
  const closer = g?.followupAssignee
  if (!g || !closer) return { ok: false, sentTo: [], error: 'no follow-up owner configured' }
  const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
  const today = args.today ?? new Date().toLocaleDateString('en-CA', { timeZone: tz })
  const w = await readWebinar(process.env[g.locationEnv]!.trim(), process.env[g.tokenEnv]!.trim(), today)
  if (!w) return { ok: true, sentTo: [], skipped: 'no webinar date in GHL' }
  const until = dayDiff(w.date, today)
  if (until < 0 || until > 5) return { ok: true, sentTo: [], webinar: w.date, skipped: `webinar is ${until} days away (runs T-5 to webinar day)` }

  // What already went out — remembered on the latest brief_daily rows.
  type Memo = { webinarReminder?: { webinar?: string }; webinarNudge?: { webinar?: string; day?: string } }
  const recent = args.db
    ? (await args.db.from('brief_daily').select('id, date, payload').eq('project', args.client.id).order('date', { ascending: false }).limit(10)).data ?? []
    : []
  const memo = (r: { payload: unknown }) => (r.payload ?? {}) as Memo
  const fullSent = recent.some((r) => memo(r).webinarReminder?.webinar === w.date)
  const nudgedToday = recent.some((r) => memo(r).webinarNudge?.webinar === w.date && memo(r).webinarNudge?.day === today)
  const kind: 'full' | 'nudge' = until === 5 || (until >= 3 && !fullSent) ? 'full' : 'nudge'
  if (args.to === 'closer' && !args.force && (kind === 'full' ? fullSent : nudgedToday))
    return { ok: true, sentTo: [], webinar: w.date, skipped: kind === 'full' ? 'already sent for this webinar' : 'already nudged today' }

  const text = kind === 'full' ? renderReminder(w, today, closer.name) : renderNudge(w, today, closer.name)
  const owner = process.env.OWNER_CHAT_ID?.trim()
  const sentTo: string[] = []
  let error: string | null = null
  if (args.to === 'owner' && owner) {
    error = await sendAll(owner, `<i>Preview — what ${esc(closer.name)} gets on ${until === 0 ? 'webinar day' : `T-${until}`}.</i>\n\n${text}`)
    if (!error) sentTo.push(owner)
  }
  if (args.to === 'closer') {
    const target = closer.telegramChatId ?? owner
    if (target) {
      error = await sendAll(target, closer.telegramChatId ? text : `<i>${esc(closer.name)}'s Telegram isn't linked, so this came to you.</i>\n\n${text}`)
      if (!error) sentTo.push(target)
    }
    // The owner's copy, marked — only once hers went out.
    if (!error && closer.telegramChatId && owner && owner !== closer.telegramChatId) {
      const at = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
      if (!(await sendAll(owner, `📋 <i>Copy — sent to ${esc(closer.name)} on Telegram at ${at}.</i>\n\n${text}`))) sentTo.push(owner)
    }
    const latest = recent[0]
    if (sentTo.length && args.db && latest?.id) {
      const record = { webinar: w.date, day: today, sentAt: new Date().toISOString(), to: sentTo }
      const payload = { ...((latest.payload as Record<string, unknown>) ?? {}), [kind === 'full' ? 'webinarReminder' : 'webinarNudge']: record }
      await args.db.from('brief_daily').update({ payload }).eq('id', latest.id)
    }
  }
  return { ok: !error, webinar: w.date, text, sentTo, error: error ?? undefined }
}
