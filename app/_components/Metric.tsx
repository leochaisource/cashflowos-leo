// One number on a project scorecard.
//
// The whole reason this exists instead of reusing <Stat> is the blank state. A
// metric with no source yet must LOOK unmeasured — a dash, greyed, with the
// source named underneath ("GHL — not connected"). Printing 0 there would read
// as "we ran ads and got nothing", which is a lie about a spreadsheet cell
// nobody has filled in.

export default function Metric({
  label,
  value,
  sub,
  source,
  tone,
  big,
}: {
  label: string
  /** Already formatted. Pass the DASH from lib/format for "no data". */
  value: string
  /** The one-line explanation under the number (basis, comparison, target). */
  sub?: string
  /** Where the number comes from, when it isn't Meta. Shown when value is blank. */
  source?: string
  tone?: 'good' | 'warn' | 'bad'
  big?: boolean
}) {
  const blank = value === '—'
  return (
    <div className={`metric${blank ? ' blank' : ''}${tone && !blank ? ' t-' + tone : ''}${big ? ' big' : ''}`}>
      <p className="l">{label}</p>
      <p className="v">{value}</p>
      {sub && !blank ? <p className="s">{sub}</p> : null}
      {blank ? <p className="src">{source ? source : 'no source connected yet'}</p> : null}
    </div>
  )
}
