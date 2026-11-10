// 👉 The AI LIBRARY tab — real cases of how businesses build AI agents and use AI,
// found and checked by the researcher every Tue–Fri (agents/ai-library/), plus the
// Saturday ideas for Leo's own setup. Its own tables (supabase/ai-library.sql), not
// `records`: hundreds of write-ups would slow every page that reads `records`.
// Filters are plain ?query links (the .chips pattern), so every view is a URL.
import Link from 'next/link'
import Stat from '@/app/_components/Stat'
import { clip, dateLong, num } from '@/lib/format'
import {
  caseName,
  casesByIds,
  CHECK_CLASS,
  CHECK_LABEL,
  latestIdeas,
  libraryStats,
  listCases,
  PAGE_SIZE,
  SIZES,
  TOPICS,
  type Idea,
  type LibraryCase,
} from '@/lib/ai-library'

export const dynamic = 'force-dynamic'

type Search = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

const KIND: Record<string, string> = { improve: 'Improve', build: 'Build', try: 'Try' }
const ANSWER_CLASS: Record<Idea['answer'], string> = { wanted: 'approved', 'not for me': 'rejected', waiting: 'proposed', 'no answer': 'expired' }

export default async function Library({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams
  const f = {
    q: one(sp.q).slice(0, 120),
    topic: one(sp.topic),
    size: one(sp.size),
    sort: one(sp.sort) === 'relevant' ? ('relevant' as const) : ('new' as const),
    page: Math.max(1, Number(one(sp.page)) || 1),
  }
  const href = (patch: Partial<Record<keyof typeof f, string | number | null>>) => {
    const next = { ...f, page: 1, ...patch } as Record<string, string | number | null>
    const qs = Object.entries(next)
      .filter(([k, v]) => v !== null && v !== '' && !(k === 'sort' && v === 'new') && !(k === 'page' && v === 1))
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return `/library${qs ? `?${qs}` : ''}`
  }

  const [cases, stats, ideas] = await Promise.all([listCases(f), libraryStats(), latestIdeas()])
  const ideaCases = await casesByIds(ideas.flatMap((i) => i.based_on))
  const filtered = !!(f.q || f.topic || f.size)
  const pages = Math.max(1, Math.ceil(cases.total / PAGE_SIZE))
  const run = stats.lastRun

  return (
    <>
      <h1 className="ph">AI Library 📚</h1>
      <p className="cap">
        Real cases of how businesses build AI agents and use AI at work. Your researcher adds up to 3 every Tue–Fri
        morning and checks each one against its page; every Saturday you get 3 ideas for your own setup.
      </p>

      <div className="grid">
        <Stat label="Cases" value={num(stats.total)} />
        <Stat label="Added this week" value={num(stats.thisWeek)} />
        <Stat
          label="Last research"
          value={run ? `${dateLong(run.finished_at ?? undefined) || run.key.slice(9)} · ${run.status === 'ok' ? `+${run.added}` : run.status}` : 'not yet'}
          yes={!!run && run.status !== 'ok'}
        />
        <Stat label="Ideas you wanted" value={ideas.filter((i) => i.answer === 'wanted').length ? `${ideas.filter((i) => i.answer === 'wanted').length} of ${ideas.length}` : ideas.length ? `0 of ${ideas.length}` : '—'} />
      </div>

      {ideas.length ? (
        <section className="band">
          <div className="band-head">
            <h2>This week&apos;s ideas</h2>
            <span>{ideas[0].week.replace(/^\d+-W/, 'Week ')} · ✅ on Telegram puts one on your Tasks</span>
          </div>
          <div className="lib-ideas">
            {ideas.map((i) => (
              <article key={i.id} className="lib-idea">
                <p className="lib-top">
                  <span className="tag soon">{KIND[i.kind] ?? i.kind}</span>
                  <span className={`pill ${ANSWER_CLASS[i.answer]}`}>{i.answer}</span>
                </p>
                <h3>{i.title}</h3>
                <p className="lib-text">{i.what}</p>
                <p className="lib-small">
                  <b>Why:</b> {i.why}
                </p>
                <p className="lib-small">
                  <b>First step:</b> {i.first_step}
                </p>
                <p className="lib-small">
                  {i.effort ? <>Effort: {i.effort}</> : null}
                  {i.improves ? <> · Improves: {i.improves}</> : null}
                </p>
                <p className="lib-small">
                  From:{' '}
                  {i.based_on.map((id, n) => {
                    const c = ideaCases.get(id)
                    return (
                      <span key={id}>
                        {n ? ', ' : ''}
                        <Link href={`/library/${id}`}>{c ? caseName(c) : `case #${id}`}</Link>
                      </span>
                    )
                  })}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="band">
        <form action="/library" method="get" className="lib-search">
          <input type="search" name="q" defaultValue={f.q} placeholder="Search: lead follow-up, call notes, invoices, solo founder…" aria-label="Search the library" />
          {f.topic ? <input type="hidden" name="topic" value={f.topic} /> : null}
          {f.size ? <input type="hidden" name="size" value={f.size} /> : null}
          <button type="submit" className="chip on">
            Search
          </button>
        </form>
        <div className="chips tight">
          <span className="lab">Topic</span>
          <Link href={href({ topic: null })} className={!f.topic ? 'chip on' : 'chip'}>
            All
          </Link>
          {TOPICS.map((t) => (
            <Link key={t.id} href={href({ topic: t.id })} className={f.topic === t.id ? 'chip on' : 'chip'}>
              {t.label}
            </Link>
          ))}
        </div>
        <div className="chips tight">
          <span className="lab">Size</span>
          <Link href={href({ size: null })} className={!f.size ? 'chip on' : 'chip'}>
            All
          </Link>
          {SIZES.map((s) => (
            <Link key={s} href={href({ size: s })} className={f.size === s ? 'chip on' : 'chip'}>
              {s === 'small' ? 'small team' : s === 'mid' ? 'mid-size' : s}
            </Link>
          ))}
        </div>
        <div className="chips tight">
          <span className="lab">Sort</span>
          <Link href={href({ sort: null })} className={f.sort === 'new' ? 'chip on' : 'chip'}>
            Newest
          </Link>
          <Link href={href({ sort: 'relevant' })} className={f.sort === 'relevant' ? 'chip on' : 'chip'}>
            Most useful for you
          </Link>
        </div>
      </section>

      {cases.error ? <p className="banner">Couldn&apos;t load the library: {cases.error}</p> : null}

      {cases.rows.length ? (
        <>
          <p className="rowlabel">
            {num(cases.total)} {cases.total === 1 ? 'case' : 'cases'}
            {filtered ? ' match' : ''}
          </p>
          <div className="lib-grid">
            {cases.rows.map((c) => (
              <CaseCard key={c.id} c={c} />
            ))}
          </div>
          {pages > 1 ? (
            <div className="chips">
              {f.page > 1 ? (
                <Link href={href({ page: f.page - 1 })} className="chip">
                  ← Newer
                </Link>
              ) : null}
              <span className="lab">
                Page {f.page} of {pages}
              </span>
              {f.page < pages ? (
                <Link href={href({ page: f.page + 1 })} className="chip">
                  Older →
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      ) : !cases.error ? (
        <p className="empty">{filtered ? 'No cases match. Try fewer words or another topic.' : 'No cases yet. The researcher adds up to 3 every Tue–Fri morning.'}</p>
      ) : null}
    </>
  )
}

function CaseCard({ c }: { c: LibraryCase }) {
  return (
    <article className="lib-card">
      <p className="lib-top">
        <b title={c.who ?? ''}>{caseName(c)}</b>
        <span className={`pill ${CHECK_CLASS[c.check_status] ?? ''}`} title={c.check_note ?? ''}>
          {CHECK_LABEL[c.check_status] ?? c.check_status}
        </span>
      </p>
      <h3>
        <Link href={`/library/${c.id}`}>{clip(c.pattern || c.title, 110)}</Link>
      </h3>
      <p className="lib-text">{clip(c.summary, 280)}</p>
      {c.results.length ? (
        <p className="ad-tags">
          {c.results.slice(0, 3).map((r, n) => (
            <span key={n} className="tag live" title={`${r.claim} (${r.claimed_by === 'independent' ? 'measured independently' : 'their own figure'})`}>
              {clip(r.number, 40)}
            </span>
          ))}
        </p>
      ) : null}
      {c.apply_idea ? (
        <p className="lib-small">
          <b>For you:</b> {clip(c.apply_idea, 200)}
        </p>
      ) : null}
      <p className="vm-sub">
        {[c.publisher, c.published_on && c.published_on !== 'date not shown' ? c.published_on : null, c.source_kind?.replace(/-/g, ' '), c.relevance ? `${c.relevance}/5 for you` : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <Link className="ad-link" href={`/library/${c.id}`}>
        Read the case →
      </Link>
    </article>
  )
}
