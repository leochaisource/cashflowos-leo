import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { claudeClient } from '@/lib/claude-usage'
import { BATCH_FEATURE, collectIntentBatch, klHour, klYesterday, submitIntentBatch, type BatchStep } from '@/lib/intent-batch'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// THE OVERNIGHT HALF-PRICE JUDGE (owner, 2026-10-15) — lib/intent-batch.ts.
// Called every hour by the hot leads sheet's Apps Script (apps-script/
// hot-leads.gs → hotListTick). Every call files a finished batch's verdicts;
// between midnight and 7am KL it also sends yesterday's not-yet-judged chats,
// once. The 8am run then judges live only what the batch didn't answer.
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
    try {
      if (!dryRun) steps.push(await collectIntentBatch({ client, anthropic, db: supabase }))
      if (klHour() < SUBMIT_UNTIL_HOUR) steps.push(await submitIntentBatch({ client, anthropic, db: supabase, day, dryRun }))
    } catch (e) {
      steps.push({ ok: false, action: 'failed', error: (e as Error).message.slice(0, 300) })
    }
    out[client.id] = steps
  }
  return Response.json({ ok: Object.values(out).flat().every((s) => s.ok), dryRun, day, clients: out })
}
