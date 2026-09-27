import Link from 'next/link'
import { getProject } from '@/lib/ad-clients'

// The views of one ad-client project, as a row of chips under the page
// header. Server component — plain links, no client JS. "Your share" appears
// only for a client whose deal pays Leo a share of profit (lib/deal.ts).

export type ProjectTab = 'scorecard' | 'share' | 'competitors' | 'ads' | 'log'

export default function ProjectTabs({ id, current }: { id: string; current: ProjectTab }) {
  const base = `/projects/${encodeURIComponent(id)}`
  const tabs: { key: ProjectTab; href: string; label: string }[] = [
    { key: 'scorecard', href: base, label: 'Scorecard' },
    ...(getProject(id)?.deal ? [{ key: 'share' as const, href: `${base}/share`, label: 'Your share' }] : []),
    { key: 'competitors', href: `${base}/competitors`, label: 'Competitors' },
    { key: 'ads', href: `${base}/competitors/ads`, label: 'Competitor ads' },
    { key: 'log', href: `${base}/competitors/log`, label: 'Research log' },
  ]
  return (
    <nav className="chips" aria-label="Project views">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={t.key === current ? 'chip on' : 'chip'} aria-current={t.key === current ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
