import Link from 'next/link'
import { PROJECTS } from '@/lib/ad-clients'
import { scorecards, ratio } from '@/lib/metrics'
import { getRecords, m, type Rec } from '@/lib/records'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import ProjectCard from '@/app/_components/ProjectCard'
import Stat from '@/app/_components/Stat'
import { money, num } from '@/lib/format'

export const dynamic = 'force-dynamic'

// HOME = THE PROJECTS.
//
// This used to be one funnel and one money row for "the business" — which was
// right when there was one business. There are now several client projects, each
// with its own ad account, its own funnel and its own economics, and averaging
// them together hides the only thing worth knowing: which one is working.
//
// The old whole-business view still exists, at /agency.

// 30 days, not 7 or 14: these campaigns run in bursts, and a fortnight between
// flights would empty every tile on a client who is simply between campaigns.
const WINDOW_DAYS = 30

async function proposedCount(): Promise<number> {
  if (!supabaseConfigured) return 0
  const { count, error } = await supabase
    .from('agent_actions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'proposed')
  if (error) return 0
  return count ?? 0
}

export default async function Home() {
  const [cards, waiting, rows] = await Promise.all([
    scorecards(PROJECTS, WINDOW_DAYS),
    proposedCount(),
    getRecords(),
  ])

  const all = PROJECTS.map((p) => ({ project: p, card: cards.get(p.id)! }))
  const live = all.filter((x) => x.card.hasDelivery)

  // The agency line. Blended CPL is spend ÷ leads across every project that
  // actually delivered — NOT the average of each project's CPL, which would let
  // a project that spent RM20 swing the number as hard as one that spent RM2000.
  const spend = live.reduce((s, x) => s + x.card.spend, 0)
  const leads = live.reduce((s, x) => s + x.card.leads, 0)
  const activeAds = all.reduce((s, x) => s + (x.card.activeAds ?? 0), 0)
  const blendedCPL = ratio(spend, leads)

  // Anything in `records` that isn't one of the ad projects — the old Projects
  // tab's rows. Kept visible so nothing you'd typed in disappeared with the
  // makeover, but no longer the headline.
  const otherWork = (rows as Rec[])
    .filter((r) => r.category === 'project')
    .sort((a, b) => ((a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1))

  return (
    <>
      <h1 className="ph">Projects</h1>
      <p className="cap">
        Every client, separately. Last {WINDOW_DAYS} days · click one for its full scorecard.
      </p>

      <div className="grid">
        <Stat label={`Spend · ${WINDOW_DAYS}d`} value={money(spend)} />
        <Stat label="Leads" value={num(leads)} />
        <Stat label="Blended CPL" value={money(blendedCPL)} />
        <Stat label="Active ads" value={activeAds} />
        <Stat label="🙋 Needs your YES" value={waiting} yes={waiting > 0} href="/approvals" />
      </div>

      <p className="rowlabel">The projects</p>
      <div className="pgrid">
        {all.map(({ project, card }) => (
          <ProjectCard key={project.id} project={project} card={card} />
        ))}
      </div>

      {otherWork.length > 0 && (
        <>
          <p className="rowlabel">Other work</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                <th>Phase</th>
                <th>Deadline</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {otherWork.map((r) => (
                <tr key={r.id}>
                  <td data-label="Project">{r.title}</td>
                  <td data-label="Client">{m(r, 'client')}</td>
                  <td data-label="Phase">{m(r, 'phase')}</td>
                  <td data-label="Deadline">{r.due_date ?? '—'}</td>
                  <td data-label="Status">
                    <span className={`pill ${(r.status || '').toLowerCase()}`}>{r.status || '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="cap" style={{ marginTop: 22 }}>
        Looking for the whole-business funnel and money row? It moved to{' '}
        <Link href="/agency">Agency</Link>.
      </p>
    </>
  )
}
