import type { AdPerf } from '@/lib/metrics'
import { money, num, pct, DASH } from '@/lib/format'

// The winners / losers tables. Same shape either way — what changes is the
// column you're being asked to look at, so `highlight` decides which cell is
// emphasised and the empty state explains WHY a list is empty (usually "not
// enough volume yet", which is a fine answer and not an error).

export default function AdTable({
  rows,
  currency = 'RM',
  highlight,
  empty,
}: {
  rows: AdPerf[]
  currency?: string
  highlight: 'cpl' | 'ctr'
  empty: string
}) {
  if (!rows.length) return <div className="empty">{empty}</div>

  return (
    <table className="tbl adtbl">
      <thead>
        <tr>
          <th>Ad</th>
          <th>Spend</th>
          <th>Leads</th>
          <th className={highlight === 'cpl' ? 'hl' : undefined}>CPL</th>
          <th className={highlight === 'ctr' ? 'hl' : undefined}>Link CTR</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.ad_id}>
            <td data-label="Ad">
              <span className="adname">{a.ad_name}</span>
              {a.campaign_name ? <span className="adcamp">{a.campaign_name}</span> : null}
            </td>
            <td data-label="Spend">{money(a.spend, currency)}</td>
            <td data-label="Leads">{num(a.leads)}</td>
            <td data-label="CPL" className={highlight === 'cpl' ? 'hl' : undefined}>
              {/* An ad that spent and produced nothing has no CPL — saying so is
                  more useful than an ∞ or a 0 that sorts to the top. */}
              {a.cpl === null ? <span className="noleads">no leads</span> : money(a.cpl, currency)}
            </td>
            <td data-label="Link CTR" className={highlight === 'ctr' ? 'hl' : undefined}>
              {a.ctr === null ? DASH : pct(a.ctr, 2)}
            </td>
            <td data-label="Status">
              <span className={`pill ${(a.status ?? '').toLowerCase() === 'active' ? 'active' : 'paused'}`}>
                {a.status ? a.status.toLowerCase().replace(/_/g, ' ') : 'unknown'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
