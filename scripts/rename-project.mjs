// Rename a project id across every table that references it.
//
//   node --env-file-if-exists=.env scripts/rename-project.mjs kingsley-ai claude-malaysia
//
// The id in lib/ad-clients.ts is a foreign key in three tables. Change it in the
// config alone and the dashboard goes blank: the ads, the competitor set and the
// funnel rows are all still filed under the old name. This moves them.
//
// Safe to re-run: renaming an id that no longer exists updates 0 rows.
import { createClient } from '@supabase/supabase-js'

const [from, to] = process.argv.slice(2)
if (!from || !to) {
  console.error('usage: rename-project.mjs <old-id> <new-id>')
  process.exit(1)
}

const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

// table → the column holding the project id
const TABLES = [
  ['ad_daily', 'project'],
  ['project_funnel', 'project'],
  ['competitor_ads', 'client'],
]

console.log(`renaming "${from}" → "${to}"`)
for (const [table, column] of TABLES) {
  const { count: before } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, from)
  if (!before) { console.log(`  ${table.padEnd(16)} nothing to move`); continue }
  const { error } = await db.from(table).update({ [column]: to }).eq(column, from)
  if (error) { console.error(`  ${table}: FAILED — ${error.message}`); process.exitCode = 1; continue }
  const { count: after } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, to)
  const { count: left } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, from)
  console.log(`  ${table.padEnd(16)} moved ${before} row(s) · now ${after} under "${to}" · ${left} left behind`)
}
console.log('done — remember the id in lib/ad-clients.ts must match the new name')
