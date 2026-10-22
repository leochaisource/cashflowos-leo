import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { CORE, STAGES, journeyFor, type StageKey } from '@/lib/funnel-config'
import { funnelView } from '@/lib/funnel-view'
import { adLabel, reached, sortCreatives, stageTime, type JourneyRow, type RateRow } from '@/lib/funnel-report'
import Metric from '@/app/_components/Metric'
import ProjectTabs from '@/app/_components/ProjectTabs'
import { money, num, pct, dateLong, DASH } from '@/lib/format'
import { setBenchmark } from './actions'

export const dynamic = 'force-dynamic'

// THE FUNNEL X-RAY (owner, 2026-10-22): one event's leads, stage by stage.
//   · Full funnel — spend → leads → … → paid → revenue, with the cost of each stage.
//   · Bottleneck map — each stage's rate against its benchmark (green / yellow /
//     red), who owns it, and the money at stake if it hit the benchmark.
//   · Creative ranker — ads by what their leads became, not by cost per lead.
//   · Lead tracker — every lead's ticks; where they stop is where the lead dropped.
// Built from lead_journey (lib/lead-journey.ts, rebuilt each morning) through
// lib/funnel-view.ts, the same numbers the 8am brief and the red alert use.

const PER_PAGE = 100
const DOT: Record<string, string> = { green: 'var(--sage)', yellow: 'var(--honey)', red: 'var(--rust)', none: 'var(--line-2)' }
const hrs = (h: number | null) => (h === null ? DASH : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`)

type Search = { event?: string; funnel?: string; stop?: string; q?: string; rank?: string; page?: string }

export default async function FunnelPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params
  const sp = await searchParams
  const project = getProject(id)
  if (!project) notFound()
  const cur = project.currency || 'RM'
  const cfg = journeyFor(id)
  const v = cfg && supabaseConfigured ? await funnelView(supabase, project, { eventNo: Number(sp.event) || undefined, funnel: sp.funnel }) : null

  const head = (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>{project.name}</Link> / Funnel
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">Funnel</h1>
          <p className="cap">
            {v
              ? `${v.window.label} · ${dateLong(v.window.date)} · leads from ${dateLong(v.window.from)} · ${v.eventOpen ? 'still selling' : 'finished'}`
              : 'Where each lead stops, and which stage is worth fixing first'}
          </p>
        </div>
      </div>
      <ProjectTabs id={id} current="funnel" />
    </>
  )
  if (!v)
    return (
      <>
        {head}
        <div className="empty">
          The funnel view needs an event schedule and the WhatsApp journey set up for this project. It runs for Claude Malaysia today.
        </div>
      </>
    )

  const href = (patch: Partial<Search>) => {
    const q = new URLSearchParams()
    const merged: Search = { event: String(v.window.no), funnel: v.funnel, rank: sp.rank, stop: sp.stop, q: sp.q, ...patch }
    for (const [k, val] of Object.entries(merged)) if (val && !(k === 'funnel' && val === 'all')) q.set(k, String(val))
    return `/projects/${id}/funnel${q.size ? `?${q}` : ''}`
  }
  const r = v.report
  const webinarShown = v.funnel === 'all' ? v.rows.some((x) => x.funnel === cfg!.webinarFunnel) : v.funnel === cfg!.webinarFunnel
  const webinarLeads = v.rows.filter((x) => x.funnel === cfg!.webinarFunnel).length
  const leadsOf = (k: StageKey) => r.counts[k]
  const share = (k: StageKey) => (r.leads ? leadsOf(k) / r.leads : null)
  const bn = r.bottleneck

  return (
    <>
      {head}

      <nav className="chips" aria-label="Event">
        {v.windows.map((w) => (
          <Link key={w.no} href={href({ event: String(w.no), page: undefined })} className={w.no === v.window.no ? 'chip on' : 'chip'}>
            {w.label} · {dateLong(w.date)}
          </Link>
        ))}
      </nav>
      <nav className="chips" aria-label="Funnel">
        {['all', ...v.funnels].map((f) => (
          <Link key={f} href={href({ funnel: f, page: undefined })} className={f === v.funnel ? 'chip on' : 'chip'}>
            {f === 'all' ? 'All funnels' : f}
          </Link>
        ))}
      </nav>

      {!v.tracked && (
        <div className="banner warn">
          {v.error === 'run supabase/funnel.sql once' ? (
            <>
              <b>Only opt-ins and sales so far.</b> Paste <code>supabase/funnel.sql</code> into the Supabase SQL editor once; the
              stages in between (replied, engaged, hot, called, checkout) fill in from the next morning&apos;s refresh.
            </>
          ) : (
            <>
              <b>Only opt-ins and sales for this event.</b> The stages in between are tracked from 22 Oct 2026; earlier events
              show what the archive holds.
            </>
          )}
        </div>
      )}

      {/* ─────────────────────────────── FULL FUNNEL */}
      <p className="rowlabel">Full funnel — {v.funnel === 'all' ? 'all funnels' : v.funnel}</p>
      <div className="grid">
        <Metric label="Ad spend" value={money(r.spend, cur)} sub={v.eventOpen ? 'so far this event' : 'this event'} source="Meta ad account" />
        <Metric label="Leads" value={num(r.leads)} sub={r.costPer.optin ? `${money(r.costPer.optin, cur)} each` : undefined} source="GHL opt-in forms" />
        {webinarShown && (
          <Metric
            label="Attended webinar"
            value={v.tracked ? num(leadsOf('webinar')) : DASH}
            sub={webinarLeads ? `${pct(leadsOf('webinar') / webinarLeads)} of webinar sign-ups` : undefined}
            source="needs the journey table"
          />
        )}
        <Metric label="Replied" value={v.tracked ? num(leadsOf('replied')) : DASH} sub={`${pct(share('replied'))} of leads${r.costPer.replied ? ` · ${money(r.costPer.replied, cur)} each` : ''}`} source="needs the journey table" />
        <Metric label="Engaged" value={v.tracked ? num(leadsOf('engaged')) : DASH} sub={pct(share('engaged'))} source="needs the journey table" />
        <Metric label="Hot" value={v.tracked ? num(leadsOf('hot')) : DASH} sub={`${pct(share('hot'))}${r.costPer.hot ? ` · ${money(r.costPer.hot, cur)} each` : ''}`} source="needs the journey table" />
        <Metric label="Called" value={v.tracked ? num(leadsOf('called')) : DASH} sub={leadsOf('hot') ? `${pct(leadsOf('called') / leadsOf('hot'))} of hot leads` : undefined} source="needs the journey table" />
        <Metric label="Reached payment" value={num(leadsOf('checkout'))} sub={pct(share('checkout'))} source="GHL payments" />
        <Metric label="Customers" value={num(r.customers)} sub={`${num(r.seats)} seats${r.costPer.paid ? ` · ${money(r.costPer.paid, cur)} each` : ''}`} source="GHL payments" />
        <Metric label="Revenue" value={money(r.revenue, cur)} sub={r.roas !== null ? `${r.roas.toFixed(1)}x ad spend` : undefined} source="GHL payments" />
      </div>

      {/* ─────────────────────────────── BOTTLENECK MAP */}
      <div className="band">
        <div className="band-head">
          <h2>Bottleneck map — each stage against its benchmark</h2>
          <span>
            green at or above · yellow within {Math.round((1 - cfg!.yellowFloor) * 100)}% · red below ·{' '}
            {v.history.length ? `benchmarks: median of ${v.history.join(', ')}` : 'no finished event tracked yet: type a benchmark in'}
          </span>
        </div>
        {bn && bn.rate !== null && bn.benchmark !== null && (
          <div className={bn.status === 'red' ? 'banner' : 'banner warn'}>
            <b>Fix first: {bn.label}</b>
            {bn.owner ? ` (${bn.owner})` : ''} — {pct(bn.rate)} against a {pct(bn.benchmark)} benchmark.
            {bn.customersAtStake !== null && bn.atStake !== null
              ? ` At the benchmark this event would have about ${Math.round(bn.customersAtStake)} more customer${Math.round(bn.customersAtStake) === 1 ? '' : 's'}, roughly ${money(bn.atStake, cur)}.`
              : ''}
          </div>
        )}
        <table className="tbl adtbl">
          <thead>
            <tr>
              <th>Stage</th>
              <th style={{ width: '32%' }}>Actual vs benchmark</th>
              <th>Actual</th>
              <th>Benchmark</th>
              <th>At stake</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {r.rates.map((x) => (
              <RateLine key={x.key} x={x} cur={cur} project={id} funnel={v.funnel} isBottleneck={bn?.key === x.key} />
            ))}
          </tbody>
        </table>
        <p className="set-note">
          Each rate is out of the leads who reached the stage before it; a lead who got further counts as having passed the
          earlier stages, except the webinar and calls, which only count when they happened. While the event is still
          selling, a rate counts only leads old enough to have had the chance (2 days for the chat stages, 7 for checkout).
          &ldquo;At stake&rdquo; is what the event would gain if that stage alone hit its benchmark, at this event&apos;s
          revenue per customer.
        </p>
      </div>

      {/* ─────────────────────────────── SPEED */}
      <p className="rowlabel">Speed — the median time between stages</p>
      <div className="grid">
        <Metric label="Opt-in → their first reply" value={v.tracked ? hrs(r.speed.replyHours) : DASH} source="needs the journey table" />
        <Metric label="Hot → first call" value={v.tracked ? hrs(r.speed.callHours) : DASH} sub="from the Call Log" source="needs calls in the Call Log" />
        <Metric label="Opt-in → paid" value={r.speed.payDays === null ? DASH : `${r.speed.payDays.toFixed(1)} days`} source="GHL payments" />
      </div>

      {/* ─────────────────────────────── CREATIVE RANKER */}
      <Creatives v={v} cur={cur} rank={sp.rank === 'cpl' ? 'cpl' : 'customer'} href={href} webinarFunnel={cfg!.webinarFunnel} />

      {/* ─────────────────────────────── LEAD TRACKER */}
      <Tracker
        rows={v.rows}
        tracked={v.tracked}
        stop={sp.stop}
        q={sp.q}
        page={Math.max(1, Number(sp.page) || 1)}
        href={href}
        locationId={project.ghl ? process.env[project.ghl.locationEnv]?.trim() ?? '' : ''}
        showWebinar={webinarShown}
      />
    </>
  )
}

function RateLine({ x, cur, project, funnel, isBottleneck }: { x: RateRow; cur: string; project: string; funnel: string; isBottleneck: boolean }) {
  const scale = Math.max(x.rate ?? 0, x.benchmark ?? 0, 0.01) * 1.15
  const w = (n: number | null) => `${Math.min(100, ((n ?? 0) / scale) * 100)}%`
  return (
    <tr style={isBottleneck ? { background: 'var(--clay-tint)' } : undefined}>
      <td data-label="Stage">
        <b style={{ fontWeight: 600 }}>{x.label}</b>
        <span className="adcamp">
          {x.base ? `${num(x.hit)} of ${num(x.base)}` : ''}
          {x.note ? `${x.base ? ' · ' : ''}${x.note}` : ''}
        </span>
      </td>
      <td data-label="Actual vs benchmark">
        <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'var(--paper-2)' }}>
          {x.rate !== null && <div style={{ position: 'absolute', inset: 0, width: w(x.rate), borderRadius: 5, background: DOT[x.status] === DOT.none ? 'var(--ink-faint)' : DOT[x.status] }} />}
          {x.benchmark !== null && <div title="benchmark" style={{ position: 'absolute', top: -4, left: w(x.benchmark), width: 2, height: 18, background: 'var(--ink)' }} />}
        </div>
      </td>
      <td data-label="Actual">
        <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: DOT[x.status], marginRight: 6 }} aria-hidden />
        {pct(x.rate, 1)}
      </td>
      <td data-label="Benchmark">
        <form action={setBenchmark} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="hidden" name="project" value={project} />
          <input type="hidden" name="funnel" value={funnel} />
          <input type="hidden" name="rate" value={x.key} />
          <input
            name="value"
            defaultValue={x.benchmark === null ? '' : (x.benchmark * 100).toFixed(1).replace(/\.0$/, '')}
            placeholder="%"
            aria-label={`${x.label} benchmark, percent`}
            style={{ width: 58, padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, background: 'var(--card)' }}
          />
          <button type="submit" className="chip" style={{ padding: '3px 9px' }}>
            Set
          </button>
          {x.benchmarkSource === 'manual' ? <span className="adcamp">yours</span> : null}
        </form>
      </td>
      <td data-label="At stake">{x.atStake !== null ? money(x.atStake, cur) : DASH}</td>
      <td data-label="Owner">{x.owner ?? DASH}</td>
    </tr>
  )
}

function Creatives({
  v,
  cur,
  rank,
  href,
  webinarFunnel,
}: {
  v: NonNullable<Awaited<ReturnType<typeof funnelView>>>
  cur: string
  rank: 'customer' | 'cpl'
  href: (p: Partial<Search>) => string
  webinarFunnel?: string
}) {
  const byFunnel = new Map<string, typeof v.creatives>()
  for (const c of v.creatives) (byFunnel.get(c.funnel) ?? byFunnel.set(c.funnel, []).get(c.funnel)!).push(c)
  const stageName = (s: StageKey | null) => STAGES.find((x) => x.key === s)?.short ?? DASH
  return (
    <div className="band">
      <div className="band-head">
        <h2>Creative ranker — ads by what their leads became</h2>
        <span>
          <Link href={href({ rank: 'customer' })} className={rank === 'customer' ? 'chip on' : 'chip'} style={{ padding: '3px 10px' }}>
            Cost per customer
          </Link>{' '}
          <Link href={href({ rank: 'cpl' })} className={rank === 'cpl' ? 'chip on' : 'chip'} style={{ padding: '3px 10px' }}>
            Cost per lead
          </Link>
        </span>
      </div>
      {[...byFunnel].map(([funnel, rows]) => (
        <div key={funnel} style={{ marginBottom: 18 }}>
          <p className="rowlabel">
            {funnel}
            {v.eventOpen && funnel === webinarFunnel ? ' · still maturing: webinar leads buy after the webinar' : ''}
          </p>
          <table className="tbl adtbl">
            <thead>
              <tr>
                <th>Ad</th>
                <th>Leads</th>
                <th>Customers</th>
                <th>Spend</th>
                <th className={rank === 'customer' ? 'hl' : undefined}>Per customer</th>
                <th className={rank === 'cpl' ? 'hl' : undefined}>Per lead</th>
                <th>Lead → customer</th>
                {v.tracked && <th>Drops most at</th>}
              </tr>
            </thead>
            <tbody>
              {sortCreatives(rows, rank).map((c) => (
                <tr key={c.ad}>
                  <td data-label="Ad">
                    <span className="adname">{c.ad}</span>
                  </td>
                  <td data-label="Leads">{num(c.leads)}</td>
                  <td data-label="Customers">
                    {num(c.customers)}
                    {c.seats > c.customers ? <span className="adcamp">{num(c.seats)} seats</span> : null}
                  </td>
                  <td data-label="Spend">{money(c.spend, cur)}</td>
                  <td data-label="Per customer" className={rank === 'customer' ? 'hl' : undefined}>
                    {c.costPerCustomer !== null ? money(c.costPerCustomer, cur) : c.spend ? <span className="noleads">no customer yet</span> : DASH}
                  </td>
                  <td data-label="Per lead" className={rank === 'cpl' ? 'hl' : undefined}>
                    {money(c.cpl, cur)}
                  </td>
                  <td data-label="Lead → customer">{pct(c.leadToCustomer, 1)}</td>
                  {v.tracked && <td data-label="Drops most at">{stageName(c.weakStage)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="set-note">
        Each customer counts for the ad on their first sign-up form this event (the form link carries the ad name). Leads who
        came in through a link without it sit under &ldquo;{adLabel(null)}&rdquo;. Webinar leads usually buy after the webinar,
        so while the event is selling their ads look worse than they will. &ldquo;Drops most at&rdquo; is the stage where that
        ad&apos;s leads fall furthest behind the funnel&apos;s other leads: an early stage points at the ad&apos;s promise, a
        late one at the sales follow-up.
      </p>
    </div>
  )
}

function Tracker(props: { rows: JourneyRow[]; tracked: boolean; stop?: string; q?: string; page: number; href: (p: Partial<Search>) => string; locationId: string; showWebinar: boolean }) {
  const { rows, tracked, href } = props
  const cols = STAGES.filter((s) => s.key !== 'webinar' || props.showWebinar)
  const furthest = (r: JourneyRow): StageKey => [...CORE].reverse().find((s) => reached(r, s)) ?? 'optin'
  const stops: { key: string; label: string }[] = [
    { key: '', label: 'Everyone' },
    { key: 'optin', label: 'Never replied' },
    { key: 'replied', label: 'Replied, not engaged' },
    { key: 'engaged', label: 'Engaged, not hot' },
    { key: 'hot', label: 'Hot, no checkout' },
    { key: 'checkout', label: 'Checkout, not paid' },
    { key: 'paid', label: 'Paid' },
  ]
  const q = (props.q ?? '').trim().toLowerCase()
  const filtered = rows.filter((r) => (!props.stop || furthest(r) === props.stop) && (!q || (r.name ?? '').toLowerCase().includes(q)))
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const page = Math.min(props.page, pages)
  const shown = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  return (
    <div className="band">
      <div className="band-head">
        <h2>Lead tracker — where the ticks stop is where the lead dropped</h2>
        <span>
          {num(filtered.length)} lead{filtered.length === 1 ? '' : 's'}
          {pages > 1 ? ` · page ${page} of ${pages}` : ''}
        </span>
      </div>
      <nav className="chips" aria-label="Stopped at">
        {stops.map((s) => (
          <Link key={s.key || 'all'} href={href({ stop: s.key || undefined, page: undefined })} className={(props.stop ?? '') === s.key ? 'chip on' : 'chip'}>
            {s.label}
          </Link>
        ))}
      </nav>
      <form method="get" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['event', 'funnel', 'stop', 'rank'] as const).map((k) => {
          const val = new URL(href({}), 'http://x').searchParams.get(k)
          return val ? <input key={k} type="hidden" name={k} value={val} /> : null
        })}
        <input name="q" defaultValue={props.q ?? ''} placeholder="Search a name" aria-label="Search a lead by name" style={{ flex: 1, maxWidth: 260, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)' }} />
        <button type="submit" className="chip">
          Search
        </button>
      </form>
      {!tracked && <p className="set-note" style={{ marginTop: 0 }}>Only opt-in, checkout and paid are known for this event — the other ticks need the journey table.</p>}
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl adtbl" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th>Name</th>
              {cols.map((s) => (
                <th key={s.key} style={{ textAlign: 'center', padding: '11px 4px' }}>
                  {s.short}
                </th>
              ))}
              <th>On the list</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.contact_id}>
                <td data-label="Lead">
                  {props.locationId ? (
                    <a className="adname" href={`https://app.gohighlevel.com/v2/location/${props.locationId}/contacts/detail/${r.contact_id}`} target="_blank" rel="noreferrer">
                      {r.name || 'Unnamed lead'}
                    </a>
                  ) : (
                    <span className="adname">{r.name || 'Unnamed lead'}</span>
                  )}
                  <span className="adcamp">
                    {r.funnel ?? 'Other'} · {adLabel(r.ad_name)} · {dateLong(r.opted_in_at.slice(0, 10))}
                  </span>
                </td>
                {cols.map((s) => {
                  const own = !!stageTime(r, s.key)
                  const passed = !own && CORE.includes(s.key) && reached(r, s.key)
                  return (
                    <td key={s.key} style={{ padding: '11px 3px' }} title={own ? `${s.label}: ${stageTime(r, s.key)!.slice(0, 16).replace('T', ' ')} UTC` : passed ? `${s.label}: got past it without it being seen` : s.label}>
                      <div style={{ height: 8, borderRadius: 4, background: own ? 'var(--sage)' : passed ? 'rgba(75,122,90,.30)' : 'var(--paper-2)' }} />
                    </td>
                  )
                })}
                <td data-label="On the list">{r.list_stage ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="chips" aria-label="Pages" style={{ marginTop: 12 }}>
          {page > 1 && (
            <Link href={href({ page: String(page - 1) })} className="chip">
              Previous
            </Link>
          )}
          {page < pages && (
            <Link href={href({ page: String(page + 1) })} className="chip">
              Next
            </Link>
          )}
        </nav>
      )}
      <p className="set-note">
        A full tick is a stage the lead was seen to reach; a pale tick is a stage they got past without it being seen (a
        direct buyer who paid without ever chatting). Names open the contact in GHL.
      </p>
    </div>
  )
}
