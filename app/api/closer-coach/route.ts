import { claudeClient } from '@/lib/claude-usage'
import { after } from 'next/server'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { runCloserCoach } from '@/lib/closer-coach-run'
import { runCallList } from '@/lib/call-list'
import { runWebinarReminder } from '@/lib/webinar-reminder'
import { sendMessage } from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // ~30 threads read from GHL + one long model call

// THE 9AM CLOSING COACH (owner, 2026-10-07) — yesterday's WhatsApp threads, how
// Ari and Ariella handled them, why leads didn't close and the exact lines to
// use instead, sent to Ariella on Telegram (lib/closer-coach.ts).
//
// Fired by /api/hotleads-sync's 9am run (the sheet's Apps Script trigger — the
// only clock with a free slot), so this needs no cron of its own. The same run
// sends the webinar hype-up reminder on T-5 (lib/webinar-reminder.ts), and after
// the coach, Ariella's "Call these first" as its own message (lib/call-list.ts,
// owner 2026-11-25): the top 10 business owners, CEOs and HODs on her list by
// buying intent. Each step fails on its own and tells the owner.
//
//   POST /api/closer-coach                   starts it, answers 202 at once
//   ...?wait=1                               runs it and answers with the result
//   ...?to=owner                             a preview to the owner instead
//   ...?to=none                              build only, send nothing
//   ...?day=2026-10-06  &force=1             another day / send again
//   ...?only=calllist                         just the call list (with to= / force= as above)
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>` (the trigger's secret).
// FAILS CLOSED. Sent once per day; a failure goes to the owner privately.

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

// The call list shares this run's 300s: it must be done by here.
const RUN_BUDGET_MS = 280_000

async function run(q: URLSearchParams) {
  const started = Date.now()
  const client = AD_CLIENTS.find((c) => c.deal && c.ghl?.followupAssignee)
  if (!client) return { ok: false, error: 'no client with a follow-up owner' }
  const to = q.get('to') === 'owner' ? 'owner' : q.get('to') === 'none' ? 'none' : 'closer'
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('day') ?? '') ? q.get('day')! : undefined
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  const callList = async () => {
    // Today's list only (a ?day= re-run of the coach doesn't resend it).
    if (!client.ghl?.callList || day) return null
    try {
      const r = await runCallList({
        client,
        db: supabaseConfigured ? supabase : null,
        anthropic: key ? claudeClient('call-list', { apiKey: key, maxRetries: 1 }) : null,
        to,
        deadline: started + RUN_BUDGET_MS,
        // A forced coach re-send doesn't resend this; ?only=calllist&force=1 does.
        force: q.get('force') === '1' && q.get('only') === 'calllist',
      })
      if (!r.ok) throw new Error(r.error ?? 'not sent')
      return r
    } catch (e) {
      const owner = process.env.OWNER_CHAT_ID?.trim()
      if (owner) await sendMessage(owner, `⚠️ Ariella's "Call these first" list failed: ${(e as Error).message.slice(0, 300)}`).catch(() => {})
      return { ok: false, error: (e as Error).message }
    }
  }
  if (q.get('only') === 'calllist') return (await callList()) ?? { ok: false, error: 'no call list for this client or day' }
  // The real 9am run also carries the webinar hype-up reminder (T-5, owner
  // 2026-10-11): first, short, and independent — its failure never stops the coach.
  if (to === 'closer' && !day) {
    try {
      const w = await runWebinarReminder({ client, db: supabaseConfigured ? supabase : null, to: 'closer' })
      if (!w.ok) throw new Error(w.error ?? 'not sent')
    } catch (e) {
      const owner = process.env.OWNER_CHAT_ID?.trim()
      if (owner) await sendMessage(owner, `⚠️ Webinar hype-up reminder failed: ${(e as Error).message.slice(0, 300)}`).catch(() => {})
    }
  }
  try {
    const r = await runCloserCoach({
      client,
      day,
      to,
      db: supabaseConfigured ? supabase : null,
      anthropic: key ? claudeClient('closer-coach', { apiKey: key, maxRetries: 4 }) : null,
      force: q.get('force') === '1',
    })
    if (!r.ok) {
      const owner = process.env.OWNER_CHAT_ID?.trim()
      if (owner) await sendMessage(owner, `⚠️ Closing coach for ${r.day} failed: ${String(r.error ?? 'unknown').slice(0, 300)}`).catch(() => {})
    }
    return { ...r, callList: await callList() }
  } catch (e) {
    const owner = process.env.OWNER_CHAT_ID?.trim()
    if (owner) await sendMessage(owner, `⚠️ Closing coach failed: ${(e as Error).message.slice(0, 300)}`).catch(() => {})
    return { ok: false, error: (e as Error).message, callList: await callList() }
  }
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const q = new URL(req.url).searchParams
  if (q.get('wait') === '1') return Response.json(await run(q))
  after(() => run(q))
  return Response.json({ ok: true, started: true }, { status: 202 })
}
