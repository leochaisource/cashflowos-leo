import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { claudeClient } from '@/lib/claude-usage'
import { BATCH_FEATURE, collectIntentBatch, klHour, klYesterday, submitIntentBatch, type BatchStep } from '@/lib/intent-batch'
import { collectCoachBatch } from '@/lib/coach-batch'
import { submitOvernightCoach } from '@/lib/closer-coach-run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// THE OVERNIGHT HALF-PRICE BATCH (owner, 2026-10-15/16) — lib/intent-batch.ts
// (lead judging) and lib/coach-batch.ts (Ariella's 9am coach). Called every hour
// by the hot leads sheet's Apps Script (apps-script/hot-leads.gs → hotListTick).
// Every call files finished batches; between midnight and 7am KL it also sends
// yesterday's not-yet-judged chats and yesterday's coaching request, once each.
// The 8am run then judges live only what the batch didn't answer, and the 9am
// coach uses the filed report (live only when there isn't one).
//
//   POST /api/intent-batch           collect, and submit when it's time
//   POST /api/intent-batch?dry=1     what it would send; sends nothing
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>`. FAILS CLOSED.

const SUBMIT_UNTIL_HOUR = 7 // a batch sent later may not be back by 8am

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key || !supabaseConfigured) return Response.json({ ok: false, error: 'not configured' })
  const dryRun = new URL(req.url).searchParams.get('dry') === '1'
  const anthropic = claudeClient(BATCH_FEATURE, { apiKey: key })
  const day = klYesterday()
  const out: Record<string, BatchStep[]> = {}
  for (const client of AD_CLIENTS.filter((c) => c.ghl?.followups && c.deal)) {
    const steps: BatchStep[] = []
    const step = async (fn: () => Promise<BatchStep>) => {
      try {
        steps.push(await fn())
      } catch (e) {
        steps.push({ ok: false, action: 'failed', error: (e as Error).message.slice(0, 300) })
      }
    }
    const submit = klHour() < SUBMIT_UNTIL_HOUR
    if (!dryRun) await step(() => collectIntentBatch({ client, anthropic, db: supabase }))
    if (submit) await step(() => submitIntentBatch({ client, anthropic, db: supabase, day, dryRun }))
    if (!dryRun && client.ghl?.followupAssignee) {
      await step(() => collectCoachBatch({ client, anthropic, db: supabase }))
      if (submit) await step(() => submitOvernightCoach({ client, anthropic, db: supabase }))
    }
    out[client.id] = steps
  }
  return Response.json({ ok: Object.values(out).flat().every((s) => s.ok), dryRun, day, clients: out })
}
