'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import MoreSheet, { type MoreTab } from './MoreSheet'
import { PROJECTS } from '@/lib/ad-clients'

// 👉 The phone bottom bar (shown ≤768px). Four thumb-size primary tabs + a
//    "More" button that opens the slide-up sheet with everything else, so every
//    section stays reachable on a phone. Keep this in sync with Nav.tsx.
const PRIMARY = [
  { href: '/', label: 'Projects', ico: '🗂️' },
  { href: '/cash-in', label: 'Cash In', ico: '💰' },
  { href: '/cash-out', label: 'Cash Out', ico: '🧾' },
  { href: '/approvals', label: 'Approvals', ico: '🙋' },
]

// Everything not on the bottom bar lives in the More sheet — including one entry
// per project, so a client's scorecard is two taps away on a phone.
const MORE: MoreTab[] = [
  ...PROJECTS.map(p => ({ href: `/projects/${p.id}`, label: p.client ?? p.name, ico: '📈' })),
  { href: '/agency', label: 'Agency', ico: '🏠' },
  { href: '/leads', label: 'Leads', ico: '🧲' },
  { href: '/customers', label: 'Customers', ico: '🧑‍🤝‍🧑' },
  { href: '/content', label: 'Content', ico: '📣' },
  { href: '/tasks', label: 'Tasks', ico: '✅' },
  { href: '/employees', label: 'AI Employees', ico: '🤖' },
  { href: '/vault', label: 'Vault', ico: '🗄️' },
]

export default function BottomNav() {
  const path = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActive = MORE.some(t => t.href === path)
  return (
    <>
      <nav className="bottomnav">
        {PRIMARY.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className={path === t.href ? 'active' : ''}
            onClick={() => setMoreOpen(false)}
          >
            <span className="ico" aria-hidden="true">{t.ico}</span>
            {t.label}
          </Link>
        ))}
        <button
          type="button"
          className={`bn-more${moreActive ? ' active' : ''}`}
          onClick={() => setMoreOpen(v => !v)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
        >
          <span className="ico" aria-hidden="true">⋯</span>
          More
        </button>
      </nav>
      <MoreSheet tabs={MORE} open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  )
}
