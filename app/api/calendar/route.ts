import { getRecords } from '@/lib/records'
import { activeProjects } from '@/lib/settings'
import { workProjectsFrom, stepsFor } from '@/lib/work-projects'

// THE GOOGLE CALENDAR INTEGRATION — an ICS feed, not an API integration.
//
// Google Calendar (and Apple, and Outlook) can SUBSCRIBE to a URL that serves
// an .ics file. That gives us a real two-way-feeling integration with zero
// OAuth: no Google Cloud project, no consent screen, no refresh token that
// expires the week you're on holiday. Google re-fetches the URL on its own
// schedule; a step ticked off in the dashboard disappears from the calendar on
// the next refresh, and a new deadline appears the same way.
//
// The honest trade: Google refreshes subscribed calendars on ITS schedule —
// typically every few hours, sometimes up to a day. Deadlines are day-grained
// here, so that latency is acceptable; anything needing minute-grained sync
// would need the OAuth route instead.
//
// AUTH: calendar fetchers can't send headers, so the token rides in the URL.
// It's a dedicated low-privilege secret (CALENDAR_FEED_TOKEN) that can ONLY
// read this feed — never CRON_SECRET, which guards endpoints that spend money.
// Fails closed: no env var, no feed.

export const dynamic = 'force-dynamic'

const DONE = new Set(['done', 'completed', 'closed', 'reversed'])

// RFC 5545 text escaping: backslash first, then structural characters.
const escIcs = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const dateBasic = (iso: string) => iso.replace(/-/g, '')
const dayAfter = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10)

export async function GET(req: Request) {
  const secret = process.env.CALENDAR_FEED_TOKEN?.trim()
  const given = new URL(req.url).searchParams.get('token')
  if (!secret || given !== secret) return new Response('forbidden', { status: 401 })

  const [rows, ads] = await Promise.all([getRecords(), activeProjects()])
  const work = workProjectsFrom(rows)
  const names = new Map<string, string>([
    ...ads.map((p) => [p.id, p.client ?? p.name] as const),
    ...work.map((w) => [w.slug, w.client ?? w.name] as const),
  ])
  // DTSTAMP is mandatory per event; one timestamp for the whole build is fine.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const base = 'https://cashflowos-leo.vercel.app'

  const events: string[] = []
  const push = (uid: string, date: string, summary: string, description: string) =>
    events.push(
      [
        'BEGIN:VEVENT',
        `UID:${uid}@firstin5-dashboard`,
        `DTSTAMP:${stamp}`,
        // All-day events: deadlines are days, not hours. DTEND is exclusive,
        // so a one-day event ends the day after it starts.
        `DTSTART;VALUE=DATE:${dateBasic(date)}`,
        `DTEND;VALUE=DATE:${dateBasic(dayAfter(date))}`,
        `SUMMARY:${escIcs(summary)}`,
        `DESCRIPTION:${escIcs(description)}`,
        'TRANSP:TRANSPARENT', // a deadline shouldn't mark you as "busy"
        'END:VEVENT',
      ].join('\r\n'),
    )

  // Every OPEN task with a deadline — ticked-off ones drop out of the feed, so
  // they clear from the calendar on Google's next refresh.
  for (const r of rows) {
    if (r.category !== 'task' || !r.due_date) continue
    if (DONE.has((r.status || '').toLowerCase())) continue
    const projectId = r.meta?.project as string | undefined
    const projectName = projectId ? names.get(projectId) : undefined
    push(
      `task-${r.id}`,
      r.due_date,
      `📌 ${projectName ? `[${projectName}] ` : ''}${r.title}`,
      projectId
        ? `Next step on ${projectName ?? projectId}. Tick it off: ${base}/projects/${projectId}`
        : `Task in the Firstin5 dashboard: ${base}/tasks`,
    )
  }

  // Each work project's target date — the big deadline over the small ones.
  for (const w of work) {
    if (!w.due || DONE.has(w.status.toLowerCase())) continue
    push(
      `project-${w.slug}`,
      w.due,
      `🎯 ${w.name} — target date`,
      `${w.phase ? `${w.phase}. ` : ''}${stepsFor(rows, w.slug).open.length} open step(s): ${base}/projects/${w.slug}`,
    )
  }

  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Firstin5//Dashboard//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Firstin5 — project deadlines',
    'X-WR-CALDESC:Open next steps and project target dates from the Firstin5 dashboard',
    'X-PUBLISHED-TTL:PT1H',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n')

  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}
