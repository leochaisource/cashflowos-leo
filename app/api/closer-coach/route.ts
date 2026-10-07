import Anthropic from '@anthropic-ai/sdk'
import { after } from 'next/server'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { runCloserCoach } from '@/lib/closer-coach-run'
import { sendMessage } from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // ~30 threads read from GHL + one long model call

// THE 9AM CLOSING COACH (owner, 2026-10-07) — yesterday's WhatsApp threads, how
// Ari and Ariella handled them, why leads didn't close and the exact lines to
// use instead, sent to Ariella on Telegram (lib/closer-coach.ts).
//
// Fired by /api/hotleads-sync's 9am run (the sheet's Apps Script trigger — the
// only clock with a free slot), so this needs no cron of its own.
//
//   POST /api/closer-coach                   starts it, answers 202 at once
//   ...?wait=1                               runs it and answers with the result
//   ...?to=owner                             a preview to the owner instead
//   ...?to=none                              build only, send nothing
//   ...?day=2026-10-06  &force=1             another day / send again
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>` (the trigger's secret).
// FAILS CLOSED. Sent once per day; a failure goes to the owner privately.

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function run(q: URLSearchParams) {
  const client = AD_CLIENTS.find((c) => c.deal && c.ghl?.followupAssignee)
  if (!client) return { ok: false, error: 'no client with a follow-up owner' }
  const to = q.get('to') === 'owner' ? 'owner' : q.get('to') === 'none' ? 'none' : 'closer'
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('day') ?? '') ? q.get('day')! : undefined
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  try {
    const r = await runCloserCoach({
      client,
      day,
      to,
      db: supabaseConfigured ? supabase : null,
      anthropic: key ? new Anthropic({ apiKey: key, maxRetries: 4 }) : null,
      force: q.get('force') === '1',
    })
    if (!r.ok) {
      const owner = process.env.OWNER_CHAT_ID?.trim()
      if (owner) await sendMessage(owner, `⚠️ Closing coach for ${r.day} failed: ${String(r.error ?? 'unknown').slice(0, 300)}`).catch(() => {})
    }
    return r
  } catch (e) {
    const owner = process.env.OWNER_CHAT_ID?.trim()
    if (owner) await sendMessage(owner, `⚠️ Closing coach failed: ${(e as Error).message.slice(0, 300)}`).catch(() => {})
    return { ok: false, error: (e as Error).message }
  }
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const q = new URL(req.url).searchParams
  if (q.get('wait') === '1') return Response.json(await run(q))
  after(() => run(q))
  return Response.json({ ok: true, started: true }, { status: 202 })
}
