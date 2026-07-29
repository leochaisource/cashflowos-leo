import { getRecords, getFunnel, rm, todayISO } from '@/lib/records'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { HEADS } from '@/agents/heads'
import FunnelBar from '@/app/_components/FunnelBar'
import Stat from '@/app/_components/Stat'
import HeadCard from '@/app/_components/HeadCard'

export const dynamic = 'force-dynamic'

// THE WHOLE-BUSINESS VIEW — everything added up, across every project.
// This was the home dashboard before the project-first makeover; it still
// answers "how is the business doing", which is a different question from
// "which client is working". Home answers the second one now.

// Count of proposals still waiting on a human YES — the 🙋 number. Guarded so an
// unconfigured/placeholder Supabase returns 0 instantly instead of hanging.
async function proposedCount(): Promise<number> {
  if (!supabaseConfigured) return 0
  const { count, error } = await supabase
    .from('agent_actions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'proposed')
  if (error) return 0
  return count ?? 0
}

export default async function Agency() {
  const [rows, waiting] = await Promise.all([getRecords(), proposedCount()])
  const funnel = getFunnel(rows)

  // ── The Money row ───────────────────────────────────────────────
  const sum = (cat: string, statuses?: string[]) =>
    rows
      .filter(r => r.category === cat && (!statuses || statuses.includes((r.status || '').toLowerCase())))
      .reduce((s, r) => s + Number(r.amount || 0), 0)

  const cashIn = sum('cash_in')
  const cashOut = sum('cash_out')
  const net = cashIn - cashOut
  // "Who owes me" = money-in that hasn't landed yet (waiting / overdue / unpaid).
  const owed = sum('cash_in', ['waiting', 'overdue', 'unpaid', 'pending'])

  return (
    <>
      <h1 className="ph">Agency</h1>
      <p className="cap">Everything added up — the river, the money, and what needs your YES.</p>

      {/* Row 1 — the funnel (whole-business river) */}
      <FunnelBar funnel={funnel} />

      {/* Row 2 — the money + the 🙋 count */}
      <p className="rowlabel">The Money</p>
      <div className="grid">
        <Stat label="Cash In" value={rm(cashIn)} />
        <Stat label="Cash Out" value={rm(cashOut)} />
        <Stat label="Net" value={rm(net)} />
        <Stat label="Who Owes Me" value={rm(owed)} />
        <Stat label="🙋 Needs your YES" value={waiting} yes={waiting > 0} href="/approvals" />
      </div>

      {/* Row 3 — the C-Suite (docs/ai-csuite-blueprint.md). Four department heads,
          each reading the SAME rows above through its own lens. They recommend;
          you decide. A head with nothing to read says so rather than showing a
          confident zero. */}
      <p className="rowlabel">Your C-Suite</p>
      {HEADS.map(h => (
        <HeadCard key={h.key} head={h} brief={h.brief(rows, todayISO())} />
      ))}
    </>
  )
}
