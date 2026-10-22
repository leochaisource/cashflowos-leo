import type { CreativeRow } from '@/lib/funnel-report'
import { money, num, pct } from '@/lib/format'

// Ads by what their leads became (owner, 2026-10-22): customers and the cost
// of each one, beside the cost per lead it used to be judged on. A cheap lead
// that never buys is the most expensive kind.

export default function CustomerAdTable({ rows, currency = 'RM', empty }: { rows: CreativeRow[]; currency?: string; empty: string }) {
  if (!rows.length) return <div className="empty">{empty}</div>
  return (
    <table className="tbl adtbl">
      <thead>
        <tr>
          <th>Ad</th>
          <th>Spend</th>
          <th>Leads</th>
          <th>Customers</th>
          <th className="hl">Per customer</th>
          <th>Per lead</th>
          <th>Lead → customer</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={`${a.funnel}::${a.ad}`}>
            <td data-label="Ad">
              <span className="adname">{a.ad}</span>
              <span className="adcamp">{a.funnel}</span>
            </td>
            <td data-label="Spend">{money(a.spend, currency)}</td>
            <td data-label="Leads">{num(a.leads)}</td>
            <td data-label="Customers">{num(a.customers)}</td>
            <td data-label="Per customer" className="hl">
              {a.costPerCustomer === null ? <span className="noleads">no customer yet</span> : money(a.costPerCustomer, currency)}
            </td>
            <td data-label="Per lead">{money(a.cpl, currency)}</td>
            <td data-label="Lead → customer">{pct(a.leadToCustomer, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
