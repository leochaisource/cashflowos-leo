// Fill the "Leads Follow Up List" Google Sheet with hot leads for a range of
// report days — the backfill, and a manual re-run of any day.
//
//   node --env-file-if-exists=.env scripts/hotleads-sheet.ts --from=2026-09-24 --to=2026-09-30
//   node --env-file-if-exists=.env scripts/hotleads-sheet.ts --today     (today so far — what the 9am/12pm/6pm sync does)
//   ... --push      actually send the rows (default: print only)
//
// Each day is judged as it stood that day: "paid" means paid by that day's end,
// so a lead who was hot on the 25th and paid on the 28th still appears — with
// "Paid ✅ 2026-09-28" in the Paid? column. Re-running a day updates its rows;
// the team's status and Notes columns are never touched.
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { syncHotLeadsDay, localDay } from '../lib/hot-leads-sync.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const PUSH = process.argv.includes('--push')
const TODAY = process.argv.includes('--today')
const client = AD_CLIENTS.find((c) => c.deal && c.ghl)
if (!client?.deal || !client.ghl) throw new Error('no client with a deal and GHL')
const tz = client.ghl.timeZone ?? 'Asia/Kuala_Lumpur'
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const url = process.env.SHEETS_HOTLEADS_URL?.trim()
const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
if (PUSH && (!url || !secret)) throw new Error('set SHEETS_HOTLEADS_URL and SHEETS_HOTLEADS_SECRET in .env to push')

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const yesterday = localDay(tz, new Date(Date.now() - 864e5))
const from = TODAY ? localDay(tz) : (arg('from') ?? yesterday)
const to = TODAY ? from : (arg('to') ?? from)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() })

let total = 0
for (let day = from; day <= to; day = addDay(day, 1)) {
  const t0 = Date.now()
  const s = await syncHotLeadsDay({
    client,
    day,
    untilISO: TODAY ? new Date().toISOString() : undefined,
    db,
    anthropic,
    push: PUSH ? { url: url!, secret: secret! } : null,
  })
  if (!s) {
    console.log(`${day}: no event scheduled — skipped`)
    continue
  }
  const { rows, followups: f } = s
  total += rows.length
  console.log(`\n${day}${TODAY ? ' (so far)' : ''}: ${rows.length} hot lead row(s) — ${f.chats.length} chats judged in ${Math.round((Date.now() - t0) / 1000)}s${f.intentError ? ` · intent: ${f.intentError.slice(0, 80)}` : ''}`)
  for (const r of rows)
    console.log(`  ${String(r.Type).padEnd(14).slice(0, 14)} ${String(r.Name).padEnd(24).slice(0, 24)} | ${r.Industry || '-'} / ${r.Role || '-'} | in ${r['Opted in'] || '-'} | ${r.Interest} | obj: ${r.Objection} | ${r['Paid?']}`)
  if (s.pushed) console.log(`  → sheet: ${JSON.stringify(s.pushed)}`)
}
console.log(`\n${total} row(s) across ${from} → ${to}${PUSH ? ' (pushed)' : ' (not pushed — add --push)'}`)
