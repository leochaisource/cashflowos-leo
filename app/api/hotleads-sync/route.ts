import { claudeClient } from '@/lib/claude-usage'
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
// 12pm, 3pm, 6pm and 9pm (Kuala Lumpur). Vercel's Hobby plan allows two crons,
// run once a day, and both are taken — so the clock is a time trigger in the
// sheet's own Apps Script (apps-script/hot-leads.gs → syncHotLeads), which calls this.
//
// API COST (owner, 2026-10-16): chats are judged twice a day — by the overnight
// half-price batch after midnight (/api/intent-batch, on the list at 8am) and
// by the 3pm run here (JUDGE_HOURS). The other runs reuse saved verdicts and
// still bring in checkouts, failed payments, tags and payments, at no cost. A
// chat that turns hot after 3pm is judged overnight.
//
//   POST /api/hotleads-sync            starts the sync, answers 202 at once
//   POST /api/hotleads-sync?wait=1     runs it and answers with the result
//   ...&judge=1 / &judge=0             judge new chats now, or don't, whatever the hour
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>` — the secret the sheet's
// script already holds. FAILS CLOSED: no secret set, everyone gets 401.
// The sheet, plus Ariella's GHL list (lib/hot-list.ts, 2026-10-14). No tags or
// Telegram messages — the 8am run does those.
// A failure is sent to the owner privately, so a silent sheet never goes unseen.

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

const JUDGE_HOURS = [15]

/** A judging run? The trigger fires within ~15 minutes of the hour, so the nearest hour counts. */
function judgeNow(override: string | null): boolean {
  if (override === '1' || override === '0') return override === '1'
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false }).split(':').map(Number)
  return JUDGE_HOURS.includes(Math.round(h + m / 60) % 24)
}

async function run(judge: boolean) {
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
    anthropic: key ? claudeClient('intent-judge-refresh', { apiKey: key, maxRetries: 4 }) : null,
    push: { url, secret },
    syncList: true,
    judge,
  })
  if (!s) return { ok: true as const, skipped: 'no event scheduled' }
  if (!s.pushed?.ok) return { ok: false as const, error: `sheet: ${s.pushed?.error ?? 'not pushed'}` }
  return {
    ok: true as const,
    day: s.day,
    judged: judge,
    intentStats: s.followups.intentStats ?? null,
    chats: s.followups.chats.length,
    rows: s.rows.length,
    intentError: s.followups.intentError ?? null,
    sheet: s.pushed,
    leads: s.rows.map((r) => `${r.Type} · ${r.Name}`),
    hotList: s.hotList
      ? { ok: s.hotList.ok, error: s.hotList.error, open: s.hotList.open.length, added: s.hotList.added.map((c) => c.name), reopened: s.hotList.reopened.map((c) => c.name), paid: s.hotList.paid.map((c) => c.name), errors: s.hotList.errors.slice(0, 3) }
      : null,
  }
}

async function runAndReport(judge: boolean) {
  let result: Awaited<ReturnType<typeof run>> | { ok: false; error: string }
  try {
    result = await run(judge)
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
  const params = new URL(req.url).searchParams
  const judge = judgeNow(params.get('judge'))
  if (params.get('wait') === '1') return Response.json(await runAndReport(judge))
  startCoachIfMorning()
  after(() => runAndReport(judge))
  return Response.json({ ok: true, started: true }, { status: 202 })
}
