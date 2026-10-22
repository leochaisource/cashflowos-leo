import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { journeyFor } from '@/lib/funnel-config'
import { klToday } from '@/lib/funnel-data'
import { newlyRed } from '@/lib/funnel-view'
import { refreshJourney, storeCallLog, type SheetCall } from '@/lib/lead-journey'
import { sendMessage } from '@/lib/telegram'
import { APP_URL } from '@/lib/brief-digest'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// THE FUNNEL X-RAY's clock (owner, 2026-10-22). Called every hour by the hot
// leads sheet's Apps Script (apps-script/hot-leads.gs → hotListTick), with the
// sheet's Call Log in the body:
//   · every call stores the Call Log (call_log), so calls reach the journey;
//   · the first call from 6am KL rebuilds each client's lead journey for
//     yesterday (lib/lead-journey.ts) and tells the owner about any stage that
//     turned red since the last morning. No AI: it costs no Claude credit.
//
//   POST /api/lead-journey                 body { calls: [...] } (optional)
//   POST /api/lead-journey?force=1         rebuild now, even if done today
//   POST /api/lead-journey?day=YYYY-MM-DD  rebuild the cohort holding that day
//   POST /api/lead-journey?dry=1           work it out, write nothing
//
// Needs `Authorization: Bearer <SHEETS_HOTLEADS_SECRET>`. FAILS CLOSED.

const FROM_HOUR = 6

function authed(req: Request): boolean {
  const secret = process.env.SHEETS_HOTLEADS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

const klHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', hour12: false }))
const yesterday = () => new Date(Date.parse(`${klToday()}T00:00:00Z`) - 864e5).toISOString().slice(0, 10)
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  if (!supabaseConfigured) return Response.json({ ok: false, error: 'not configured' })
  const params = new URL(req.url).searchParams
  const dryRun = params.get('dry') === '1'
  const body = (await req.json().catch(() => ({}))) as { calls?: SheetCall[] }
  const clients = AD_CLIENTS.filter((c) => journeyFor(c.id) && c.ghl && c.deal)
  const out: Record<string, unknown> = {}

  for (const client of clients) {
    const steps: Record<string, unknown> = {}
    // The sheet holds one closer's Call Log — it belongs to the client with a hot list.
    if (Array.isArray(body.calls) && client.ghl?.hotList && !dryRun) {
      try {
        steps.calls = await storeCallLog(supabase, client.id, body.calls)
      } catch (e) {
        steps.calls = { error: (e as Error).message }
      }
    }

    const day = params.get('day') ?? yesterday()
    const marker = `funnel/${client.id}-refreshed.json`
    const { data } = await supabase.storage.from('cfo-cache').download(marker)
    const last = data ? ((JSON.parse(await data.text()) as { day?: string }).day ?? null) : null
    const due = params.get('force') === '1' || params.has('day') || (klHour() >= FROM_HOUR && last !== day)
    if (!due) {
      steps.journey = `done for ${last}`
      out[client.id] = steps
      continue
    }
    try {
      const r = await refreshJourney({ client, db: supabase, day, dryRun })
      steps.journey = r
      if (!dryRun && r.ok) {
        await supabase.storage.from('cfo-cache').upload(marker, JSON.stringify({ day, at: new Date().toISOString() }), { upsert: true, contentType: 'application/json' })
        // A stage that just turned red: one message to the owner.
        const { view, red } = await newlyRed(supabase, client)
        steps.red = red.map((x) => x.key)
        const owner = process.env.OWNER_CHAT_ID?.trim()
        if (red.length && owner && view) {
          const cur = client.currency || 'RM'
          const lines = red.map(
            (x) =>
              `🔴 <b>${x.label}</b> ${pct(x.rate)} vs ${pct(x.benchmark)} benchmark` +
              (x.atStake !== null ? ` · ~${cur}${Math.round(x.atStake).toLocaleString('en-MY')} at stake` : '') +
              (x.owner ? ` · ${x.owner}` : ''),
          )
          await sendMessage(
            owner,
            `🧭 <b>${client.name}: funnel stage turned red</b> (${view.window.label})\n${lines.join('\n')}\n\n<a href="${APP_URL}/projects/${client.id}/funnel">Open the Funnel tab</a>`,
            { noPreview: true },
          ).catch(() => {})
        }
      }
    } catch (e) {
      steps.journey = { ok: false, error: (e as Error).message }
    }
    out[client.id] = steps
  }
  return Response.json({ ok: true, dryRun, clients: out })
}
