'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Icon, { type IconName } from './Icon'

// 👉 The desktop sidebar tabs, grouped under micro-cap section labels.
//    Adding a tab? Add ONE line to the right group here, add the SAME tab to
//    BottomNav.tsx (bottom bar or the More sheet, so it shows on phones too),
//    and create app/<name>/page.tsx.
//    See docs/add-a-tab-prompt.md for the copy-paste prompt that does all three.
//
//    The PROJECTS group is passed IN from the layout rather than imported here:
//    which projects exist depends on the demo switch, and that lives in the
//    database — something a client component can't read.
export type NavProject = { id: string; label: string }

// `icon` is a line icon from Icon.tsx; project entries have none and show a dot.
export type NavTab = { href: string; label: string; icon?: IconName }

export const navGroups = (projects: NavProject[]): { label: string; tabs: NavTab[] }[] => [
  { label: 'Projects', tabs: [
    { href: '/', label: 'All projects', icon: 'grid' },
    ...projects.map(p => ({ href: `/projects/${p.id}`, label: p.label })),
  ] },
  { label: 'Overview', tabs: [
    { href: '/agency', label: 'Agency', icon: 'agency' },
  ] },
  { label: 'Money', tabs: [
    { href: '/cash-in', label: 'Cash In', icon: 'cash-in' },
    { href: '/cash-out', label: 'Cash Out', icon: 'cash-out' },
  ] },
  { label: 'Pipeline', tabs: [
    { href: '/leads', label: 'Leads', icon: 'leads' },
    { href: '/customers', label: 'Customers', icon: 'customers' },
  ] },
  { label: 'Work', tabs: [
    { href: '/content', label: 'Content', icon: 'content' },
    { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  ] },
  { label: 'Robot', tabs: [
    { href: '/approvals', label: 'Approvals', icon: 'approvals' },
    { href: '/employees', label: 'AI Employees', icon: 'bot' },
    { href: '/vault', label: 'Vault', icon: 'vault' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ] },
]

/**
 * Is this nav entry the page you are on? A project entry stays lit on its
 * sub-pages too (/projects/x/competitors), otherwise opening the competitor
 * library would make the sidebar look like you had left the project. "/" is
 * exact-match only, or every page would highlight Home.
 */
export function isActivePath(path: string | null, href: string): boolean {
  if (!path) return false
  if (href === '/') return path === '/'
  return path === href || path.startsWith(href + '/')
}

// `pendingCount` is an optional seam: pass it (from a server component that
// already knows the number) to show the count badge on Approvals. We never
// fetch here — a client nav must stay free of its own server round-trips.
export default function Nav({ pendingCount, projects = [] }: { pendingCount?: number; projects?: NavProject[] }) {
  const path = usePathname()
  return (
    <nav className="nav">
      {navGroups(projects).map(group => (
        <div className="nav-group" key={group.label}>
          <p className="nav-label">{group.label}</p>
          {group.tabs.map(t => (
            <Link key={t.href} href={t.href} className={isActivePath(path, t.href) ? 'active' : ''}>
              {t.icon ? <Icon name={t.icon} /> : <span className="nav-dot" aria-hidden="true" />}
              <span className="nav-text">{t.label}</span>
              {t.href === '/approvals' && pendingCount ? (
                <span className="nav-badge" aria-label={`${pendingCount} pending`}>{pendingCount}</span>
              ) : null}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
