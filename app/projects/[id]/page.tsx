import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/lib/ad-clients'
import { projectScorecard, ratio as ratioSafe, WINNER_MIN_LEADS, LOSER_MIN_IMPRESSIONS, LOSER_MIN_SPEND } from '@/lib/metrics'
import { todayISO } from '@/lib/records'
import Metric from '@/app/_components/Metric'
import Spark from '@/app/_components/Spark'
import AdTable from '@/app/_components/AdTable'
import RefreshButton from '@/app/_components/RefreshButton'
import FunnelEntryForm from '@/app/_components/FunnelEntryForm'
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
  if (!project) notFound()

  const s = await projectScorecard(project, WINDOW_DAYS)
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
            empty={`No ad has spent ${money(LOSER_MIN_SPEND, cur)} yet — too early to call anything a loser.`}
          />
        </div>
        <div className="col">
          <h3>👀 Losing ads — lowest link CTR</h3>
          <AdTable
            rows={s.losersByCTR}
            currency={cur}
            highlight="ctr"
            empty={`No ad has ${num(LOSER_MIN_IMPRESSIONS)} impressions yet — CTR below that is noise.`}
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
          sub="GHL landing page"
          source={src.leads ?? 'GHL — not connected yet'}
        />
        <Metric
          label="Show-up rate"
          value={pct(s.showUpRate)}
          sub={s.attended !== null ? `${num(s.attended)} attended of ${num(s.optIns ?? s.leads)}` : undefined}
          source={src.attended ?? 'Master leads sheet · Attended — not connected yet'}
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
      </div>

      {/* ─────────────────────────────── ENTRY */}
      <div className="band">
        <div className="band-head">
          <h2>Record today’s numbers</h2>
          <span>until GHL and the master sheet are wired in</span>
        </div>
        <FunnelEntryForm project={project.id} today={todayISO()} />
      </div>

      <p className="cap" style={{ marginTop: 20 }}>
        Ad numbers come from the Meta account in <code>{project.adAccountEnv}</code> (
        {process.env[project.adAccountEnv]?.trim() ? 'configured' : 'not configured'}). Anything
        showing {DASH} is waiting on a source, not on a result.
      </p>
    </>
  )
}
