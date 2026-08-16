import Link from 'next/link'
import { activeProjects } from '@/lib/settings'
import { scorecards, ratio } from '@/lib/metrics'
import { getRecords, todayISO } from '@/lib/records'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import ProjectCard from '@/app/_components/ProjectCard'
import Stat from '@/app/_components/Stat'
import { workProjectsFrom, stepsSummary } from '@/lib/work-projects'
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
  // Which projects exist right now depends on the demo switch (lib/settings.ts).
  const projects = await activeProjects()
  const [cards, waiting, rows] = await Promise.all([
    scorecards(projects, WINDOW_DAYS),
    proposedCount(),
    getRecords(),
  ])

  const all = projects.map((p) => ({ project: p, card: cards.get(p.id)! }))
  const live = all.filter((x) => x.card.hasDelivery)

  // The agency line. Blended CPL is spend ÷ leads across every project that
  // actually delivered — NOT the average of each project's CPL, which would let
  // a project that spent RM20 swing the number as hard as one that spent RM2000.
  const spend = live.reduce((s, x) => s + x.card.spend, 0)
  const leads = live.reduce((s, x) => s + x.card.leads, 0)
  const activeAds = all.reduce((s, x) => s + (x.card.activeAds ?? 0), 0)
  const blendedCPL = ratio(spend, leads)

  const today = todayISO()
  const work = workProjectsFrom(rows)

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

      <p className="rowlabel">The ad clients</p>
      <div className="pgrid">
        {all.map(({ project, card }) => (
          <ProjectCard key={project.id} project={project} card={card} steps={stepsSummary(rows, project.id, today)} />
        ))}
      </div>

      {/* The rest of the plate: every work project, what stage it's at, and the
          next step with its deadline. Click through to add/tick steps. */}
      {work.length > 0 && (
        <>
          <p className="rowlabel">Work projects</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Project</th>
                <th>Phase</th>
                <th>Target</th>
                <th>Next step</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {work.map((w) => {
                const s = stepsSummary(rows, w.slug, today)
                const overdueProject = !!w.due && w.due < today && !['done', 'completed', 'closed'].includes(w.status.toLowerCase())
                return (
                  <tr key={w.slug}>
                    <td data-label="Project">
                      <Link href={`/projects/${w.slug}`} style={{ fontWeight: 600, textDecoration: 'none' }}>
                        {w.name}
                      </Link>
                      {w.client ? <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>{w.client}</span> : null}
                    </td>
                    <td data-label="Phase">{w.phase ?? '—'}</td>
                    <td data-label="Target" style={overdueProject ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>
                      {w.due ?? '—'}
                    </td>
                    <td data-label="Next step">
                      {s.next ? (
                        <>
                          {s.next.title.length > 48 ? s.next.title.slice(0, 48) + '…' : s.next.title}
                          <span style={{ display: 'block', fontSize: 12, color: s.next.overdue ? 'var(--rust)' : 'var(--dim)' }}>
                            {s.next.due ? (s.next.overdue ? `${s.next.due} · overdue` : s.next.due) : 'no deadline set'}
                            {s.open > 1 ? ` · +${s.open - 1} more` : ''}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--dim)' }}>nothing open</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`pill ${overdueProject ? 'overdue' : w.status.toLowerCase()}`}>
                        {overdueProject ? 'overdue' : w.status}
                      </span>
                    </td>
                  </tr>
                )
              })}
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
