import { supabase, supabaseConfigured } from '@/lib/supabase'
import { AD_CLIENTS } from '@/lib/ad-clients'
import { eventFor } from '@/lib/deal'

export const dynamic = 'force-dynamic'

// THE HOUSE'S DAILY SEAT SPLIT — Kingsley's EventOps posts here.
//
// Why a feed: Leo's share depends on how many paid seats are Ads Seats vs
// Organic Seats (Marketing Collaboration Agreement, clause 6), and only the
// House's records (payment gateway + community join dates) settle that. EventOps
// already sends the numbers to the "CM Ads & Partners" Telegram group every
// morning — but through a bot, and Telegram never shows one bot's messages to
// another, so our bot can't read them there.
//
//   POST /api/eventops                     the morning's numbers (JSON below)
//   GET  /api/eventops?event=2026-10-04    ad spend for that event's window, in
//                                          return — fills EventOps' CPP line
//
// Both need `Authorization: Bearer <EVENTOPS_SECRET>`. FAILS CLOSED: with no
// secret set, everyone gets 401.
//
// POST body (numbers as EventOps reports them; unknown fields are kept in `raw`):
//   { "event_date": "2026-10-04", "report_date": "2026-09-27", "paid": 36, "target": 70,
//     "ads_confirmed": 29, "organic_confirmed": 6, "unknown": 1, "general": 29, "vip": 7,
//     "affiliate_seats": 0, "ads_revenue": null, "organic_revenue": null }

function authed(req: Request): boolean {
  const secret = process.env.EVENTOPS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN)
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

/** The one project with a deal — the House only ever reports its own events. */
const dealClient = () => AD_CLIENTS.find((c) => c.deal)

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const client = dealClient()
  if (!client || !supabaseConfigured) return Response.json({ ok: false, error: 'not configured' }, { status: 503 })

  let b: Record<string, unknown>
  try {
    b = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ ok: false, error: 'body must be JSON' }, { status: 400 })
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })
  const eventDate = String(b.event_date ?? '')
  const reportDate = b.report_date ? String(b.report_date) : today
  if (!DATE.test(eventDate) || !DATE.test(reportDate))
    return Response.json({ ok: false, error: 'event_date and report_date must be YYYY-MM-DD' }, { status: 400 })

  const row = {
    project: client.id,
    event_date: eventDate,
    report_date: reportDate,
    paid: int(b.paid),
    target: int(b.target),
    ads_confirmed: int(b.ads_confirmed),
    organic_confirmed: int(b.organic_confirmed),
    unknown: int(b.unknown),
    general: int(b.general),
    vip: int(b.vip),
    affiliate_seats: int(b.affiliate_seats),
    ads_revenue: num(b.ads_revenue),
    organic_revenue: num(b.organic_revenue),
    raw: b,
    received_at: new Date().toISOString(),
  }
  const bad = Object.entries(row).filter(([, v]) => typeof v === 'number' && Number.isNaN(v)).map(([k]) => k)
  if (bad.length) return Response.json({ ok: false, error: `not a valid number: ${bad.join(', ')}` }, { status: 400 })
  if (row.ads_confirmed === null || row.organic_confirmed === null)
    return Response.json({ ok: false, error: 'ads_confirmed and organic_confirmed are required' }, { status: 400 })

  const { error } = await supabase.from('house_reports').upsert(row, { onConflict: 'project,event_date,report_date' })
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  return Response.json({ ok: true, stored: { event_date: eventDate, report_date: reportDate } })
}

export async function GET(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const client = dealClient()
  if (!client?.deal || !supabaseConfigured) return Response.json({ ok: false, error: 'not configured' }, { status: 503 })

  const event = new URL(req.url).searchParams.get('event') ?? ''
  if (!DATE.test(event)) return Response.json({ ok: false, error: 'pass ?event=YYYY-MM-DD' }, { status: 400 })
  const w = eventFor(client.deal, event)
  if (!w || w.to !== event) return Response.json({ ok: false, error: 'not an event date in the agreement schedule' }, { status: 404 })

  const byDay = new Map<string, number>()
  for (let at = 0; ; at += 1000) {
    const { data, error } = await supabase
      .from('ad_daily')
      .select('date, spend')
      .eq('project', client.id)
      .gte('date', w.from)
      .lte('date', w.to)
      .order('id')
      .range(at, at + 999)
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
    for (const r of (data ?? []) as { date: string; spend: number | string }[])
      byDay.set(r.date, (byDay.get(r.date) ?? 0) + (Number(r.spend) || 0))
    if (!data || data.length < 1000) break
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 }))
  const total = Math.round(days.reduce((s, d) => s + d.spend, 0) * 100) / 100
  return Response.json({
    ok: true,
    event_date: event,
    window: { from: w.from, to: w.to },
    ad_spend_total: total,
    currency: 'MYR',
    by_day: days,
    note: 'Meta spend for the whole ad account across the event window, synced each morning at 8am (yesterday complete).',
  })
}
