import Link from 'next/link'
import type { Project } from '@/lib/ad-clients'
import type { Scorecard } from '@/lib/metrics'
import Spark from './Spark'
import { money, num, times, whenShort, dateLong, daysUntil, DASH } from '@/lib/format'

// One project, as a card on the home grid. The four numbers are the ones you'd
// want if you could only have four: what it cost, what it produced, what each
// one cost, and whether the money came back.
//
// A project that has never delivered gets a DIFFERENT card, not a card full of
// zeros — "ads go live in 4 days" is the true status of Kingsley's account, and
// "RM 0 · 0 leads · CPL RM 0" is not.

export type CardSteps = {
  open: number
  overdue: number
  next: { title: string; due: string | null; overdue: boolean } | null
}

export default function ProjectCard({
  project,
  card,
  steps,
}: {
  project: Project
  card: Scorecard
  steps?: CardSteps
}) {
  const cur = project.currency || 'RM'
  const stage = project.stage ?? (card.hasDelivery ? 'active' : 'pre-launch')
  const until = daysUntil(project.launchDate)

  // CPL against the target you set. No target = no judgement, just the number.
  const tone =
    card.avgCPL !== null && project.targetCPL
      ? card.avgCPL <= project.targetCPL
        ? 'good'
        : card.avgCPL <= project.targetCPL * 1.25
          ? 'warn'
          : 'bad'
      : undefined

  return (
    <Link href={`/projects/${project.id}`} className="pcard">
      <div className="pc-head">
        <div>
          <p className="pc-name">{project.name}</p>
          <p className="pc-client">{project.client ?? 'Client not set'}</p>
        </div>
        <span className={`pill ${stage === 'active' ? 'active' : stage === 'done' ? 'done' : 'paused'}`}>
          {stage.replace('-', ' ')}
        </span>
      </div>

      {card.hasDelivery ? (
        <>
          <div className="pc-nums">
            <div>
              <p className="l">Spend · {card.days}d</p>
              <p className="v">{money(card.spend, cur)}</p>
            </div>
            <div>
              <p className="l">Leads</p>
              <p className="v">{num(card.leads)}</p>
            </div>
            <div className={tone ? `t-${tone}` : undefined}>
              <p className="l">Avg CPL</p>
              <p className="v">{money(card.avgCPL, cur)}</p>
            </div>
            <div>
              <p className="l">ROAS</p>
              <p className="v">{times(card.roas)}</p>
            </div>
          </div>
          <Spark data={card.dailySpend} currency={cur} />
          <p className="pc-foot">
            {card.activeAds !== null ? `${card.activeAds} active ads` : 'ad status unknown'}
            {' · synced '}
            {whenShort(card.syncedAt)}
          </p>
        </>
      ) : (
        <div className="pc-prelaunch">
          {card.lastSpendDate ? (
            // Ran before, stopped. Completely different from never having run —
            // and with only the window to look at, the two look identical.
            <>
              <p className="pl-line">Paused — last spent {dateLong(card.lastSpendDate)}</p>
              <p className="pl-sub">
                Nothing in the last {card.days} days. Over the last {card.lookbackDays}:{' '}
                {money(card.spendLookback, cur)} and {num(card.leadsLookback)} leads.
              </p>
            </>
          ) : (
            <>
              <p className="pl-line">
                {project.launchDate
                  ? until !== null && until > 0
                    ? `Ads go live ${dateLong(project.launchDate)} — in ${until} day${until === 1 ? '' : 's'}`
                    : `Launch date ${dateLong(project.launchDate)} — no delivery recorded yet`
                  : 'No ad delivery recorded'}
              </p>
              <p className="pl-sub">
                Nothing has ever spent on this account, so there is nothing to average. The morning
                brief is running competitor intel for this one.
              </p>
            </>
          )}
        </div>
      )}

      {/* What's on the plate for this client — the PM layer's one-liner. */}
      {steps && steps.open > 0 && (
        <p className="pc-steps">
          📌 {steps.open} next step{steps.open === 1 ? '' : 's'}
          {steps.overdue > 0 ? <span className="late"> · {steps.overdue} overdue</span> : null}
          {steps.next ? (
            <>
              {' · next: '}
              {steps.next.title.length > 44 ? steps.next.title.slice(0, 44) + '…' : steps.next.title}
              {steps.next.due ? (
                <span className={steps.next.overdue ? 'late' : undefined}> ({steps.next.due})</span>
              ) : null}
            </>
          ) : null}
        </p>
      )}

      {/* The funnel half, shown compactly — blanks stay blank. */}
      <div className="pc-funnel">
        <span>
          Opt-ins <b>{num(card.optIns)}</b>
        </span>
        <span>
          Show-up <b>{card.showUpRate === null ? DASH : `${Math.round(card.showUpRate * 100)}%`}</b>
        </span>
        <span>
          Sign-ups <b>{num(card.signups)}</b>
        </span>
      </div>
    </Link>
  )
}
