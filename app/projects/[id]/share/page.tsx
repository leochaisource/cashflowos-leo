import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import type { ShareResult } from '@/lib/deal'
import Metric from '@/app/_components/Metric'
import ProjectTabs from '@/app/_components/ProjectTabs'
import { money, num, dateLong, DASH } from '@/lib/format'

export const dynamic = 'force-dynamic'

// YOUR SHARE — what Leo is earning on this client's profit-share deal, event by
// event, laid out the way the agreement's worked example lays it out.
//
// Reads the snapshots the 8am run stores in deal_daily (lib/deal-estimate.ts),
// so this page and the morning Telegram message always agree. The buyer list
// under it shows how each seat was classified when the seat split comes from
// our own GHL reading rather than the House's EventOps report.

type Snapshot = {
  date: string
  event_no: number | null
  event_date: string | null
  source: string | null
  inputs: {
    adsSeats: number
    organicSeats: number
    unknownSeats: number
    adSpend: number
    seats?: { ads: number; organic: number; unknown: number; total: number }
    from?: string
    to?: string
    sourceNote?: string
  }
  result: ShareResult & {
    marginals?: { nextAdsSeat: number; extra100Spend: number; breakEven: number | null; perSeatAfterBreakEven: number }
    standards?: { adsSeats: number; adsSeatsTarget: number; costPerTicket: number | null; costPerTicketReview: number; overReviewLine: boolean }
  }
}

type Seat = { contact_name: string | null; amount: number | null; seats: number; is_upsell: boolean; seat_source: string | null; source_reason: string | null; paid_at: string }

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getProject(id)
  if (!project?.deal) notFound()
  const deal = project.deal

  let snaps: Snapshot[] = []
  let missing = false
  let error: string | null = null
  if (supabaseConfigured) {
    const { data, error: e } = await supabase
      .from('deal_daily')
      .select('date, event_no, event_date, source, inputs, result')
      .eq('project', id)
      .order('date', { ascending: false })
      .limit(120)
    if (e) {
      if (/deal_daily|schema cache|does not exist/i.test(e.message)) missing = true
      else error = e.message
    } else snaps = (data ?? []) as Snapshot[]
  }
  const now = snaps[0] ?? null

  // The buyers behind the current event, with the source each was given.
  let seats: Seat[] = []
  if (now?.inputs.from && now.inputs.to) {
    const { data } = await supabase
      .from('ghl_sales')
      .select('contact_name, amount, seats, is_upsell, seat_source, source_reason, paid_at')
      .eq('project', id)
      .gte('paid_at', new Date(`${now.inputs.from}T00:00:00+08:00`).toISOString())
      .lte('paid_at', new Date(`${now.inputs.to}T23:59:59.999+08:00`).toISOString())
      .order('paid_at', { ascending: false })
    seats = (data ?? []) as Seat[]
  }

  // One line per event: its latest snapshot is the running (or final) estimate.
  const byEvent = new Map<number, Snapshot>()
  for (const s of snaps) if (s.event_no !== null && !byEvent.has(s.event_no)) byEvent.set(s.event_no, s)
  const r = now?.result
  const m = r?.marginals
  const st = r?.standards
  const seatsNow = now?.inputs.seats

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / <Link href={`/projects/${id}`}>{project.name}</Link> / Your share
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">Your share — {project.client ?? project.name}</h1>
          <p className="cap">
            {now
              ? `Event ${now.event_no} · ${dateLong(now.event_date)} · estimate as of ${dateLong(now.date)} · seats from ${now.inputs.sourceNote ?? now.source}`
              : 'Your estimated cut of each event under the Marketing Collaboration Agreement.'}
          </p>
        </div>
      </div>
      <ProjectTabs id={id} current="share" />

      {missing ? (
        <p className="banner warn">
          Not switched on yet — run <code>supabase/deal.sql</code> once in the Supabase SQL editor. The estimate is then
          stored every morning at 8am, with the Telegram message.
        </p>
      ) : null}
      {error ? <p className="banner">Couldn&apos;t load the estimates: {error}</p> : null}
      {!missing && !error && !now ? <p className="empty">No estimate yet — the first one is written at the next 8am run.</p> : null}

      {now && r ? (
        <>
          <div className="grid">
            <Metric label="Your share so far" value={money(r.partner)} sub={`Event ${now.event_no} · estimate`} tone={r.partner > 0 ? 'good' : 'warn'} />
            <Metric label="Ad spend this event" value={money(now.inputs.adSpend)} sub={`${dateLong(now.inputs.from)} → ${dateLong(now.date)}`} />
            <Metric
              label="Seats sold"
              value={num(seatsNow?.total ?? null)}
              sub={seatsNow ? `ads ${seatsNow.ads} · organic ${seatsNow.organic} · unknown ${seatsNow.unknown}` : undefined}
            />
            <Metric
              label="Cost per ads ticket"
              value={st?.costPerTicket === null || st?.costPerTicket === undefined ? DASH : money(st.costPerTicket)}
              sub={st ? `review line ${money(st.costPerTicketReview)} · ads seats ${st.adsSeats}/${st.adsSeatsTarget}` : undefined}
              tone={st?.overReviewLine ? 'bad' : 'good'}
            />
          </div>

          {r.movedToOrganic > 0 ? (
            <p className="banner warn">
              <b>Organic floor (clause 6(f)):</b> the House has {num((seatsNow?.organic ?? 0) + (seatsNow?.unknown ?? 0))} organic
              seats against a floor of {deal.organicFloor}, so {r.movedToOrganic} of your ads seats are paid at the Organic rate (
              {Math.round(deal.rates.organic * 100)}%) — while all ad spend stays in the Ads Pool.
            </p>
          ) : null}

          <section className="band">
            <div className="band-head">
              <h2>The calculation</h2>
              <span>Schedule 2 of the agreement, with this morning&apos;s numbers</span>
            </div>
            <table className="tbl deal-tbl">
              <tbody>
                <tr className="deal-h">
                  <td colSpan={2}>
                    Ads Pool — {r.adsSeatsCounted} seats{r.movedToOrganic ? ` (${r.movedToOrganic} moved to organic)` : ''}
                  </td>
                </tr>
                {r.lines.slice(0, 4).map((l) => (
                  <tr key={l.label}>
                    <td data-label="Line">{l.label}</td>
                    <td data-label="RM" className="num">{money(l.value)}</td>
                  </tr>
                ))}
                <tr className="deal-sum">
                  <td data-label="Line">Ads Pool</td>
                  <td data-label="RM" className="num">{money(r.adsPool)}</td>
                </tr>
                <tr className="deal-you">
                  <td data-label="Line">You: {Math.round(deal.rates.ads * 100)}% of the Ads Pool{r.adsPool < 0 ? ' (a negative pool pays RM0)' : ''}</td>
                  <td data-label="RM" className="num">{money(r.partnerFromAds)}</td>
                </tr>
                <tr className="deal-h">
                  <td colSpan={2}>Organic Pool — {r.organicSeatsCounted} seats</td>
                </tr>
                {r.lines.slice(4).map((l) => (
                  <tr key={l.label}>
                    <td data-label="Line">{l.label}</td>
                    <td data-label="RM" className="num">{money(l.value)}</td>
                  </tr>
                ))}
                <tr className="deal-sum">
                  <td data-label="Line">Organic Pool</td>
                  <td data-label="RM" className="num">{money(r.organicPool)}</td>
                </tr>
                <tr className="deal-you">
                  <td data-label="Line">You: {Math.round(deal.rates.organic * 100)}% of the Organic Pool</td>
                  <td data-label="RM" className="num">{money(r.partnerFromOrganic)}</td>
                </tr>
                <tr className="deal-total">
                  <td data-label="Line">Your share so far</td>
                  <td data-label="RM" className="num">{money(r.partner)}</td>
                </tr>
              </tbody>
            </table>
            <p className="set-note">
              Shared Costs ({money(r.sharedCosts)}) use the agreement&apos;s worked example — venue, camera, GHL/WhatsApp and
              RM{deal.sharedCostDefaults.mealPerSeat} meals per seat — until the House&apos;s statement gives the invoices. Class
              and DFY commissions are not included yet.
            </p>
          </section>

          {m ? (
            <section className="band">
              <div className="band-head">
                <h2>What moves it</h2>
              </div>
              <ul className="deal-moves">
                <li>
                  Next ads-sourced ticket: <b>+{money(m.nextAdsSeat)}</b> to you
                  {r.adsPool < 0 && m.breakEven !== null
                    ? ` now — the Ads Pool is below zero; ${m.breakEven} more ads seats clear it, then each adds +${money(m.perSeatAfterBreakEven)}`
                    : ''}
                  .
                </li>
                <li>
                  RM100 more ad spend with no sale:{' '}
                  <b>{m.extra100Spend < 0 ? money(m.extra100Spend) : 'RM0 to you'}</b>
                  {m.extra100Spend >= 0 && r.adsPool < 0 ? ' while the Ads Pool is below zero (the House carries it)' : ''}.
                </li>
                <li>
                  Every organic seat the House adds up to {deal.organicFloor} releases one of your ads seats back to the{' '}
                  {Math.round(deal.rates.ads * 100)}% rate.
                </li>
              </ul>
            </section>
          ) : null}

          <section className="band">
            <div className="band-head">
              <h2>By event</h2>
              <span>latest estimate per event</span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>As of</th>
                  <th>Seats (ads / organic / unknown)</th>
                  <th>Ad spend</th>
                  <th>Ads Pool</th>
                  <th>Your share</th>
                </tr>
              </thead>
              <tbody>
                {[...byEvent.values()].map((s) => (
                  <tr key={s.event_no}>
                    <td data-label="Event">
                      Event {s.event_no} · {dateLong(s.event_date)}
                    </td>
                    <td data-label="As of">{dateLong(s.date)}</td>
                    <td data-label="Seats">
                      {s.inputs.adsSeats} / {s.inputs.organicSeats} / {s.inputs.unknownSeats}
                    </td>
                    <td data-label="Ad spend">{money(s.inputs.adSpend)}</td>
                    <td data-label="Ads Pool">{money(s.result.adsPool)}</td>
                    <td data-label="Your share">
                      <b>{money(s.result.partner)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {seats.length ? (
            <section className="band">
              <div className="band-head">
                <h2>Buyers this event</h2>
                <span>
                  {now.source === 'eventops'
                    ? 'seat split above comes from EventOps; this is our own GHL reading, for comparison'
                    : 'how our GHL reading classified each seat'}
                </span>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Buyer</th>
                    <th>Paid</th>
                    <th>Source</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {seats.map((s, i) => (
                    <tr key={i}>
                      <td data-label="Buyer">
                        {s.contact_name ?? DASH}
                        {s.is_upsell ? <span className="tag soon"> upgrade</span> : s.seats > 1 ? <span className="tag soon"> ×{s.seats}</span> : null}
                      </td>
                      <td data-label="Paid">{money(Number(s.amount))}</td>
                      <td data-label="Source">
                        <span className={`tag ${s.seat_source === 'ads' ? 'live' : s.seat_source === 'organic' ? 'proactive' : 'soon'}`}>
                          {s.seat_source ?? 'not classified'}
                        </span>
                      </td>
                      <td data-label="Why">{s.source_reason ?? DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  )
}
