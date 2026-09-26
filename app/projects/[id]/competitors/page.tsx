import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { demoEnabled } from '@/lib/settings'
import {
  PAGE_SIZE,
  PROFILES_MIGRATION_FILE,
  parseProfileFilters,
  profileFilterHref,
  adsOfHref,
  loadProfiles,
  type CompetitorProfile,
  type ProfileFilters,
  type ProfileShow,
  type ProfileSort,
} from '@/lib/competitor-archive'
import type { Landing } from '@/lib/competitor-profiles'
import Metric from '@/app/_components/Metric'
import ProjectTabs from '@/app/_components/ProjectTabs'
import { num, dateLong, agoShort, DASH } from '@/lib/format'

export const dynamic = 'force-dynamic'

// THE COMPETITORS LIST — who is in this market, one row each: their Facebook
// page, where their ads send people, and what they sell and why a buyer would
// pick them.
//
// Read from competitor_profiles, which the 8am run keeps current from the ads
// it stores (lib/competitor-profiles.ts). The ads themselves are one click
// away in the library, filtered to that advertiser.
//
// Advertisers the keyword search merely dragged in (software vendors, expos,
// unrelated courses) keep a row — it's the evidence for why they were ruled
// out — but sit behind the "Not competitors" chip instead of in the list.

const SHOW_LABEL: Record<ProfileShow, string> = { competitors: 'Competitors', others: 'Not competitors', all: 'All advertisers' }
const SORT_LABEL: Record<ProfileSort, string> = {
  active: 'Most active',
  ads: 'Most ads',
  run: 'Longest running',
  new: 'Newest found',
  name: 'A–Z',
}

export default async function CompetitorsPage({
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

  const f = parseProfileFilters(await searchParams)
  const { rows, total, counts, error, migrationPending } = await loadProfiles(id, f)
  const href = (patch: Partial<ProfileFilters>) => profileFilterHref(id, f, patch)
  const showCount: Record<ProfileShow, number | null> = {
    competitors: counts.competitors,
    others: counts.others,
    all: counts.competitors === null || counts.others === null ? null : counts.competitors + counts.others,
  }
  const t = total ?? 0
  const from = t ? (f.page - 1) * PAGE_SIZE + 1 : 0
  const to = Math.min(f.page * PAGE_SIZE, t)

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>{project.name}</Link> / Competitors
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">Competitors — {project.client ?? project.name}</h1>
          <p className="cap">
            {counts.competitors === null
              ? 'Everyone the morning research has found selling into this market.'
              : `${num(counts.competitors)} found so far · ${num(counts.advertisingNow)} advertising now` +
                (counts.others ? ` · ${num(counts.others)} other advertisers ruled out` : '')}
          </p>
        </div>
      </div>
      <ProjectTabs id={id} current="competitors" />

      {migrationPending ? (
        <p className="banner warn">
          The competitor list isn&apos;t switched on yet — it needs <code>{PROFILES_MIGRATION_FILE}</code> run once in the
          Supabase SQL editor. After that it&apos;s built from the ads already stored, and the 8am research keeps it current.
        </p>
      ) : null}
      {error ? <p className="banner">Couldn&apos;t load the competitors: {error}</p> : null}

      {!migrationPending && !error ? (
        <>
          <div className="grid">
            <Metric label="Competitors" value={num(counts.competitors)} sub="found by the research so far" />
            <Metric label="Advertising now" value={num(counts.advertisingNow)} sub="with an ad live in the last 14 days" />
            <Metric label="New this week" value={num(counts.newThisWeek)} sub="first found in the last 7 days" />
            <Metric
              label="USP written"
              value={counts.competitors === null || counts.uspPending === null ? DASH : num(counts.competitors - counts.uspPending)}
              sub={counts.uspPending ? `${num(counts.uspPending)} still pending` : 'for every competitor'}
            />
          </div>

          <section className="band">
            <div className="band-head">
              <h2>Filter</h2>
              {f.show !== 'competitors' || f.q ? <Link href={profileFilterHref(id, { ...f, show: 'competitors', q: null }, {})}>Clear filters</Link> : null}
            </div>
            <div className="chips tight">
              <span className="lab">Show</span>
              {(Object.keys(SHOW_LABEL) as ProfileShow[]).map((s) => (
                <Link key={s} href={href({ show: s })} className={f.show === s ? 'chip on' : 'chip'}>
                  {SHOW_LABEL[s]}
                  {showCount[s] !== null ? <span className="n">{num(showCount[s])}</span> : null}
                </Link>
              ))}
            </div>
            <div className="chips tight">
              <span className="lab">Sort</span>
              {(Object.keys(SORT_LABEL) as ProfileSort[]).map((s) => (
                <Link key={s} href={href({ sort: s })} className={f.sort === s ? 'chip on' : 'chip'}>
                  {SORT_LABEL[s]}
                </Link>
              ))}
            </div>
            {/* A plain GET form: the search is just another ?query, like the chips. */}
            <form className="cmp-search" action={`/projects/${encodeURIComponent(id)}/competitors`}>
              {f.show !== 'competitors' ? <input type="hidden" name="show" value={f.show} /> : null}
              {f.sort !== 'active' ? <input type="hidden" name="sort" value={f.sort} /> : null}
              <input
                className="entry-in"
                type="search"
                name="q"
                defaultValue={f.q ?? ''}
                placeholder="Search name, USP, offer — e.g. HRD"
                aria-label="Search competitors"
              />
              <button className="btn ghost" type="submit">
                Search
              </button>
            </form>
          </section>

          {rows.length ? (
            <>
              <p className="rowlabel">
                {num(t)} {f.show === 'others' ? 'ruled out' : f.show === 'all' ? 'advertisers' : t === 1 ? 'competitor' : 'competitors'}
                {f.q ? ` matching “${f.q}”` : ''} · {SORT_LABEL[f.sort].toLowerCase()} first
              </p>
              <table className="tbl cmp-tbl">
                <thead>
                  <tr>
                    <th>Competitor</th>
                    <th>Ads lead to</th>
                    <th>USP &amp; offer</th>
                    <th>Ads</th>
                    <th>Longest run</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <ProfileRow key={p.id} id={id} p={p} />
                  ))}
                </tbody>
              </table>
              <Pager f={f} from={from} to={to} total={t} href={href} />
            </>
          ) : (
            <p className="empty">
              {f.q
                ? `No ${f.show === 'others' ? 'ruled-out advertisers' : 'competitors'} match “${f.q}”.`
                : f.show === 'others'
                  ? 'Nobody has been ruled out yet.'
                  : project.rank
                    ? 'No competitors recorded yet — the 8am research adds them as it finds their ads.'
                    : 'Competitor research runs only for the focus projects (ranked 1–3).'}
            </p>
          )}
        </>
      ) : null}
    </>
  )
}

function ProfileRow({ id, p }: { id: string; p: CompetitorProfile }) {
  return (
    <tr>
      <td data-label="Competitor" className="cmp-name">
        {p.page_url ? (
          <a href={p.page_url} target="_blank" rel="noopener noreferrer" title="Open their Facebook page">
            {p.competitor} ↗
          </a>
        ) : (
          <b>{p.competitor}</b>
        )}
        <span className="cmp-sub">
          {p.first_seen_at ? `found ${dateLong(p.first_seen_at)}` : null}
          {p.last_seen_at ? ` · seen ${agoShort(p.last_seen_at)}` : null}
        </span>
        <Link className="ad-link" href={adsOfHref(id, p.competitor)}>
          See their ads →
        </Link>
      </td>
      <td data-label="Ads lead to" className="cmp-land">
        {p.landings?.length ? (
          <ul>
            {p.landings.map((l) => (
              <li key={`${l.kind}|${l.url ?? l.label}`}>
                <LandingLink l={l} />
                {p.landings.length > 1 ? <span className="cmp-n"> · {num(l.ads)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          DASH
        )}
      </td>
      <td data-label="USP & offer" className="cmp-usp">
        {/* The angle is what the 8am summary says about them; the USP is the full sentence. */}
        {p.angle ? <p className="cmp-angle">{p.angle}</p> : null}
        {p.usp ? <p>{p.usp}</p> : <p className="cmp-pending">USP not written yet.</p>}
        {p.offer ? (
          <p className="cmp-offer">
            <span className="tag proactive">Offer</span> {p.offer}
          </p>
        ) : null}
      </td>
      <td data-label="Ads" className="cmp-num">
        <span>
          {p.active_ads ? (
            <>
              <b>{num(p.active_ads)}</b> live
            </>
          ) : (
            'none live'
          )}
          <span className="cmp-sub">of {num(p.ads)} stored</span>
        </span>
      </td>
      <td data-label="Longest run" className="cmp-num">
        {p.longest_run !== null ? `${num(p.longest_run)} days` : DASH}
      </td>
    </tr>
  )
}

const LANDING_ICON: Record<Landing['kind'], string> = {
  website: '🔗',
  whatsapp: '💬',
  messenger: '💬',
  instagram: '📷',
  form: '📝',
  facebook: 'f',
  none: '·',
}

function LandingLink({ l }: { l: Landing }) {
  const icon = <span aria-hidden="true">{LANDING_ICON[l.kind]} </span>
  return l.url ? (
    <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" title={l.url}>
      {icon}
      {l.label}
    </a>
  ) : (
    <span>
      {icon}
      {l.label}
    </span>
  )
}

function Pager({
  f,
  from,
  to,
  total,
  href,
}: {
  f: ProfileFilters
  from: number
  to: number
  total: number
  href: (patch: Partial<ProfileFilters>) => string
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
            Next {PAGE_SIZE} →
          </Link>
        ) : null}
      </div>
    </div>
  )
}
