import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { demoEnabled } from '@/lib/settings'
import { projectScorecard, ratio as ratioSafe, WINNER_MIN_LEADS, LOSER_MIN_IMPRESSIONS, LOSER_MIN_SPEND } from '@/lib/metrics'
import { todayISO, getRecords, m } from '@/lib/records'
import Metric from '@/app/_components/Metric'
import Spark from '@/app/_components/Spark'
import AdTable from '@/app/_components/AdTable'
import RefreshButton from '@/app/_components/RefreshButton'
import FunnelEntryForm from '@/app/_components/FunnelEntryForm'
import NextSteps from '@/app/_components/NextSteps'
import { findWorkProject, stepsFor, type WorkProject } from '@/lib/work-projects'
import type { Rec } from '@/lib/records'
import { money, num, pct, times, whenShort, dateLong, daysUntil, DASH } from '@/lib/format'

export const dynamic = 'force-dynamic'

// ONE PROJECT, top to bottom, in the order the money actually moves:
//   ADS (what you spent and what it bought) →
//   FUNNEL (what happened to those people) →
//   MONEY (what came back).
//
// Tiles in the first band come from Meta. Tiles in the second come from you (or,
// once connected, from GHL and the master leads sheet). Tiles in the third are
// derived, and go blank the moment an input they depend on is missing — better a
// blank than a confident wrong number.

// Matches the home grid — see the note there on why 30 and not 14.
const WINDOW_DAYS = 30

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getProject(id)
  // Not an ad client? It may be a WORK project — Dr Tariq's malware fix has a
  // deadline and next steps but no ad account, and it deserves a page too.
  if (!project) {
    const rows = await getRecords()
    const work = findWorkProject(rows, id)
    if (!work) notFound()
    return <WorkProjectPage work={work} rows={rows} />
  }
  // A demo project doesn't exist while the demo switch is off — 404, rather than
  // a live-looking page for a client that isn't yours reachable by URL.
  if (project.demo && !(await demoEnabled())) notFound()

  const [s, allRecords] = await Promise.all([projectScorecard(project, WINDOW_DAYS), getRecords()])
  const steps = stepsFor(allRecords, project.id)

  // Receipts filed against THIS client — by photo caption, by a typed expense,
  // or by hand. Without this the tagging has no payoff: you'd send a receipt to
  // a project and watch nothing happen.
  const costs = allRecords
    .filter((r) => r.category === 'cash_out' && r.meta?.project === project.id)
    .sort((a, b) => (b.due_date ?? b.created_at).localeCompare(a.due_date ?? a.created_at))
  const costsTotal = costs.reduce((sum, r) => sum + Number(r.amount || 0), 0)
  // The real cost of running this client: media + everything else.
  const totalCost = s.spend + costsTotal
  const net = s.cashCollected === null ? null : s.cashCollected - totalCost
  const cur = project.currency || 'RM'
  const src = project.sources ?? {}
  const until = daysUntil(project.launchDate)

  const cplTone =
    s.avgCPL !== null && project.targetCPL
      ? s.avgCPL <= project.targetCPL
        ? 'good'
        : s.avgCPL <= project.targetCPL * 1.25
          ? 'warn'
          : 'bad'
      : undefined

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / {project.name}
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">{project.name}</h1>
          <p className="cap">
            {project.client ? `${project.client} · ` : ''}
            last {WINDOW_DAYS} days · synced {whenShort(s.syncedAt)}
          </p>
        </div>
        <RefreshButton project={project.id} days={WINDOW_DAYS} />
      </div>

      {!s.hasDelivery && (
        <div className="banner info">
          {s.lastSpendDate ? (
            <>
              <b>Paused — nothing has spent in the last {WINDOW_DAYS} days.</b> Last delivery{' '}
              {dateLong(s.lastSpendDate)}. Over the last {s.lookbackDays} days this account spent{' '}
              {money(s.spendLookback, cur)} for {num(s.leadsLookback)} leads. The ad numbers below
              cover the {WINDOW_DAYS}-day window only, so they are blank rather than zero.
            </>
          ) : (
            <>
              <b>No ad delivery recorded.</b>{' '}
              {project.launchDate && until !== null && until > 0
                ? `Ads go live ${dateLong(project.launchDate)} — ${until} day${until === 1 ? '' : 's'} away. `
                : ''}
              Nothing has ever spent, so every ad number below is blank rather than zero. The 8am
              brief is running competitor intelligence for this project in the meantime.
            </>
          )}
        </div>
      )}

      {/* ─────────────────────────────── NEXT STEPS (the mini PM) */}
      <NextSteps projectId={project.id} open={steps.open} done={steps.done} today={todayISO()} />

      {/* ─────────────────────────────── ADS */}
      <p className="rowlabel">Ads — from Meta</p>
      <div className="grid">
        <Metric label="Active ads" value={num(s.activeAds)} sub={`${s.adsWithSpend} spent in window`} source="Meta ad account" />
        <Metric
          label="Average CPL"
          value={money(s.avgCPL, cur)}
          tone={cplTone}
          sub={project.targetCPL ? `target ${money(project.targetCPL, cur)}` : `${num(s.leads)} leads`}
          source="Meta — no leads attributed yet"
        />
        <Metric label={`Spend · ${WINDOW_DAYS}d`} value={money(s.spend, cur)} sub={`yesterday ${money(s.spendYesterday, cur)}`} source="Meta ad account" />
        <Metric label="Leads (Meta)" value={num(s.leads)} sub={project.leadActionTypes[0]} source="Meta ad account" />
      </div>

      {/* Delivery — the metrics that explain WHY the CPL is what it is. */}
      <div className="grid">
        <Metric
          label="CPM"
          value={money(s.delivery.cpm, cur)}
          sub={`${num(s.delivery.impressions)} impressions`}
          source="Meta ad account"
        />
        <Metric
          label="Link CTR"
          value={pct(s.delivery.linkCtr, 2)}
          sub={`${num(s.delivery.linkClicks)} link clicks`}
          source="Meta ad account"
        />
        <Metric label="CTR (all)" value={pct(s.delivery.ctr, 2)} sub={`${num(s.delivery.clicks)} clicks`} source="Meta ad account" />
        <Metric label="CPC" value={money(s.delivery.cpc, cur)} sub={`per link click ${money(s.delivery.costPerLinkClick, cur)}`} source="Meta ad account" />
        <Metric
          label="Click → lead"
          value={pct(s.delivery.leadRate)}
          sub="of link clicks that opted in"
          source="needs clicks and leads"
        />
      </div>

      {/* Yesterday against the trailing three days — the same comparison the
          morning brief makes, so the screen and the message never disagree. */}
      {(s.today.spend > 0 || s.yesterday.spend > 0 || s.last3.spend > 0) && (
        <div className="band">
          <div className="band-head">
            <h2>Today vs yesterday vs the last 3 days</h2>
            <span>lower CPM, CPC and CPL are better · higher CTR is better</span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Today so far</th>
                <th>Yesterday</th>
                <th>3-day avg, per day</th>
                <th>Yesterday vs 3-day</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  // label, today, yesterday, 3-day avg, raw yest, raw avg, which
                  // direction is good, and whether TODAY's figure is comparable
                  // mid-day (rates yes, running totals no).
                  ['Spend', money(s.today.spend, cur), money(s.yesterday.spend, cur), money(s.last3PerDay.spend, cur), s.yesterday.spend, s.last3PerDay.spend, 'up', false],
                  ['CPM', money(s.today.cpm, cur), money(s.yesterday.cpm, cur), money(s.last3PerDay.cpm, cur), s.yesterday.cpm, s.last3PerDay.cpm, 'down', true],
                  ['Link CTR', pct(s.today.linkCtr, 2), pct(s.yesterday.linkCtr, 2), pct(s.last3PerDay.linkCtr, 2), s.yesterday.linkCtr, s.last3PerDay.linkCtr, 'up', true],
                  ['CPC', money(s.today.cpc, cur), money(s.yesterday.cpc, cur), money(s.last3PerDay.cpc, cur), s.yesterday.cpc, s.last3PerDay.cpc, 'down', true],
                  ['Leads', num(s.today.leads), num(s.yesterday.leads), num(Math.round(s.last3PerDay.leads * 10) / 10), s.yesterday.leads, s.last3PerDay.leads, 'up', false],
                  ['CPL', money(s.today.cpl, cur), money(s.yesterday.cpl, cur), money(s.last3PerDay.cpl, cur), s.yesterday.cpl, s.last3PerDay.cpl, 'down', true],
                ] as const
              ).map(([label, todayV, yestV, baseV, yestRaw, baseRaw, better, comparable]) => {
                const change = ratioSafe((yestRaw ?? 0) - (baseRaw ?? 0), baseRaw)
                const good = change === null ? undefined : better === 'up' ? change > 0 : change < 0
                return (
                  <tr key={label}>
                    <td data-label="Metric">{label}</td>
                    {/* A running total mid-morning is not a low number, it's an
                        unfinished one — greyed so it never reads as a crash. */}
                    <td data-label="Today so far" style={comparable ? undefined : { color: 'var(--ink-faint)' }}>
                      {todayV}
                      {comparable ? '' : ' ⏳'}
                    </td>
                    <td data-label="Yesterday">{yestV}</td>
                    <td data-label="3-day avg">{baseV}</td>
                    <td
                      data-label="Yesterday vs 3-day"
                      style={change === null ? undefined : { color: good ? '#2E5A40' : '#8A3E2D', fontWeight: 600 }}
                    >
                      {change === null ? DASH : `${change > 0 ? '+' : ''}${(change * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="set-note">
            ⏳ marks a running total — today isn&apos;t over, so spend and leads will keep climbing and
            can&apos;t be compared with a full day. The rates (CPM, CTR, CPC, CPL) are comparable right
            now. Today covers everything up to the last sync, {whenShort(s.syncedAt)} — press Refresh
            for the last few hours.
          </p>
        </div>
      )}

      <div className="band">
        <div className="band-head">
          <h2>Daily ad spend</h2>
          <span>
            {money(s.spend, cur)} over {WINDOW_DAYS} days
          </span>
        </div>
        {s.hasDelivery ? (
          <>
            <Spark data={s.dailySpend} currency={cur} height={72} />
            <div className="spark-axis">
              <span>{s.dailySpend[0]?.date}</span>
              <span>{s.dailySpend[s.dailySpend.length - 1]?.date}</span>
            </div>
          </>
        ) : (
          <div className="empty">Nothing has spent yet — the chart starts on your first delivery day.</div>
        )}
      </div>

      <div className="cols">
        <div className="col">
          <h3>🏆 Winning ads — cheapest CPL</h3>
          <AdTable
            rows={s.winners}
            currency={cur}
            highlight="cpl"
            empty={`No ad has reached ${WINNER_MIN_LEADS} leads yet. Below that, a cheap CPL is luck, not a winner.`}
          />
        </div>
      </div>

      <div className="cols">
        <div className="col">
          <h3>💸 Losing ads — worst CPL</h3>
          <AdTable
            rows={s.losersByCPL}
            currency={cur}
            highlight="cpl"
            empty={`Nothing is losing: no ad has spent ${money(LOSER_MIN_SPEND, cur)}+ while running 25% worse than your blended CPL.`}
          />
        </div>
        <div className="col">
          <h3>👀 Losing ads — lowest link CTR</h3>
          <AdTable
            rows={s.losersByCTR}
            currency={cur}
            highlight="ctr"
            empty={`No ad with ${num(LOSER_MIN_IMPRESSIONS)}+ impressions is clicking through meaningfully below your account average.`}
          />
        </div>
      </div>

      {/* ─────────────────────────────── LEADS (live from the master sheet) */}
      {s.sheet && (
        <div className="band">
          <div className="band-head">
            <h2>Leads — live from the master sheet</h2>
            <span>
              {s.sheet.ok
                ? `${s.sheet.total} opt-ins · ${s.sheet.yesterday} yesterday · ${s.sheet.today} today`
                : 'sheet unreachable'}
            </span>
          </div>
          {s.sheet.ok ? (
            <>
              <div className="grid" style={{ marginBottom: 18 }}>
                <Metric label="Opt-ins yesterday" value={num(s.sheet.yesterday)} sub={`${num(s.sheet.last7)} in the last 7 days`} />
                <Metric label="Paid" value={num(s.sheet.signups)} sub={money(s.sheet.revenue, cur)} />
                <Metric
                  label="To follow up"
                  value={num(s.sheet.followUps.length)}
                  sub="opted in, no payment, no next action"
                  tone={s.sheet.followUps.length > 20 ? 'warn' : undefined}
                />
              </div>
              {s.sheet.byAd.length > 0 && (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Ad (UTM content)</th>
                      <th>Leads</th>
                      <th>Paid</th>
                      <th>Cost per lead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.sheet.byAd.slice(0, 8).map((a) => {
                      // Match the sheet's ad tag to Meta spend on the same-named ad.
                      // Names are typed by hand into UTMs, so a miss is normal and
                      // shows as a dash rather than a wrong number.
                      const meta = s.winners
                        .concat(s.losersByCPL, s.losersByCTR)
                        .find((x) => x.ad_name.toLowerCase().includes(a.ad.toLowerCase()))
                      return (
                        <tr key={a.ad}>
                          <td data-label="Ad">{a.ad}</td>
                          <td data-label="Leads">{num(a.leads)}</td>
                          <td data-label="Paid">{num(a.paid)}</td>
                          <td data-label="Cost per lead">
                            {meta ? money(ratioSafe(meta.spend, a.leads), cur) : DASH}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <div className="empty">
              Couldn&apos;t read the sheet: {s.sheet.error}. The numbers below fall back to what&apos;s
              stored.
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────── FUNNEL */}
      <p className="rowlabel">Funnel — what happened to those people</p>
      <div className="grid">
        <Metric
          label="Leads (opted in)"
          value={num(s.optIns)}
          sub={src.leads}
          source={src.leads ?? 'no source connected yet'}
        />
        <Metric
          label="Show-up rate"
          value={pct(s.showUpRate)}
          sub={s.attended !== null ? `${num(s.attended)} attended of ${num(s.optIns ?? s.leads)}` : undefined}
          source={src.attended ?? 'attendance is not being recorded yet'}
        />
        <Metric
          label="Appointments"
          value={num(s.appointments)}
          source={src.appointments ?? 'no source connected yet'}
        />
        <Metric label="Sign-ups" value={num(s.signups)} source={src.signups ?? 'no source connected yet'} />
        <Metric
          label="Attendee → sign-up"
          value={pct(s.convRate)}
          sub={s.signups !== null && s.attended !== null ? `${num(s.signups)} of ${num(s.attended)}` : undefined}
          source="needs attended + sign-ups"
        />
      </div>

      {/* ─────────────────────────────── MONEY */}
      <p className="rowlabel">Money</p>
      <div className="grid">
        <Metric
          label="Course price"
          value={money(s.coursePrice, cur)}
          source={`set coursePrice for "${project.id}" in lib/ad-clients.ts`}
        />
        <Metric
          label="Cost per acquisition"
          value={money(s.cpa, cur)}
          sub={s.signups !== null ? `${money(s.spend, cur)} ÷ ${num(s.signups)} sign-ups` : undefined}
          source="needs sign-ups"
        />
        <Metric
          label="ROAS"
          value={times(s.roas)}
          sub={s.revenueBasis ? `${money(s.revenue, cur)} from ${s.revenueBasis}` : undefined}
          source="needs cash collected, or sign-ups + course price"
        />
        <Metric
          label="Cash collected"
          value={money(s.cashCollected, cur)}
          source={src.cash ?? 'no source connected yet'}
        />
        <Metric
          label="Total cost"
          value={money(totalCost, cur)}
          sub={`${money(s.spend, cur)} ads + ${money(costsTotal, cur)} expenses`}
        />
        <Metric
          label="Net"
          value={money(net, cur)}
          sub={net !== null ? (net >= 0 ? 'in profit' : 'in the red') : undefined}
          tone={net === null ? undefined : net >= 0 ? 'good' : 'bad'}
          source="needs cash collected"
        />
      </div>

      {/* Receipts filed against this client — the other half of "what it costs". */}
      <div className="band">
        <div className="band-head">
          <h2>Project expenses</h2>
          <span>{costs.length ? `${costs.length} receipt(s) · ${money(costsTotal, cur)}` : 'nothing filed yet'}</span>
        </div>
        {costs.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>What</th>
                <th>Merchant</th>
                <th>Category</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((r) => (
                <tr key={r.id}>
                  <td data-label="What">{r.title}</td>
                  <td data-label="Merchant">{m(r, 'merchant')}</td>
                  <td data-label="Category">{m(r, 'category')}</td>
                  <td data-label="Date">{r.due_date ?? r.created_at.slice(0, 10)}</td>
                  <td data-label="Amount">{money(Number(r.amount), cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            Send a receipt photo to the bot with this client in the caption — e.g. “{project.client ?? project.name} —
            venue deposit” — and it files here automatically.
          </div>
        )}
      </div>

      {/* ─────────────────────────────── ENTRY */}
      <div className="band">
        <div className="band-head">
          <h2>Record today’s numbers</h2>
          <span>
            {s.sheet?.ok
              ? 'for anything the sheet does not track yet — attendance, appointments'
              : 'until the lead source is connected'}
          </span>
        </div>
        <FunnelEntryForm project={project.id} today={todayISO()} />
      </div>

      <p className="cap" style={{ marginTop: 20 }}>
        {/* Demo projects say nothing about where their numbers come from — the
            marker lives in the config and the database, never on the screen. */}
        {project.demo ? '' : `Ad numbers sync from this client's Meta ad account every morning at 8am. `}
        Anything showing {DASH} is waiting on a source, not on a result.
      </p>
    </>
  )
}

// ============================================================
// A WORK PROJECT — no ad account, no funnel; a deadline, a phase, next steps,
// and whatever receipts have been filed against it. Dr Tariq's malware fix and
// the Firstin5 build live here; the ads scorecard above is for ad clients.
// ============================================================
function WorkProjectPage({ work, rows }: { work: WorkProject; rows: Rec[] }) {
  const today = todayISO()
  const steps = stepsFor(rows, work.slug, today)
  const overdueProject = !!work.due && work.due < today && !['done', 'completed', 'closed'].includes(work.status.toLowerCase())
  const dueDays = daysUntil(work.due)

  const costs = rows
    .filter((r) => r.category === 'cash_out' && r.meta?.project === work.slug)
    .sort((a, b) => (b.due_date ?? b.created_at).localeCompare(a.due_date ?? a.created_at))
  const costsTotal = costs.reduce((sum, r) => sum + Number(r.amount || 0), 0)

  return (
    <>
      <p className="crumb">
        <Link href="/">Projects</Link> / {work.name}
      </p>
      <div className="phead">
        <div>
          <h1 className="ph">{work.name}</h1>
          <p className="cap">
            {work.client ? `${work.client} · ` : ''}
            {work.phase ?? 'work project'}
            {work.due ? ` · target ${dateLong(work.due)}` : ''}
          </p>
        </div>
        <span className={`pill ${overdueProject ? 'overdue' : work.status.toLowerCase()}`}>
          {overdueProject ? 'overdue' : work.status}
        </span>
      </div>

      {work.due && (
        <div className="grid">
          <Metric
            label="Target date"
            value={dateLong(work.due)}
            sub={
              dueDays === null
                ? undefined
                : dueDays < 0
                  ? `${-dueDays} day${dueDays === -1 ? '' : 's'} past target`
                  : dueDays === 0
                    ? 'due today'
                    : `${dueDays} day${dueDays === 1 ? '' : 's'} left`
            }
            tone={overdueProject ? 'bad' : dueDays !== null && dueDays <= 2 ? 'warn' : undefined}
          />
          <Metric label="Open steps" value={num(steps.open.length)} sub={steps.open[0] ? `next: ${steps.open[0].title.slice(0, 40)}` : undefined} />
          <Metric label="Done" value={num(steps.done.length)} />
          <Metric label="Expenses filed" value={money(costsTotal)} sub={costs.length ? `${costs.length} receipt(s)` : undefined} source="tag receipts with this project's name" />
        </div>
      )}

      {work.notes ? <div className="banner info">{work.notes}</div> : null}

      <NextSteps projectId={work.slug} open={steps.open} done={steps.done} today={today} />

      {costs.length > 0 && (
        <div className="band">
          <div className="band-head">
            <h2>Project expenses</h2>
            <span>
              {costs.length} receipt(s) · {money(costsTotal)}
            </span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>What</th>
                <th>Merchant</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((r) => (
                <tr key={r.id}>
                  <td data-label="What">{r.title}</td>
                  <td data-label="Merchant">{m(r, 'merchant')}</td>
                  <td data-label="Date">{r.due_date ?? r.created_at.slice(0, 10)}</td>
                  <td data-label="Amount">{money(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
