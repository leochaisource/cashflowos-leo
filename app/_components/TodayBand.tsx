import Link from 'next/link'
import type { Digest } from '@/lib/progress'

// HOME'S "TODAY" — the 9am Today message, on the page (lib/progress.ts
// buildDigest): per client, what's overdue or due today, what's next, and what
// got done since the last morning message. Clients with nothing either way are
// left out; nothing at all → one quiet line.

const short = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

export default function TodayBand({ digest }: { digest: Digest }) {
  const { today, clients } = digest
  return (
    <div className="band">
      <div className="band-head">
        <h2>Today</h2>
        <span>your clients · to-dos and what got done since the morning message</span>
      </div>
      {clients.length === 0 ? (
        <div className="empty">Nothing open and nothing logged for your clients. New to-dos and progress land here on their own.</div>
      ) : (
        <div className="today-grid">
          {clients.slice(0, 8).map((c) => {
            const next = c.open.slice(0, Math.max(0, 3 - c.overdue.length - c.dueToday.length))
            return (
              <div key={c.client.id} className="today-client">
                <h3>
                  <Link href={`/projects/${encodeURIComponent(c.client.id)}`}>{c.client.name}</Link>
                </h3>
                <ul className="today-list">
                  {c.overdue.slice(0, 3).map((t) => (
                    <li key={t.id} className="late">
                      {t.title} · overdue
                    </li>
                  ))}
                  {c.dueToday.slice(0, 3).map((t) => (
                    <li key={t.id} className="now">
                      {t.title} · today
                    </li>
                  ))}
                  {next.map((t) => (
                    <li key={t.id}>
                      {t.title}
                      {t.due_date && t.due_date > today ? ` · ${short(t.due_date)}` : ''}
                    </li>
                  ))}
                  {c.progress.slice(0, 2).map((p) => (
                    <li key={`p${p.id}`} className="did">
                      {p.text}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
