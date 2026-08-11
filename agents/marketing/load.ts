import 'server-only'
import { loadAdRows } from '@/lib/metrics'
import { activeProjects } from '@/lib/settings'
import { aggregate, windowDays, type AdAgg } from './definition'

// The Head of Marketing's data mouth. Split out from definition.ts on purpose:
// definition.ts must stay runtime-import-free so the dry-run script can share its
// maths, and `server-only` + supabase would break that.
//
// Reuses loadAdRows() from lib/metrics.ts — the same query the project dashboard
// runs, so the head and the dashboard can never disagree about what an ad spent.

const sinceISO = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * Every ad in the window, rolled up per ad, across every project that currently
 * counts. With the demo switch off the sample clients drop out, so the head
 * never grades an ad the rest of the dashboard is hiding.
 */
export async function loadAdAggregates(): Promise<AdAgg[]> {
  const projects = await activeProjects()
  const rows = await loadAdRows(
    projects.map((p) => p.id),
    sinceISO(windowDays()),
  )
  return aggregate(rows as any[])
}
