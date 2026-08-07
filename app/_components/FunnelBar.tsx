import { Fragment } from 'react'
import type { Funnel } from '@/lib/records'

// The whole-business river on the Dashboard: Views → Leads → Appointments →
// Closed → Nurture, each with its count, and the stage-to-stage conversion %
// shown BETWEEN each pair. Pure presentation — the numbers come from
// getFunnel() (lib/records.ts). Styles: .funnel / .fseg / .fconv in globals.css.
const STAGES = [
  { label: 'Views', cls: 'views' },
  { label: 'Leads', cls: 'leads' },
  { label: 'Appointments', cls: 'appts' },
  { label: 'Closed', cls: 'closed' },
  { label: 'Nurture', cls: 'nurture' },
] as const

export default function FunnelBar({ funnel }: { funnel: Funnel }) {
  const values = [funnel.views, funnel.leads, funnel.appointments, funnel.closed, funnel.nurture]
  return (
    <div className="funnel">
      <h2>The Funnel — your whole business as one river</h2>
      <div className="funnel-bar">
        {STAGES.map((s, i) => (
          <Fragment key={s.cls}>
            <div className={`fseg ${s.cls}`}>
              <div className="fbar" />
              <div className="fnum">{values[i]}</div>
              <div className="flabel">{s.label}</div>
            </div>
            {i < STAGES.length - 1 && (
              // Nurture is not downstream of Closed — it's where leads go when
              // they DON'T close. Printing a conversion into it produced "150%",
              // which reads as a broken dashboard rather than as the parallel
              // branch it is. Show the arrow, drop the percentage.
              STAGES[i + 1].cls === 'nurture' ? (
                <div className="fconv" aria-label="Leads that did not close move to Nurture">
                  <span className="p" title="Leads that did not close">
                    parked
                  </span>
                  <span className="arw" aria-hidden="true">▶</span>
                </div>
              ) : (
                <div className="fconv" aria-label={`${funnel.pct[i]}% convert to ${STAGES[i + 1].label}`}>
                  {/* 143 leads off 317,440 views rounds to "0%", which reads as
                      "nothing converts" instead of "a small fraction does". */}
                  <span className="p">
                    {funnel.pct[i] === 0 && values[i] > 0 && values[i + 1] > 0 ? '<1%' : `${funnel.pct[i]}%`}
                  </span>
                  <span className="arw" aria-hidden="true">▶</span>
                </div>
              )
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
