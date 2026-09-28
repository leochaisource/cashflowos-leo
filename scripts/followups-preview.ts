// Print the client group's "on track / who to chase" additions and the owner's
// private follow-up list, from live GHL data — nothing sent to Telegram.
//
//   node --env-file-if-exists=.env scripts/followups-preview.ts
//   ... --date=2026-09-27   the report day (default: yesterday, KL)
//   ... --ai                judge buying intent with the model (a few cents)
//   ... --send              also send the private full list to OWNER_CHAT_ID (never a group)
//
// Uses lib/followups.ts and lib/deal-estimate.ts buildPace — the code the cron runs.
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { dayBounds, saleRows, perfWindow, ghlPerformance, renderPerformance } from '../lib/ghl.ts'
import { eventFor } from '../lib/deal.ts'
import { buildPace } from '../lib/deal-estimate.ts'
import { buildFollowups, renderGroupFollowups, renderPrivateFollowups } from '../lib/followups.ts'
import { sendMessage } from '../lib/telegram.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const client = AD_CLIENTS.find((c) => c.deal && c.ghl)
if (!client?.deal || !client.ghl) throw new Error('no client with a deal and GHL')
const g = client.ghl
const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
const token = process.env[g.tokenEnv]!.trim()
const loc = process.env[g.locationEnv]!.trim()
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const day = arg('date') ?? new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: tz })
const { start, end } = dayBounds(day, tz)
const today = new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)
const w = eventFor(client.deal, today)!

const t0 = Date.now()
const sales = await saleRows(loc, token, dayBounds(perfWindow(client, day).salesSince, tz).start, end, g.excludeOrderSources ?? [], g.includeOrderSources ?? [])
const pace = await buildPace(db, client.id, client.deal, day, sales)
const f = await buildFollowups({
  locationId: loc,
  token,
  day,
  dayStartISO: start,
  dayEndISO: end,
  salesSinceISO: dayBounds(w.from, tz).start,
  includeSources: g.includeOrderSources ?? [],
  product: followupProduct(),
  anthropic: process.argv.includes('--ai') ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() }) : null,
})

function followupProduct() {
  return (
    `${client!.client ?? client!.name} one-day Claude AI workshop ("Claude Dashboard Beginner") on ` +
    `${w.to}, tickets RM${client!.deal!.ticketPrices.general} General / RM${client!.deal!.ticketPrices.vip} VIP`
  )
}

console.log(`\n=== GROUP MESSAGE (report day ${day}) — follow-ups built in ${Math.round((Date.now() - t0) / 1000)}s ===\n`)
// The whole performance block, exactly as the cron renders it for the group.
const since = perfWindow(client, day).spendSince
const adRows: { date: string; campaign_name: string | null; spend: number }[] = []
for (let at = 0; ; at += 1000) {
  const { data } = await db.from('ad_daily').select('date, campaign_name, spend').eq('project', client.id).gte('date', since).order('id').range(at, at + 999)
  adRows.push(...((data ?? []) as typeof adRows))
  if (!data || data.length < 1000) break
}
const spendByCampaign = (campaign: string, from: string, to: string) =>
  adRows.filter((r) => r.date >= from && r.date <= to && (campaign === '*' || r.campaign_name === campaign)).reduce((s, r) => s + Number(r.spend), 0)
const perf = await ghlPerformance(client, day, spendByCampaign)
if (perf) {
  perf.pace = pace
  const leads = f.chats.filter((c) => c.intent !== 'not_a_lead')
  perf.followups = { text: renderGroupFollowups(f), unpaid: f.unpaid.length, chats: leads.length, hot: 0, warm: 0 }
  const text = renderPerformance(perf)
  console.log(text)
  console.log(`\n(${text.length} chars)`)
}
const priv = renderPrivateFollowups(f, loc, client.client ?? client.name)
console.log(`\n=== PRIVATE (to Leo) — ${priv.length} chars ===\n`)
console.log(priv)

// --send: deliver the private list to the owner's chat now (never a group).
if (process.argv.includes('--send')) {
  const owner = process.env.OWNER_CHAT_ID?.trim()
  if (!owner) throw new Error('OWNER_CHAT_ID is not set')
  // Whole lines only, under Telegram's 4096 limit — every line is self-contained HTML.
  const parts: string[] = []
  let buf = ''
  for (const line of priv.split('\n')) {
    if (buf && buf.length + line.length + 1 > 3800) {
      parts.push(buf)
      buf = ''
    }
    buf = buf ? `${buf}\n${line}` : line
  }
  if (buf) parts.push(buf)
  for (const [i, part] of parts.entries()) {
    const r = await sendMessage(owner, part, { noPreview: true })
    console.log(`sent part ${i + 1}/${parts.length}: ${r.ok ? 'ok' : `FAILED — ${r.error}`}`)
    if (!r.ok) break
  }
}
