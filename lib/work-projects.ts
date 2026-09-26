import type { Rec } from './records'
import { todayISO } from './records'

// WORK PROJECTS — the projects that aren't ad accounts.
//
// An ad client needs code config (env var names, lead action types, keywords),
// so it lives in lib/ad-clients.ts. A work project — "fix Dr Tariq's malware by
// Tuesday" — needs only a name, a status, a deadline and a list of next steps.
// That is exactly a `records` row, so that's where they live:
//
//   category 'project'  → the project itself (meta.slug is its stable id,
//                         meta.client who it's for, meta.phase where it's at)
//   category 'task'     → a next step, tied to a project by meta.project,
//                         which holds EITHER a work slug or an ad-client id —
//                         the same convention receipts already use.
//
// Everything here is a pure function over rows already fetched. No I/O, no
// server-only import: the crons, the pages and the bot all reuse it against the
// one getRecords() call they each already make.

const DONE = new Set(['done', 'completed', 'complete', 'closed', 'shipped', 'reversed'])
export const isDone = (r: Rec) => DONE.has((r.status || '').toLowerCase())

export type WorkProject = {
  slug: string
  name: string
  client: string | null
  status: string
  phase: string | null
  due: string | null
  notes: string | null
  recordId: number
}

/** Stable slug for a project row: meta.slug, else derived from the title. */
export const slugOf = (r: Rec): string =>
  (r.meta?.slug as string) ||
  r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** Every work project in the rows, soonest deadline first, done ones last. */
export function workProjectsFrom(rows: Rec[]): WorkProject[] {
  return rows
    .filter((r) => r.category === 'project')
    .map((r) => ({
      slug: slugOf(r),
      name: r.title,
      client: (r.meta?.client as string) ?? null,
      status: r.status || 'active',
      phase: (r.meta?.phase as string) ?? null,
      due: r.due_date,
      notes: r.notes,
      recordId: r.id,
    }))
    .sort((a, b) => {
      const ad = DONE.has(a.status.toLowerCase()) ? 1 : 0
      const bd = DONE.has(b.status.toLowerCase()) ? 1 : 0
      if (ad !== bd) return ad - bd
      return (a.due ?? '9999').localeCompare(b.due ?? '9999')
    })
}

export const findWorkProject = (rows: Rec[], slug: string): WorkProject | undefined =>
  workProjectsFrom(rows).find((p) => p.slug === slug)

// ---------------------------------------------------------------- next steps
export type Step = {
  id: number
  title: string
  due: string | null
  done: boolean
  overdue: boolean
  owner: string | null
}

/**
 * The next steps for one project (work slug or ad-client id), open first —
 * overdue at the top, then by deadline, undated last — then recent done ones.
 */
export function stepsFor(rows: Rec[], projectId: string, today = todayISO()): { open: Step[]; done: Step[] } {
  const all = rows
    .filter((r) => r.category === 'task' && r.meta?.project === projectId)
    .map((r) => ({
      id: r.id,
      title: r.title,
      due: r.due_date,
      done: isDone(r),
      overdue: !isDone(r) && !!r.due_date && r.due_date < today,
      owner: (r.meta?.owner as string) ?? null,
    }))
  const open = all
    .filter((s) => !s.done)
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
      return (a.due ?? '9999').localeCompare(b.due ?? '9999')
    })
  const done = all.filter((s) => s.done).sort((a, b) => b.id - a.id)
  return { open, done }
}

/** The one-line summary a card or overview row shows. */
export function stepsSummary(rows: Rec[], projectId: string, today = todayISO()) {
  const { open } = stepsFor(rows, projectId, today)
  const next = open[0] ?? null
  return {
    open: open.length,
    overdue: open.filter((s) => s.overdue).length,
    next: next ? { title: next.title, due: next.due, overdue: next.overdue } : null,
  }
}

/**
 * The brief's view: every project that has open steps, as compact text lines.
 * `projects` maps id → display name so ad clients and work projects read alike.
 */
/**
 * Only the steps that need the owner NOW — overdue, due today or due tomorrow —
 * one line each, most overdue first. The 9am brief is sent only when this (or a
 * live approval, or a newly overdue invoice) has something in it.
 */
export function urgentStepLines(
  rows: Rec[],
  projects: { id: string; name: string }[],
  today = todayISO(),
  withinDays = 1,
): string[] {
  const days = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000)
  const seen = new Set<string>()
  const out: { n: number; line: string }[] = []
  for (const p of projects) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    for (const s of stepsFor(rows, p.id, today).open) {
      if (!s.due) continue
      const n = days(s.due)
      if (n > withinDays) continue
      const when = n < 0 ? `OVERDUE by ${-n}d` : n === 0 ? 'due today' : 'due tomorrow'
      out.push({ n, line: `${p.name}: ${s.title} (${when})` })
    }
  }
  return out.sort((a, b) => a.n - b.n).map((o) => o.line)
}

