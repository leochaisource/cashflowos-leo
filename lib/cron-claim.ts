import { supabase, supabaseConfigured } from './supabase'

// Vercel delivers crons at least once, not exactly once: "Cron delivery can also
// occasionally invoke the same scheduled run more than once" (Vercel docs,
// Managing Cron Jobs). Without a guard, a duplicate 8am run re-sends the brief to
// the client's group and spends the Adyntel credits twice.
//
// A scheduled run claims `<name>:<Malaysia date>` in cron_claims first (one
// atomic insert on the primary key). A duplicate finds the key taken and stops
// before any message goes out. Only Vercel's own invocations claim — they carry
// the x-vercel-cron-schedule header — so a run started by hand (?client=, a
// script) always goes through. Table: supabase/cron-claims.sql.
export async function claimScheduledRun(req: Request, name: string): Promise<boolean> {
  if (!req.headers.get('x-vercel-cron-schedule') || !supabaseConfigured) return true
  const key = `${name}:${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })}`
  const { data, error } = await supabase
    .from('cron_claims')
    .upsert({ key }, { onConflict: 'key', ignoreDuplicates: true })
    .select()
  if (error) {
    console.error(`[CFO] cron claim ${key} failed (proceeding):`, error.message)
    return true // a claim hiccup must never cost the morning brief
  }
  return !!(data && data.length) // 0 rows ⇒ this run was already claimed
}
