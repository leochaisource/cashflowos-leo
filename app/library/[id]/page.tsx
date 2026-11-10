// One case in the AI Library, in full: what they built, how it works, the numbers
// with the page's own words, what to learn, and how it fits Leo's setup.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { dateLong } from '@/lib/format'
import { caseName, CHECK_CLASS, CHECK_LABEL, getCase, ideasFromCase } from '@/lib/ai-library'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = { improve: 'Improve', build: 'Build', try: 'Try' }

export default async function LibraryCasePage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  const c = await getCase(id)
  if (!c) notFound()
  const ideas = await ideasFromCase(id)
  const meta = [
    c.publisher,
    c.published_on && c.published_on !== 'date not shown' ? c.published_on : null,
    c.source_kind?.replace(/-/g, ' '),
    c.region,
    c.company_size && c.company_size !== 'unknown' ? (c.company_size === 'small' ? 'small team' : c.company_size === 'mid' ? 'mid-size' : c.company_size) : null,
  ].filter(Boolean)

  return (
    <>
      <p className="crumb">
        <Link href="/library">← AI Library</Link>
      </p>
      <h1 className="ph">{caseName(c)}</h1>
      <p className="cap">
        {c.title}
        <br />
        {meta.join(' · ')} · added {dateLong(c.created_at)}
      </p>

      <p className="lib-top" style={{ marginBottom: 18 }}>
        <span className={`pill ${CHECK_CLASS[c.check_status] ?? ''}`}>{CHECK_LABEL[c.check_status] ?? c.check_status}</span>
        {c.relevance ? <span className="tag soon">{c.relevance}/5 for you</span> : null}
        <a className="ad-link" href={c.url} target="_blank" rel="noopener noreferrer" style={{ marginTop: 0 }}>
          Open the source ↗
        </a>
      </p>
      {c.check_note ? <p className="banner info">{c.check_note}</p> : null}

      <section className="band">
        <div className="band-head">
          <h2>{c.pattern || 'What they built'}</h2>
          {c.business_function ? <span>{c.business_function}</span> : null}
        </div>
        <p className="lib-text">{c.summary}</p>
        {c.how_it_works.length ? (
          <>
            <p className="rowlabel" style={{ marginTop: 16 }}>
              How it works
            </p>
            <ol className="lib-list">
              {c.how_it_works.map((s, n) => (
                <li key={n}>{s}</li>
              ))}
            </ol>
          </>
        ) : null}
        {c.tools.length ? (
          <p className="ad-tags" style={{ marginTop: 12 }}>
            {c.tools.map((t) => (
              <span key={t} className="tag soon">
                {t}
              </span>
            ))}
          </p>
        ) : null}
      </section>

      {c.results.length ? (
        <section className="band">
          <div className="band-head">
            <h2>Results</h2>
            <span>{c.results.every((r) => r.claimed_by !== 'independent') ? 'their own figures' : 'mixed sources'}</span>
          </div>
          <ul className="lib-list">
            {c.results.map((r, n) => (
              <li key={n}>
                <b>{r.number}</b>: {r.claim} <span className="tag soon">{r.claimed_by === 'independent' ? 'measured independently' : 'their own figure'}</span>
                <blockquote className="lib-quote">“{r.excerpt}”</blockquote>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {c.lessons.length || c.apply_idea ? (
        <section className="band">
          <div className="band-head">
            <h2>What to take from it</h2>
          </div>
          {c.lessons.length ? (
            <ul className="lib-list">
              {c.lessons.map((l, n) => (
                <li key={n}>{l}</li>
              ))}
            </ul>
          ) : null}
          {c.apply_idea ? (
            <p className="lib-text" style={{ marginTop: 12 }}>
              <b>For your setup:</b> {c.apply_idea}
            </p>
          ) : null}
        </section>
      ) : null}

      {ideas.length ? (
        <section className="band">
          <div className="band-head">
            <h2>Ideas that came from this case</h2>
          </div>
          <ul className="lib-list">
            {ideas.map((i) => (
              <li key={i.id}>
                {i.week.replace(/^\d+-W/, 'Week ')} · {KIND[i.kind] ?? i.kind}: <b>{i.title}</b> ({i.answer})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {c.excerpts.length ? (
        <section className="band">
          <div className="band-head">
            <h2>In the page&apos;s own words</h2>
          </div>
          {c.excerpts.map((x, n) => (
            <blockquote key={n} className="lib-quote">
              “{x}”
            </blockquote>
          ))}
        </section>
      ) : null}
    </>
  )
}
