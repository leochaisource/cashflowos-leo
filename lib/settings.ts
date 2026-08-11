import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { PROJECTS, type Project } from './ad-clients'

// THE DEMO SWITCH.
//
// Sample data makes the dashboard presentable on a stage and costs real money to
// keep alive between presentations: the demo clients search Adyntel every
// morning, and those credits buy nothing when nobody is watching. This is the
// one switch that turns all of it off — the seeded rows disappear from every
// screen, and the demo clients stop being briefed.
//
// WHERE THE SETTING LIVES: a single row in `records`, under a category no tab
// reads. That's deliberate — it needs no new table, so there is no "paste this
// SQL first" step between deciding to flip it and it being flipped. It also
// means getRecords() can read the switch out of the rows it already fetched,
// costing nothing.
//
// OFF hides; it never deletes. The seeded rows stay in the database and come
// back untouched when it goes on again. To remove them for good:
//   node --env-file-if-exists=.env scripts/sample-data.mjs --purge

export const SETTING_CATEGORY = '_setting'
export const DEMO_SETTING = 'demo_data'

/** Unset = ON, so a fresh install (or an unreachable database) behaves exactly as it did before this switch existed. */
const DEFAULT_ON = true

type MaybeSettingRow = { category: string | null; title: string; meta?: Record<string, any> | null }

/** Read the switch out of rows already fetched — no second query. */
export function readDemoFlag(rows: MaybeSettingRow[]): boolean {
  const row = rows.find((r) => r.category === SETTING_CATEGORY && r.title === DEMO_SETTING)
  if (!row) return DEFAULT_ON
  return row.meta?.on !== false
}

/** Read the switch on its own (for callers that don't already hold the rows). */
export async function demoEnabled(): Promise<boolean> {
  if (!supabaseConfigured) return DEFAULT_ON
  const { data, error } = await supabase
    .from('records')
    .select('title, category, meta')
    .eq('category', SETTING_CATEGORY)
    .eq('title', DEMO_SETTING)
    .limit(1)
  if (error) return DEFAULT_ON
  return readDemoFlag((data ?? []) as MaybeSettingRow[])
}

/** Flip it. Returns the value actually stored. */
export async function setDemoEnabled(on: boolean): Promise<boolean> {
  if (!supabaseConfigured) throw new Error('Supabase is not connected.')
  const existing = await supabase
    .from('records')
    .select('id')
    .eq('category', SETTING_CATEGORY)
    .eq('title', DEMO_SETTING)
    .limit(1)

  const row = {
    title: DEMO_SETTING,
    status: on ? 'on' : 'off',
    amount: 0,
    category: SETTING_CATEGORY,
    notes: 'System row — the demo-data switch. Safe to delete; deleting it means ON.',
    meta: { on, changed_at: new Date().toISOString() },
  }

  const { error } = existing.data?.length
    ? await supabase.from('records').update(row).eq('id', existing.data[0].id)
    : await supabase.from('records').insert(row)
  if (error) throw new Error(error.message)
  return on
}

/**
 * The projects that should appear anywhere right now: everything when the
 * switch is on, only the real clients when it's off.
 *
 * This is what stops the morning cron from spending Adyntel credits on demo
 * clients — the saving that prompted the switch in the first place.
 */
export async function activeProjects(): Promise<Project[]> {
  const on = await demoEnabled()
  return on ? PROJECTS : PROJECTS.filter((p) => !p.demo)
}

/** Same filter, when the caller already knows the flag. */
export const filterProjects = (on: boolean): Project[] => (on ? PROJECTS : PROJECTS.filter((p) => !p.demo))
