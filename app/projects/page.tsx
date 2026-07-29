// 👉 This is a normal tab — safe to tweak. It reads the ONE `records` table,
// filters to category==='project', and lists what you're running. Copy this
// file's shape (see docs/add-a-tab-prompt.md) when you add your own tab.
import Link from 'next/link'
import { getRecords, todayISO, m, type Rec } from '@/lib/records'
import Empty from '@/app/_components/Empty'
import Stat from '@/app/_components/Stat'

export const dynamic = 'force-dynamic'

// The projects you're running. category==='project'. Per row: who it's for
// (meta.client), what stage it's at (meta.phase), and when it's due (due_date).
// A project's `status` is where it sits in its life: active → paused → done.
//
// The chips at the top are the "select": each is a plain <Link> to this same
// page with ?status=…, so the tab stays a SERVER component (no client fetch,
// no useState) — the URL is the filter, and it's shareable/bookmarkable.
const FILTERS: { key: string; label: string; statuses: string[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  // Tolerant of however you word it when you type the row in.
  { key: 'active', label: 'Active', statuses: ['active', 'running', 'in progress', 'in_progress', 'building', 'live'] },
  { key: 'paused', label: 'Paused', statuses: ['paused', 'on hold', 'on_hold', 'hold', 'blocked'] },
  { key: 'done', label: 'Done', statuses: ['done', 'completed', 'complete', 'closed', 'shipped'] },
]

const DONE = FILTERS.find(f => f.key === 'done')!.statuses!

const st = (r: Rec) => (r.status || '').toLowerCase()

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const today = todayISO()
  const { status } = await searchParams
  // Unknown ?status= values fall back to "all" rather than showing an empty tab.
  const active = FILTERS.some(f => f.key === status) ? (status as string) : 'all'
  const current = FILTERS.find(f => f.key === active)!

  const all = await getRecords()
  const projects = all
    .filter(r => r.category === 'project')
    // Soonest deadline first; undated projects sink to the bottom.
    .sort((a, b) => ((a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1))

  const inFilter = (f: (typeof FILTERS)[number], r: Rec) => !f.statuses || f.statuses.includes(st(r))
  const rows = projects.filter(r => inFilter(current, r))

  // Past its deadline and not finished — the same red flag the Tasks tab uses.
  const isOverdue = (r: Rec) => !!r.due_date && r.due_date < today && !DONE.includes(st(r))

  const running = projects.filter(r => inFilter(FILTERS[1], r))
  const overdue = projects.filter(isOverdue).length
  // The next deadline you're walking into, across everything still running.
  const nextDue = running.map(r => r.due_date).filter(Boolean).sort()[0] ?? '—'

  return (
    <>
      <h1 className="ph">Projects 🗂️</h1>
      <p className="cap">What you&apos;re running — pick a slice to see just those.</p>

      <div className="grid">
        <Stat label="Running now" value={running.length} />
        <Stat label="Past deadline" value={overdue} yes={overdue > 0} />
        <Stat label="Next deadline" value={nextDue} />
      </div>

      {/* The selector. Counts are of ALL projects, so they don't change as you
          click. Hidden until you have at least one project — four zeroes above
          an empty box is noise. */}
      {projects.length > 0 && (
        <div className="chips">
          {FILTERS.map(f => {
            const n = projects.filter(r => inFilter(f, r)).length
            return (
              <Link
                key={f.key}
                href={f.key === 'all' ? '/projects' : `/projects?status=${f.key}`}
                className={`chip${f.key === active ? ' on' : ''}`}
                aria-current={f.key === active ? 'page' : undefined}
              >
                {f.label} <span className="n">{n}</span>
              </Link>
            )
          })}
        </div>
      )}

      {projects.length === 0 ? (
        <Empty label="projects" />
      ) : rows.length === 0 ? (
        <div className="empty">
          No {current.label.toLowerCase()} projects right now.{' '}
          <Link href="/projects">Show all</Link>.
        </div>
      ) : (
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
            {rows.map(r => {
              const od = isOverdue(r)
              return (
                <tr key={r.id}>
                  <td data-label="Project">{r.title}</td>
                  <td data-label="Client">{m(r, 'client')}</td>
                  <td data-label="Phase">{m(r, 'phase')}</td>
                  <td data-label="Deadline" style={od ? { color: 'var(--rust)' } : undefined}>
                    {r.due_date ?? '—'}
                  </td>
                  <td data-label="Status">
                    <span className={`pill ${od ? 'overdue' : st(r)}`}>
                      {od ? 'overdue' : r.status || '—'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
