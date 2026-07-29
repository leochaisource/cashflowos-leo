import Link from 'next/link'
import type { Head, HeadBrief } from '@/agents/heads'

// One department head on the Dashboard's C-Suite row. Deliberately reuses the
// .agent-card / .ac-name / .ac-role / .ac-lastrun / .pill styles the AI Employees
// tab already uses — a head IS an employee card, one level up. No new CSS.
//
// The state pill is honest on purpose: a head with no rows to read says so rather
// than showing a confident zero.
const STATE: Record<HeadBrief['state'], { cls: string; word: string }> = {
  live: { cls: 'done', word: 'live' },
  off: { cls: 'nurture', word: 'not turned on' },
  'no-fuel': { cls: 'open', word: 'no data yet' },
}

export default function HeadCard({ head, brief }: { head: Head; brief: HeadBrief }) {
  const s = STATE[brief.state]
  const card = (
    <div className="agent-card">
      <p className="ac-name">
        <span aria-hidden="true">{head.emoji}</span> {head.label}
        <span className={`pill ${s.cls}`}>{s.word}</span>
        {brief.count > 0 ? (
          <span className="pill proposed">
            🙋 {brief.count} recommendation{brief.count === 1 ? '' : 's'}
          </span>
        ) : null}
      </p>
      <p className="ac-role">{brief.headline}</p>
      <p className="ac-lastrun">{head.dial}</p>
    </div>
  )
  // Only make it clickable when there's actually something waiting for a YES.
  return brief.count > 0 ? (
    <Link href="/approvals" style={{ textDecoration: 'none', color: 'inherit' }}>
      {card}
    </Link>
  ) : (
    card
  )
}
