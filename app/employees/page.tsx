import { AGENTS, type AgentMeta } from '@/agents/registry'
import { HEADS, DIRECT_REPORT_KEYS } from '@/agents/heads'
import { supabase, supabaseConfigured } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// The last time each robot ran, and how it went. Feeds the "last run" line on each
// employee card. Guarded so an unconfigured/placeholder Supabase returns an empty
// map instantly (no ~7s hang) instead of blocking the whole tab.
type LastRun = { outcome: string | null; when: string }

async function getLastRuns(): Promise<Record<string, LastRun>> {
  if (!supabaseConfigured) return {}
  const { data, error } = await supabase
    .from('agent_runs')
    .select('agent_key, outcome, started_at, finished_at')
    .order('started_at', { ascending: false })
  if (error) {
    console.error('[CFO] could not read agent_runs:', error.message)
    return {}
  }
  // Rows come newest-first, so the FIRST time we see an agent_key is its latest run.
  const latest: Record<string, LastRun> = {}
  for (const r of data ?? []) {
    if (r.agent_key && !latest[r.agent_key]) {
      latest[r.agent_key] = { outcome: r.outcome, when: r.finished_at || r.started_at }
    }
  }
  return latest
}

// Map a run outcome to a small pill class (reuses the .pill styles in globals.css).
function outcomeClass(outcome: string | null): string {
  const o = (outcome || '').toLowerCase()
  if (o === 'ok' || o === 'done' || o === 'executed') return 'done'
  if (o === 'failed' || o === 'error') return 'failed'
  if (o === 'escalated') return 'pending'
  return 'open'
}

export default async function Employees() {
  const lastRuns = await getLastRuns()
  const byKey = new Map(AGENTS.map(a => [a.key, a]))

  // One robot card. Unchanged from before — only the grouping around it is new.
  const card = (a: AgentMeta) => {
    const run = lastRuns[a.key]
    return (
      <div className="agent-card" key={a.key}>
        <p className="ac-name">
          <span aria-hidden="true">{a.emoji}</span> {a.label}
          {run ? (
            <span className={`pill ${outcomeClass(run.outcome)}`}>{run.outcome || 'ran'}</span>
          ) : (
            <span className="pill open">not run yet</span>
          )}
        </p>
        <p className="ac-role">{a.autonomyNote}</p>
        <p className="ac-lastrun">
          {run
            ? `Last run: ${new Date(run.when).toLocaleString('en-MY')}`
            : 'Last run: — (this robot hasn’t done anything yet)'}
        </p>
      </div>
    )
  }

  // Everything the org chart accounts for, so we can catch anything it doesn't.
  const placed = new Set([...HEADS.flatMap(h => h.agentKeys), ...DIRECT_REPORT_KEYS])
  const unassigned = AGENTS.filter(a => !placed.has(a.key))

  return (
    <>
      <h1 className="ph">AI Employees 🤖</h1>
      <p className="cap">
        Your robot team, by department — each one&apos;s job and how much it&apos;s allowed to do on
        its own. The org chart is in <code>docs/ai-csuite-blueprint.md</code>.
      </p>

      {HEADS.map(h => {
        const team = h.agentKeys.map(k => byKey.get(k)).filter((a): a is AgentMeta => !!a)
        if (team.length === 0) return null
        return (
          <div key={h.key} style={{ marginBottom: 26 }}>
            <p className="rowlabel">
              {h.emoji} {h.label}
            </p>
            {team.map(card)}
          </div>
        )
      })}

      {/* Read-only, cross-department — answers to you, not to a head. */}
      {DIRECT_REPORT_KEYS.some(k => byKey.has(k)) && (
        <div style={{ marginBottom: 26 }}>
          <p className="rowlabel">🙋 Reports to you directly</p>
          {DIRECT_REPORT_KEYS.map(k => byKey.get(k))
            .filter((a): a is AgentMeta => !!a)
            .map(card)}
        </div>
      )}

      {/* A robot nobody claimed — visible on purpose, so it can't go missing. */}
      {unassigned.length > 0 && (
        <div>
          <p className="rowlabel">Not assigned to a head yet</p>
          {unassigned.map(card)}
        </div>
      )}
    </>
  )
}
