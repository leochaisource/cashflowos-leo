'use server'

// The two things a project page can DO: pull fresh ad numbers, and record the
// numbers Meta doesn't know about.
//
// Same shape as app/approvals/actions.ts — a thin 'use server' wrapper so the
// client button never imports lib/supabase.ts (which is behind `server-only`
// and holds the service_role key).

import { revalidatePath } from 'next/cache'
import { getProject } from '@/lib/ad-clients'
import { syncProjectAds } from '@/lib/ad-sync'
import { supabase, supabaseConfigured } from '@/lib/supabase'

export type ActionResult = { ok: boolean; message: string }

/** Pull the last `days` from Meta into ad_daily, then re-render the page. */
export async function refreshProject(id: string, days = 14): Promise<ActionResult> {
  const project = getProject(id)
  if (!project) return { ok: false, message: 'Unknown project.' }
  try {
    const r = await syncProjectAds(project, days)
    revalidatePath(`/projects/${id}`)
    revalidatePath('/')
    return {
      ok: true,
      message: r.rows
        ? `Updated ${r.rows} ad-days from the last ${days} days.`
        : `Meta returned no delivery in the last ${days} days.`,
    }
  } catch (e) {
    // Say what actually broke. "Refresh failed" with no reason is how a wrong
    // token goes unnoticed for a week.
    return { ok: false, message: (e as Error).message }
  }
}

/**
 * Record a day's funnel numbers.
 *
 * A blank field is stored as NULL, not 0 — that distinction is the whole
 * contract with lib/metrics.ts. Typing a real 0 stores 0, and the dashboard
 * shows 0. Leaving it empty leaves the tile blank. Never "helpfully" default.
 */
export type FunnelInput = {
  leads?: string
  attended?: string
  appointments?: string
  signups?: string
  cash_collected?: string
  notes?: string
}

const numOrNull = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const t = v.trim()
  if (t === '') return null
  const n = Number(t.replace(/[, ]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Add a next step to a project (ad client or work project — meta.project holds
 * either id). A direct write, like the funnel form: the approval engine guards
 * ROBOT-initiated actions, and this is the owner clicking a button in their own
 * app. Reversible by ticking it off or /undo-style deletion later.
 */
export async function addStep(
  projectId: string,
  title: string,
  due: string,
): Promise<ActionResult> {
  const t = title.trim()
  if (!t) return { ok: false, message: 'What is the step?' }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, message: 'Bad date.' }
  if (!supabaseConfigured) return { ok: false, message: 'Supabase isn’t connected yet.' }
  const { error } = await supabase.from('records').insert({
    title: t.slice(0, 200),
    status: 'open',
    amount: 0,
    category: 'task',
    due_date: due || null,
    meta: { project: projectId, source: 'dashboard' },
  })
  if (error) return { ok: false, message: error.message }
  revalidatePath('/', 'layout')
  return { ok: true, message: due ? `Added — due ${due}.` : 'Added (no deadline).' }
}

/** Tick a step off, or untick it. Flips status only — nothing is deleted. */
export async function setStepDone(taskId: number, done: boolean): Promise<ActionResult> {
  if (!Number.isInteger(taskId)) return { ok: false, message: 'Unknown task.' }
  if (!supabaseConfigured) return { ok: false, message: 'Supabase isn’t connected yet.' }
  const { error } = await supabase
    .from('records')
    .update({ status: done ? 'done' : 'open' })
    .eq('id', taskId)
    .eq('category', 'task') // never let a task id flip some other kind of row
  if (error) return { ok: false, message: error.message }
  revalidatePath('/', 'layout')
  return { ok: true, message: done ? 'Done ✓' : 'Reopened.' }
}

export async function saveFunnelNumbers(
  id: string,
  date: string,
  input: FunnelInput,
): Promise<ActionResult> {
  const project = getProject(id)
  if (!project) return { ok: false, message: 'Unknown project.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Pick a date first.' }
  if (!supabaseConfigured) return { ok: false, message: 'Supabase isn’t connected yet.' }

  const row = {
    project: id,
    date,
    leads: numOrNull(input.leads),
    attended: numOrNull(input.attended),
    appointments: numOrNull(input.appointments),
    signups: numOrNull(input.signups),
    cash_collected: numOrNull(input.cash_collected),
    notes: input.notes?.trim() || null,
    source: 'manual',
    updated_at: new Date().toISOString(),
  }

  // Every field blank = nothing to record. Writing a row of NULLs would be a
  // silent no-op that looks like it saved.
  const hasAny = [row.leads, row.attended, row.appointments, row.signups, row.cash_collected].some(
    (v) => v !== null,
  )
  if (!hasAny) return { ok: false, message: 'Nothing to save — every field is empty.' }

  const { error } = await supabase.from('project_funnel').upsert(row, { onConflict: 'project,date' })
  if (error) return { ok: false, message: error.message }

  revalidatePath(`/projects/${id}`)
  revalidatePath('/')
  return { ok: true, message: `Saved ${date}.` }
}
