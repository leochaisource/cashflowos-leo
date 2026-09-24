import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { demoEnabled } from '@/lib/settings'
import {
  PAGE_SIZE,
  MIGRATION_FILE,
  parseAdFilters,
  adFilterHref,
  adStatus,
  adLibraryUrl,
  thumbFor,
  keywordLabel,
  loadAds,
  loadAdSummary,
  loadAdFacets,
  type AdFilters,
  type StoredAd,
} from '@/lib/competitor-archive'
import Metric from '@/app/_components/Metric'
import ProjectTabs from '@/app/_components/ProjectTabs'
import AdThumb from '@/app/_components/AdThumb'
import { num, pct, dateLong, agoShort, clip, DASH } from '@/lib/format'

export const dynamic = 'force-dynamic'

// THE COMPETITOR ADS LIBRARY — every ad the morning research has ever stored
// for this project, browsable.
//
// Every filter is a plain link carrying a ?query (the .chips pattern), so the
// page stays a server component: no client state, the URL is shareable, and
// the back button undoes a filter. Only the thumbnail is a client component, so
// an expired Meta image can fall back to a tile instead of a broken icon.

const STATUS_LABEL = { all: 'All', live: 'Live', stale: 'Not seen lately', ended: 'Ended' } as const
const TOPIC_LABEL = { on: 'On-topic', off: 'Noise', all: 'All' } as const
const SORT_LABEL = { run: 'Longest running', first: 'Newest found', last: 'Recently seen' } as const
const TOP_ADVERTISERS = 30

export default async function CompetitorAdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  // Ad clients only: a work project (a website fix, a migration) has no market
  // to research, and a demo client doesn't exist while the demo switch is off.
  const project = getProject(id)
  if (!project) notFound()
  if (project.demo && !(await demoEnabled())) notFound()

  const f = parseAdFilters(await searchParams)
  const [ads, summary, facets] = await Promise.all([loadAds(id, f), loadAdSummary(id, f.topic), loadAdFacets(id)])
  const migrationPending = ads.migrationPending || facets.migrationPending
  // Before the migration there is no topic to filter on — the list shows every
  // ad, so the chip counts must too.
  const statusCounts = migrationPending ? { live: summary.live, stale: summary.stale, ended: summary.ended } : summary.byStatus
  const href = (patch: Partial<AdFilters>) => adFilterHref(id, f, patch)

  // The advertiser chips: the biggest 30, plus the one currently selected if
  // it is further down the list — a filter you can't see is one you can't undo.
  const topAdv = facets.advertisers.slice(0, TOP_ADVERTISERS)
  if (f.adv && !topAdv.some((a) => a.competitor === f.adv)) {
    const sel = facets.advertisers.find((a) => a.competitor === f.adv)
    if (sel) topAdv.push(sel)
  }
  const watchTags = facets.keywords.filter((k) => k.keyword.startsWith('page:'))
  const searchTags = facets.keywords.filter((k) => !k.keyword.startsWith('page:'))

  const total = ads.total ?? 0
  const from = total ? (f.page - 1) * PAGE_SIZE + 1 : 0
  const to = Math.min(f.page * PAGE_SIZE, total)
  const filtered = !!(f.adv || f.kw || f.status !== 'all' || (f.topic !== 'on' && !migrationPending) || f.run)

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>{project.name}</Link> / <Link href={`/projects/${id}/competitors`}>Competitors</Link> / Ads
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">Competitor ads — {project.client ?? project.name}</h1>
          <p className="cap">
            {num(summary.total)} stored · {num(summary.live)} live · {num(facets.advertisers.length || null)} advertisers
            {summary.firstSeen ? ` · watching since ${dateLong(summary.firstSeen)}` : ''}
          </p>
        </div>
      </div>
      <ProjectTabs id={id} current="ads" />

      {migrationPending ? (
        <p className="banner warn">
          Some of the archive isn&apos;t switched on yet — the on-topic filter and the advertiser/keyword lists need{' '}
          <code>{MIGRATION_FILE}</code> run once in the Supabase SQL editor. The ads below are complete.
        </p>
      ) : null}
      {ads.error ? <p className="banner">Couldn&apos;t load the archive: {ads.error}</p> : null}

      <div className="grid">
        <Metric label="Stored ads" value={num(summary.total)} sub="everything the research has found" />
        <Metric label="Live now" value={num(summary.live)} sub="active and seen in the last 14 days" />
        <Metric label="Running 30+ days" value={num(summary.running30)} sub="what advertisers keep paying for" />
        <Metric
          label="On-topic"
          value={summary.onTopic === null || !summary.total ? DASH : pct(summary.onTopic / summary.total)}
          sub={summary.onTopic === null ? undefined : `${num(summary.onTopic)} of ${num(summary.total)}`}
          source="needs the archive migration"
        />
      </div>

      {f.run ? (
        <p className="banner info">
          Showing what the research run for <b>{dateLong(f.run)}</b> returned
          {ads.runApproximate ? ' (approximate — that run predates per-run records, so this is what it newly discovered)' : ''}.{' '}
          <Link href={href({ run: null })}>Show all ads</Link>
        </p>
      ) : null}

      <section className="band">
        <div className="band-head">
          <h2>Filter</h2>
          {filtered ? <Link href={adFilterHref(id, { ...f, adv: null, kw: null, status: 'all', topic: 'on', run: null }, {})}>Clear filters</Link> : null}
        </div>
        <div className="chips tight">
          <span className="lab">Status</span>
          {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => (
            <Link key={s} href={href({ status: s })} className={f.status === s ? 'chip on' : 'chip'}>
              {STATUS_LABEL[s]}
              {s !== 'all' && statusCounts[s] !== null ? <span className="n">{num(statusCounts[s])}</span> : null}
            </Link>
          ))}
        </div>
        {!migrationPending ? (
          <div className="chips tight">
            <span className="lab">Topic</span>
            {(Object.keys(TOPIC_LABEL) as (keyof typeof TOPIC_LABEL)[]).map((t) => (
              <Link key={t} href={href({ topic: t })} className={f.topic === t ? 'chip on' : 'chip'}>
                {TOPIC_LABEL[t]}
              </Link>
            ))}
          </div>
        ) : null}
        <div className="chips tight">
          <span className="lab">Sort</span>
          {(Object.keys(SORT_LABEL) as (keyof typeof SORT_LABEL)[]).map((s) => (
            <Link key={s} href={href({ sort: s })} className={f.sort === s ? 'chip on' : 'chip'}>
              {SORT_LABEL[s]}
            </Link>
          ))}
        </div>
        {summary.unscored ? (
          <p className="set-note">
            {num(summary.unscored)} ad(s) haven&apos;t been scored on-topic yet — they only appear under <b>All</b>.
          </p>
        ) : null}
      </section>

      {topAdv.length ? (
        <section className="band">
          <div className="band-head">
            <h2>Advertisers</h2>
            <span>
              {facets.advertisers.length > TOP_ADVERTISERS ? `top ${TOP_ADVERTISERS} of ${num(facets.advertisers.length)}` : `${num(facets.advertisers.length)}`} · by ads stored
            </span>
          </div>
          <div className="chips">
            {topAdv.map((a) => (
              <Link
                key={a.competitor}
                href={href({ adv: f.adv === a.competitor ? null : a.competitor })}
                className={f.adv === a.competitor ? 'chip on' : 'chip'}
                title={`${a.active} active · longest run ${a.longest_run ?? '?'}d · last seen ${agoShort(a.last_seen_at)}`}
              >
                {a.competitor}
                <span className="n">{num(a.ads)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {facets.keywords.length ? (
        <section className="band">
          <div className="band-head">
            <h2>Found by</h2>
            <span>the searches and brand watches that surfaced each ad</span>
          </div>
          {watchTags.length ? (
            <div className="chips tight">
              <span className="lab">Brands</span>
              {watchTags.map((k) => (
                <Link key={k.keyword} href={href({ kw: f.kw === k.keyword ? null : k.keyword })} className={f.kw === k.keyword ? 'chip on' : 'chip'}>
                  {keywordLabel(k.keyword)}
                  <span className="n">{num(k.ads)}</span>
                </Link>
              ))}
            </div>
          ) : null}
          <div className="chips">
            <span className="lab">Keywords</span>
            {searchTags.map((k) => (
              <Link key={k.keyword} href={href({ kw: f.kw === k.keyword ? null : k.keyword })} className={f.kw === k.keyword ? 'chip on' : 'chip'}>
                {k.keyword}
                <span className="n">{num(k.ads)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {ads.rows.length ? (
        <>
          <p className="rowlabel">
            {num(total)} {!migrationPending && f.topic === 'on' ? 'on-topic ' : !migrationPending && f.topic === 'off' ? 'noise ' : ''}{total === 1 ? 'ad' : 'ads'}
            {filtered ? ' match' : ''} · {SORT_LABEL[f.sort].toLowerCase()} first
          </p>
          <div className="vgrid ads">
            {ads.rows.map((a) => (
              <AdCard key={a.id} ad={a} />
            ))}
          </div>
          <Pager f={f} from={from} to={to} total={total} href={href} />
        </>
      ) : !ads.error ? (
        <p className="empty">
          {filtered
            ? 'No stored ads match these filters.'
            : project.rank
              ? 'No competitor ads stored yet — the 8am research fills this every morning.'
              : 'No competitor ads stored. Competitor research runs only for the focus projects (ranked 1–3).'}
        </p>
      ) : null}
    </>
  )
}

function AdCard({ ad }: { ad: StoredAd }) {
  const status = adStatus(ad)
  const thumb = thumbFor(ad)
  const lib = adLibraryUrl(ad.ad_archive_id)
  const headline = ad.title?.trim() || null
  const copy = (ad.body_text ?? '').replace(/\s+/g, ' ').trim()
  const host = (() => {
    try {
      return ad.link_url ? new URL(ad.link_url).host.replace(/^www\./, '') : null
    } catch {
      return null
    }
  })()
  const fresh = Date.now() - new Date(ad.first_seen_at).getTime() < 2 * 864e5
  return (
    <article className="vcard">
      <AdThumb src={thumb?.url ?? null} href={lib} format={ad.display_format} alt={headline ?? `${ad.competitor} ad`} />
      <div className="vmeta">
        <p className="ad-head">
          <b title={ad.competitor}>{ad.competitor}</b>
          <span className={`pill ${status}`}>{status === 'stale' ? 'not seen lately' : status}</span>
        </p>
        {headline ? <p className="ad-title">{clip(headline, 110)}</p> : null}
        {copy ? <p className="ad-copy">{clip(copy, 240)}</p> : null}
        <p className="vm-sub">
          {[ad.cta_text, ad.display_format?.toLowerCase(), ad.run_days !== null ? `ran ${num(ad.run_days)}d` : null, ad.collation_count && ad.collation_count > 1 ? `${ad.collation_count} versions` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="vm-date">
          {fresh ? 'new · ' : ''}found {dateLong(ad.first_seen_at)} · last seen {agoShort(ad.last_seen_at)}
          {host ? ` · ${host}` : ''}
        </p>
        {ad.keywords?.length ? (
          <p className="ad-tags">
            {ad.keywords.slice(0, 4).map((k) => (
              <span key={k} className="tag soon">
                {keywordLabel(k)}
              </span>
            ))}
            {ad.keywords.length > 4 ? <span className="tag soon">+{ad.keywords.length - 4}</span> : null}
          </p>
        ) : null}
        <a className="ad-link" href={lib} target="_blank" rel="noopener noreferrer">
          Open in Meta Ad Library ↗
        </a>
      </div>
    </article>
  )
}

function Pager({
  f,
  from,
  to,
  total,
  href,
}: {
  f: AdFilters
  from: number
  to: number
  total: number
  href: (patch: Partial<AdFilters>) => string
}) {
  const hasPrev = f.page > 1
  const hasNext = to < total
  if (!hasPrev && !hasNext) return null
  return (
    <div className="pager">
      <p>
        Showing {num(from)}–{num(to)} of {num(total)}
      </p>
      <div className="chips tight">
        {hasPrev ? (
          <Link className="chip" href={href({ page: f.page - 1 })}>
            ← Previous
          </Link>
        ) : null}
        {hasNext ? (
          <Link className="chip" href={href({ page: f.page + 1 })}>
            Next 50 →
          </Link>
        ) : null}
      </div>
    </div>
  )
}
