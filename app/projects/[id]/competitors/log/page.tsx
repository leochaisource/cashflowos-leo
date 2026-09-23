import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { demoEnabled } from '@/lib/settings'
import { MIGRATION_FILE, keywordLabel, loadResearchLog, loadRunDetail, type RunRow } from '@/lib/competitor-archive'
import Metric from '@/app/_components/Metric'
import ProjectTabs from '@/app/_components/ProjectTabs'
import { num, dateLong, whenShort, DASH } from '@/lib/format'

export const dynamic = 'force-dynamic'

// THE RESEARCH LOG — one row per morning: what was searched, what it cost, what
// it found, and (for the selected morning) the summary the model was handed and
// what it wrote back.
//
// A run's `date` is the day the BRIEF reports on; the searches themselves ran the
// following morning at 8am. So the table shows both: the date the brief is for,
// and when the research actually ran.

const searchesLabel = (r: RunRow) =>
  (r.searches ?? []).map((s) => `${s.keyword} (${s.country})`).join(', ') || DASH

export default async function ResearchLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const project = getProject(id)
  if (!project) notFound()
  if (project.demo && !(await demoEnabled())) notFound()

  const sp = await searchParams
  const log = await loadResearchLog(id)
  const asked = typeof sp.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : null
  const date = asked ?? log.runs[0]?.date ?? null
  const detail = date ? await loadRunDetail(id, date) : null
  const run = detail?.run ?? null
  const stats = run?.stats ?? null

  const totalCredits = log.runs.reduce((s, r) => s + (r.credits ?? 0), 0)

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>{project.name}</Link> / Research log
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">Research log — {project.client ?? project.name}</h1>
          <p className="cap">
            {num(log.runs.length || null)} morning{log.runs.length === 1 ? '' : 's'} recorded · {num(totalCredits)} Adyntel credit
            {totalCredits === 1 ? '' : 's'} spent across them
          </p>
        </div>
      </div>
      <ProjectTabs id={id} current="log" />

      {log.error ? <p className="banner">Couldn&apos;t load the research log: {log.error}</p> : null}
      {detail?.migrationPending ? (
        <p className="banner warn">
          The daily summaries aren&apos;t being kept yet — run <code>{MIGRATION_FILE}</code> once in the Supabase SQL
          editor. Credits and counts below are complete.
        </p>
      ) : null}

      {!log.runs.length && !log.error ? (
        <p className="empty">
          {project.rank
            ? 'No research runs recorded yet — the 8am brief records one every morning.'
            : 'Competitor research runs only for the focus projects (ranked 1–3).'}
        </p>
      ) : null}

      {run ? (
        <>
          <p className="rowlabel">
            Brief for {dateLong(run.date)} · research ran {whenShort(run.created_at)}
          </p>
          <div className="grid">
            <Metric label="Credits spent" value={num(run.credits)} sub={run.watch_page ? `incl. brand watch: ${run.watch_page}` : undefined} />
            <Metric label="Ads seen" value={num(run.ads_seen)} sub={run.advertisers !== null ? `${num(run.advertisers)} advertisers` : undefined} />
            <Metric label="New ideas" value={num(run.new_concepts)} sub="concepts not seen before" />
            <Metric label="New versions" value={num(run.new_variations)} sub="of ideas already tracked" />
            <Metric label="Running 30d+" value={num(stats?.running_30d ?? null)} source="recorded from the archive migration on" />
          </div>

          <section className="band">
            <div className="band-head">
              <h2>What the research found</h2>
              <span>
                {searchesLabel(run)}
                {run.watch_page ? ` · 👁 ${run.watch_page}` : ''}
              </span>
            </div>
            {run.facts_text ? (
              <pre className="brief">{run.facts_text}</pre>
            ) : (
              <p className="empty">
                The summary for this morning wasn’t kept — summaries are stored from the first morning after the archive
                migration ran. Its counts above are complete.
              </p>
            )}
            {stats?.data_quality?.length ? (
              <ul className="set-note">
                {stats.data_quality.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            ) : null}
            <p className="set-note">
              <Link href={`/projects/${id}/competitors?run=${run.date}`}>See the ads this run returned →</Link>
            </p>
          </section>

          <section className="band">
            <div className="band-head">
              <h2>What the brief said about it</h2>
              <span>{detail?.brief ? `sent ${whenShort(detail.brief.sent_at)}` : 'no brief recorded for this day'}</span>
            </div>
            {detail?.brief?.report_text ? (
              <pre className="brief">{detail.brief.report_text}</pre>
            ) : (
              <p className="empty">
                {detail?.brief
                  ? 'The written analysis is missing for this morning — the model was unavailable when the brief went out.'
                  : 'No brief was recorded for this day.'}
              </p>
            )}
          </section>
        </>
      ) : null}

      {log.runs.length ? (
        <>
          <p className="rowlabel">Every morning</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Brief for</th>
                <th>Searched</th>
                <th>Credits</th>
                <th>Ads seen</th>
                <th>New ideas</th>
                <th>New versions</th>
                <th>Brief</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {log.runs.map((r) => (
                <tr key={r.date} style={r.date === date ? { background: 'var(--clay-tint)' } : undefined}>
                  <td data-label="Brief for">
                    <Link href={`/projects/${id}/competitors/log?date=${r.date}`} style={{ fontWeight: 600, textDecoration: 'none' }}>
                      {dateLong(r.date)}
                    </Link>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>ran {whenShort(r.created_at)}</span>
                  </td>
                  <td data-label="Searched">
                    {searchesLabel(r)}
                    {r.watch_page ? (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>{keywordLabel(`page:${r.watch_page}`)}</span>
                    ) : null}
                    {r.partial?.length ? (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>⚠ more results existed than were read</span>
                    ) : null}
                  </td>
                  <td data-label="Credits">{num(r.credits)}</td>
                  <td data-label="Ads seen">
                    {num(r.ads_seen)}
                    {r.advertisers !== null ? (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>{num(r.advertisers)} advertisers</span>
                    ) : null}
                  </td>
                  <td data-label="New ideas">{num(r.new_concepts)}</td>
                  <td data-label="New versions">{num(r.new_variations)}</td>
                  <td data-label="Brief">
                    <span className={`pill ${log.briefDates.has(r.date) ? 'done' : 'nurture'}`}>
                      {log.briefDates.has(r.date) ? 'recorded' : 'none'}
                    </span>
                  </td>
                  <td data-label="">
                    <Link href={`/projects/${id}/competitors?run=${r.date}`}>ads →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  )
}
