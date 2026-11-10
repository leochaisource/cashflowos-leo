import type { ProgressLine } from '@/lib/progress'

// What got done for this client lately (lib/progress.ts): lines from Code
// sessions, claude.ai / Cowork chats and Telegram, newest day first. Read-only —
// a wrong line is rare and harmless; the to-dos above are what he acts on.

const SOURCE: Record<string, string> = { code: 'Code session', chat: 'chat', telegram: 'Telegram' }

function dayLabel(day: string, today: string): string {
  const diff = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export default function ProgressBand({ lines, today, days = 14 }: { lines: ProgressLine[]; today: string; days?: number }) {
  const byDay = new Map<string, ProgressLine[]>()
  for (const l of lines) byDay.set(l.happened_on, [...(byDay.get(l.happened_on) ?? []), l])
  return (
    <div className="band">
      <div className="band-head">
        <h2>Progress</h2>
        <span>last {days} days · from your sessions, chats and Telegram</span>
      </div>
      {byDay.size === 0 ? (
        <div className="empty">
          Nothing logged yet. Work on this client in a Claude session, tell a claude.ai chat to &ldquo;log this&rdquo;, or text the bot &ldquo;done: …&rdquo;.
        </div>
      ) : (
        [...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <p className="prog-day">{dayLabel(day, today)}</p>
            <ul className="prog">
              {list.map((l) => (
                <li key={l.id}>
                  <span>{l.text}</span>
                  <span className="src">{SOURCE[l.source] ?? l.source}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
}
