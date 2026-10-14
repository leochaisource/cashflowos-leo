import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { runHotListTick } from '@/lib/hot-list-tick'
import { sendMessage } from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ARIELLA'S LIST, EVERY HOUR (owner, 2026-10-15) — call-back reminders, "they
// replied" pings and Ari's follow-ups for the Call back / Thinking / Link sent
// stages (lib/hot-list-tick.ts). No AI: it costs no Claude credit.
//
// The clock is an hourly trigger in the hot leads sheet's Apps Script
// (apps-script/hot-leads.gs → hotListTick), like /api/hotleads-sync.
//
//   POST /api/hotlist-tick           runs it and answers with what it did
//   POST /api/hotlist-tick?dry=1     works it out, sends and changes nothing
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>`. FAILS CLOSED.

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const client = AD_CLIENTS.find((c) => c.ghl?.hotList?.automation)
  if (!client || !supabaseConfigured) return Response.json({ ok: false, error: 'not configured' })
  const dryRun = new URL(req.url).searchParams.get('dry') === '1'
  let r: Awaited<ReturnType<typeof runHotListTick>>
  try {
    r = await runHotListTick({ client, db: supabase, dryRun })
  } catch (e) {
    r = { ok: false, error: (e as Error).message, pings: [], ari: [], parked: [], errors: [], dryRun }
  }
  const owner = process.env.OWNER_CHAT_ID?.trim()
  if (!r.ok && owner && !dryRun) await sendMessage(owner, `⚠️ Ariella's hourly list check failed: ${String(r.error).slice(0, 300)}`).catch(() => {})
  return Response.json({
    ok: r.ok,
    error: r.error,
    dryRun,
    pings: r.pings.map((p) => `${p.kind} · ${p.name}`),
    ari: r.ari.map((a) => `${a.tag} · ${a.name}`),
    parked: r.parked,
    errors: r.errors.slice(0, 5),
  })
}
