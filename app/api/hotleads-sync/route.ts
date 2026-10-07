import Anthropic from '@anthropic-ai/sdk'
import { after } from 'next/server'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { syncHotLeadsDay, localDay } from '@/lib/hot-leads-sync'
import { sendMessage } from '@/lib/telegram'
import { APP_URL } from '@/lib/brief-digest'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // WhatsApp export + the model's judging take 1–3 minutes

// TODAY'S HOT LEADS → THE SHEET, during the day (owner, 2026-10-02).
//
// The 8am cron fills the "Hot leads" tab with yesterday's leads. The team works
// the list during the day, so it is also refreshed with TODAY SO FAR at 9am,
// 12pm and 6pm (Kuala Lumpur). Vercel's Hobby plan allows two crons, run once a
// day, and both are taken — so the clock is a time trigger in the sheet's own
// Apps Script (apps-script/hot-leads.gs → syncHotLeads), which calls this.
//
//   POST /api/hotleads-sync            starts the sync, answers 202 at once
//   POST /api/hotleads-sync?wait=1     runs it and answers with the result
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>` — the secret the sheet's
// script already holds. FAILS CLOSED: no secret set, everyone gets 401.
// Sheet only: no GHL tasks, tags or Telegram messages (the 8am run does those).
// A failure is sent to the owner privately, so a silent sheet never goes unseen.

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function run() {
  const client = AD_CLIENTS.find((c) => c.deal && c.ghl?.followups)
  const url = process.env.SHEETS_HOTLEADS_URL?.trim()
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  if (!client?.ghl || !url || !secret) return { ok: false as const, error: 'not configured' }
  const tz = client.ghl.timeZone ?? 'Asia/Kuala_Lumpur'
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  const s = await syncHotLeadsDay({
    client,
    day: localDay(tz),
    untilISO: new Date().toISOString(),
    db: supabaseConfigured ? supabase : null,
    anthropic: key ? new Anthropic({ apiKey: key, maxRetries: 4 }) : null,
    push: { url, secret },
  })
  if (!s) return { ok: true as const, skipped: 'no event scheduled' }
  if (!s.pushed?.ok) return { ok: false as const, error: `sheet: ${s.pushed?.error ?? 'not pushed'}` }
  return {
    ok: true as const,
    day: s.day,
    chats: s.followups.chats.length,
    rows: s.rows.length,
    intentError: s.followups.intentError ?? null,
    sheet: s.pushed,
    leads: s.rows.map((r) => `${r.Type} · ${r.Name}`),
  }
}

async function runAndReport() {
  let result: Awaited<ReturnType<typeof run>> | { ok: false; error: string }
  try {
    result = await run()
  } catch (e) {
    result = { ok: false, error: (e as Error).message }
  }
  const owner = process.env.OWNER_CHAT_ID?.trim()
  if (!result.ok && owner)
    await sendMessage(owner, `⚠️ Hot leads sheet — the daytime update failed: ${result.error.slice(0, 300)}`).catch(() => {})
  if (!result.ok) console.error('hotleads-sync failed:', result.error)
  return result
}

/**
 * The 9am run also starts the closing coach (/api/closer-coach) — this trigger
 * is the only morning clock with room. It runs as its own request, so the
 * sheet and the coach each get the full time limit; it sends once per day.
 */
function startCoachIfMorning() {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', hour12: false }))
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  if (hour < 8 || hour > 10 || !secret) return
  after(() =>
    fetch(`${APP_URL}/api/closer-coach`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } })
      .then((r) => {
        if (r.status !== 202) console.error('closer-coach did not start:', r.status)
      })
      .catch((e) => console.error('closer-coach did not start:', (e as Error).message)),
  )
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  if (new URL(req.url).searchParams.get('wait') === '1') return Response.json(await runAndReport())
  startCoachIfMorning()
  after(runAndReport)
  return Response.json({ ok: true, started: true }, { status: 202 })
}
