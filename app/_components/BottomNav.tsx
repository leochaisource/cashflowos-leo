'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import Icon from './Icon'
import MoreSheet, { type MoreTab } from './MoreSheet'
import { isActivePath, type NavProject, type NavTab } from './Nav'

// 👉 The phone bottom bar (shown ≤768px). Four thumb-size primary tabs + a
//    "More" button that opens the slide-up sheet with everything else, so every
//    section stays reachable on a phone. Keep this in sync with Nav.tsx.
const PRIMARY: Required<NavTab>[] = [
  { href: '/', label: 'Projects', icon: 'grid' },
  { href: '/cash-in', label: 'Cash In', icon: 'cash-in' },
  { href: '/cash-out', label: 'Cash Out', icon: 'cash-out' },
  { href: '/approvals', label: 'Approvals', icon: 'approvals' },
]

// Everything not on the bottom bar lives in the More sheet — including one entry
// per project, so a client's scorecard is two taps away on a phone. The project
// list comes from the layout: which ones exist depends on the demo switch.
const moreTabs = (projects: NavProject[]): MoreTab[] => [
  ...projects.map(p => ({ href: `/projects/${p.id}`, label: p.label, icon: 'chart' as const })),
  { href: '/agency', label: 'Agency', icon: 'agency' },
  { href: '/leads', label: 'Leads', icon: 'leads' },
  { href: '/customers', label: 'Customers', icon: 'customers' },
  { href: '/content', label: 'Content', icon: 'content' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  { href: '/employees', label: 'AI Employees', icon: 'bot' },
  { href: '/vault', label: 'Vault', icon: 'vault' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
]

export default function BottomNav({ projects = [] }: { projects?: NavProject[] }) {
  const path = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)
  const MORE = moreTabs(projects)
  const moreActive = MORE.some(t => isActivePath(path, t.href))
  return (
    <>
      <nav className="bottomnav">
        {PRIMARY.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className={isActivePath(path, t.href) ? 'active' : ''}
            onClick={() => setMoreOpen(false)}
          >
            <Icon name={t.icon} size={21} />
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
          <Icon name="more" size={21} />
          More
        </button>
      </nav>
      <MoreSheet tabs={MORE} open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  )
}
