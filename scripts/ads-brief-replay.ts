// Replays a client's 8am brief from ALREADY-STORED data and sends it to Telegram.
// Makes NO Adyntel call — competitor ads are rebuilt from competitor_ads.raw_payload,
// which is exactly why raw_payload is kept. Meta is read live (free) and Claude
// writes it up, using the SAME prompts the cron uses.
//
//   node scripts/ads-brief-replay.ts --client=claude-malaysia          (dry run)
//   node scripts/ads-brief-replay.ts --client=claude-malaysia --send
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { normaliseAd, competitorSection, stripLoneSurrogates, type NormalisedAd } from '../lib/adyntel.ts'
import { AD_CLIENTS, LIVE_PROMPT, PRE_LAUNCH_PROMPT } from '../lib/ad-clients.ts'
import { leadsSummary } from '../lib/leads-sheet.ts'
import { delivery, perDay } from '../lib/delivery.ts'

const SEND = process.argv.includes('--send')
const ID = process.argv.find((a) => a.startsWith('--client='))?.split('=')[1] ?? 'dianna-nlp'
const client = AD_CLIENTS.find((c) => c.id === ID)
if (!client) { console.error(`unknown client "${ID}" — known: ${AD_CLIENTS.map((c) => c.id).join(', ')}`); process.exit(1) }

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const money = (n: number) => client.currency + n.toLocaleString('en-MY', { maximumFractionDigits: 2 })
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- competitors: straight out of Supabase, no API call -------------------
const { data: rows, error } = await s.from('competitor_ads').select('raw_payload').eq('client', client.id)
if (error) { console.error(error.message); process.exit(1) }
const ads: NormalisedAd[] = (rows ?? [])
  .map((r) => normaliseAd(r.raw_payload as Record<string, unknown>))
  .filter((a) => a.ad_archive_id)
console.log(`${client.id}: rebuilt ${ads.length} competitor ads from Supabase (0 Adyntel calls)`)

// ---- Meta: live, free ------------------------------------------------------
type Camp = { name: string; spend: number; leads: number; cpl: number }
async function meta(preset: string): Promise<Camp[]> {
  const acct = env[client!.adAccountEnv], token = env[client!.tokenEnv]
  if (!acct || !token) return []
  const url = `https://graph.facebook.com/v23.0/act_${acct}/insights` +
    `?level=campaign&date_preset=${preset}&fields=campaign_name,spend,actions&limit=200`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return []
  const j = (await res.json()) as { data?: Record<string, unknown>[] }
  return (j.data ?? []).map((d) => {
    const spend = Number(d.spend) || 0
    const acts = (d.actions ?? []) as { action_type: string; value: string }[]
    const hits = acts.filter((a) => client!.leadActionTypes.includes(a.action_type)).map((a) => Number(a.value) || 0)
    const leads = hits.length ? Math.max(...hits) : 0
    return { name: String(d.campaign_name ?? 'Unnamed'), spend, leads, cpl: leads ? spend / leads : 0 }
  })
}
/** A demo client has no ad account — its performance lives in ad_daily. */
async function demoMeta(): Promise<Camp[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const { data } = await s.from('ad_daily').select('campaign_name, spend, leads').eq('project', client!.id).gte('date', since)
  const by = new Map<string, Camp>()
  for (const r of data ?? []) {
    const name = (r.campaign_name as string) || 'Unnamed'
    const c = by.get(name) ?? { name, spend: 0, leads: 0, cpl: 0 }
    c.spend += Number(r.spend) || 0
    c.leads += Number(r.leads) || 0
    by.set(name, c)
  }
  return [...by.values()].map((c) => ({ ...c, cpl: c.leads ? c.spend / c.leads : 0 }))
}

const month = (client.demo ? await demoMeta() : await meta('last_30d'))
  .filter((c) => c.spend > 0)
  .sort((a, b) => b.spend - a.spend)
const spend = month.reduce((n, c) => n + c.spend, 0)
const leads = month.reduce((n, c) => n + c.leads, 0)
const preLaunch = spend === 0
const window = preLaunch ? 'no delivery' : 'last 30 days'
console.log(`Meta: ${money(spend)} across ${month.length} campaign(s), ${leads} leads → ${preLaunch ? 'PRE-LAUNCH' : 'LIVE'} brief`)

// ---- the client's own leads (live read of the master sheet, free) ----------
// Demo clients have no sheet; their funnel lives in project_funnel, which the
// cron reads through lib/demo.ts. Replays of those clients show the ads and the
// market, and skip the leads block rather than invent one.
const sheet = client.demo ? null : await leadsSummary(client)

/** Demo clients have no sheet: their funnel lives in project_funnel, exactly as
 *  lib/demo.ts reads it for the real cron. Without this the replay looks like a
 *  client with no lead tracking at all, and the model says so at length. */
async function demoLeads(): Promise<string[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const { data } = await s.from('project_funnel').select('*').eq('project', client!.id).gte('date', since)
  if (!data?.length) return []
  const sum = (k: string) => {
    const v = data.map((r) => r[k]).filter((x): x is number => typeof x === 'number')
    return v.length ? v.reduce((a, b) => a + b, 0) : null
  }
  const optIns = sum('leads'), attended = sum('attended'), appts = sum('appointments')
  const signups = sum('signups'), cash = sum('cash_collected')
  const pct = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? `${Math.round((a / b) * 100)}%` : 'not tracked')
  return [
    '',
    `LEADS (${client!.sources?.leads ?? 'client system'} — 30-day window):`,
    `- opt-ins: ${optIns ?? 'not tracked'} · attended: ${attended ?? 'not tracked'} (show-up ${pct(attended, optIns)})`,
    `- appointments booked: ${appts ?? 'not tracked'} · sign-ups: ${signups ?? 'not tracked'} · collected: ${cash === null ? 'not tracked' : money(cash)}`,
    signups !== null && attended !== null ? `- attendee → sign-up: ${pct(signups, attended)}` : '',
  ].filter((l) => l !== '')
}
if (sheet && !sheet.ok) console.log('sheet unreadable:', sheet.error)
if (sheet?.ok) console.log(`sheet: ${sheet.total} opt-ins · ${sheet.yesterday} yesterday · ${sheet.signups} paid · ${sheet.followUps.length} to chase`)

// Mirrors the LEADS block in app/api/cron-ads/route.ts so a replay reads like
// the real thing.
const leadsBlock = client.demo
  ? await demoLeads()
  : sheet?.ok
  ? [
      '',
      'LEADS (from the client master sheet — this is the truth about opt-ins and payments):',
      `- yesterday: ${sheet.yesterday} new opt-in(s) · today so far: ${sheet.today} · last 7 days: ${sheet.last7} · ${sheet.total} tracked in total`,
      `- paid: ${sheet.signups} of ${sheet.total} (${money(sheet.revenue)} collected)`,
      sheet.attended !== null
        ? `- attended the webinar: ${sheet.attended}`
        : '- attendance: the sheet has no "Attended" column yet, so show-up rate is unknown (do not guess it)',
      sheet.byAd.length
        ? '- opt-ins by ad: ' + sheet.byAd.slice(0, 6).map((a) => `${a.ad} ${a.leads}${a.paid ? ` (${a.paid} paid)` : ''}`).join(' · ')
        : '',
      sheet.recentPayers.length
        ? '- most recent payments: ' + sheet.recentPayers.slice(0, 5).map((p) => `${p.name} ${money(p.amount ?? 0)} on ${p.date}`).join(' · ')
        : '- no payments recorded yet',
      sheet.followUps.length
        ? `- ${sheet.followUps.length} lead(s) have no payment and no next action. The coldest: ` +
          sheet.followUps.slice(0, 6).map((f) => `${f.name} (${f.phone || 'no phone'}, ${f.days}d, via ${f.ad || 'unknown ad'})`).join(' · ')
        : '- every lead has either paid or has a next action against it',
    ].filter((l) => l !== '')
  : []

// ---- delivery: yesterday vs the trailing 3 days, from ad_daily -------------
// Uses the SAME delivery() the dashboard and the cron use (lib/delivery.ts is
// free of `server-only` precisely so this script can import it), so a replay
// can't quietly disagree with the real brief.
async function deliveryBlockFor(): Promise<string[]> {
  const day = (o: number) => { const d = new Date(); d.setDate(d.getDate() - o); return d.toISOString().slice(0, 10) }
  const { data } = await s
    .from('ad_daily')
    .select('date, spend, impressions, clicks, link_clicks, leads')
    .eq('project', client!.id)
    .gte('date', day(3))
    .lte('date', day(1))
  if (!data?.length) return []
  const rows = data as any[]
  const y = delivery(rows.filter((r) => r.date === day(1)))
  const l3 = delivery(rows)
  const activeDays = new Set(rows.filter((r) => Number(r.spend) > 0).map((r) => r.date)).size || 1
  const avg = perDay(l3, activeDays)
  const pctS = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(2)}%`)
  const line = (label: string, d: typeof y) =>
    `- ${label}: ${money(d.spend)} · ${Math.round(d.impressions).toLocaleString('en-MY')} impressions · ` +
    `CPM ${d.cpm === null ? 'n/a' : money(d.cpm)} · CTR ${pctS(d.ctr)} (link ${pctS(d.linkCtr)}) · ` +
    `${Math.round(d.clicks)} clicks (${Math.round(d.linkClicks)} link) · CPC ${d.cpc === null ? 'n/a' : money(d.cpc)} · ` +
    `${Math.round(d.leads)} leads · CPL ${d.cpl === null ? 'n/a' : money(d.cpl)}`
  const delta = (now: number | null, base: number | null) =>
    now === null || base === null || base === 0 ? '' : ` (${now >= base ? '+' : ''}${Math.round(((now - base) / base) * 100)}% vs 3-day)`
  return [
    '',
    'DELIVERY (from the stored daily snapshot):',
    line('YESTERDAY', y),
    line('LAST 3 DAYS, PER DAY', avg),
    `- yesterday vs the 3-day average: CPM${delta(y.cpm, avg.cpm)}, link CTR${delta(y.linkCtr, avg.linkCtr)}, CPL${delta(y.cpl, avg.cpl)}`,
    '- for CPM, CPC and CPL a NEGATIVE change is an improvement; for CTR and leads a positive change is.',
  ]
}
const deliveryBlock = await deliveryBlockFor()

// ---- the owner's next steps for this client (mirrors cron-ads) -------------
const { data: taskRows } = await s
  .from('records')
  .select('title, due_date, status')
  .eq('category', 'task')
  .eq('meta->>project', client.id)
const todayStr = new Date().toISOString().slice(0, 10)
const openSteps = (taskRows ?? []).filter((t) => !['done', 'completed', 'closed', 'reversed'].includes((t.status || '').toLowerCase()))
const stepsBlock = openSteps.length
  ? [
      '',
      "OWNER'S NEXT STEPS for this client (their own to-do list, with deadlines — fold the urgent ones into the 3 actions; never invent a deadline that isn't here):",
      ...openSteps
        .slice(0, 6)
        .map((t) => `- ${t.title}${t.due_date ? ` (due ${t.due_date}${t.due_date < todayStr ? ' — OVERDUE' : ''})` : ' (no deadline set)'}`),
    ]
  : []

// ---- build + write ---------------------------------------------------------
const market = competitorSection(ads, [], client.countries.join('+'), {}, client.relevanceTerms, client.excludeTerms)
const facts = stripLoneSurrogates([
  `CLIENT: ${client.name}`,
  client.briefContext ? `SITUATION: ${client.briefContext}` : '',
  preLaunch
    ? 'OWN PERFORMANCE: none. This account has no delivery in any window, so there are no numbers to analyse.'
    : `WINDOW = LAST 30 DAYS: spent ${money(spend)}, ${leads} leads across ${month.length} campaigns.`,
  ...(preLaunch ? [] : month.slice(0, 8).map((c) => `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}`)),
  ...deliveryBlock,
  ...leadsBlock,
  ...stepsBlock,
  '',
  market.text,
].filter((l) => l !== '').join('\n'))

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const res = await anthropic.messages.create({
  model: 'claude-opus-5',
  max_tokens: 3000,
  system: preLaunch ? PRE_LAUNCH_PROMPT(client.name) : LIVE_PROMPT(client.name),
  messages: [{ role: 'user', content: facts }],
})
const report = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()

const header =
  `📊 <b>${esc(client.name)}</b> — ${window}` +
  (preLaunch ? '' : `: ${money(spend)} spent · ${leads} leads · ${month.length} live campaigns`) +
  `\n<i>Replay of the ${new Date().toISOString().slice(0, 10)} fetch — ${ads.length} stored ads, no new Adyntel call.</i>`
const text = `${header}\n\n${esc(report)}`

console.log('\n─── message (%d chars) ───\n', text.length)
console.log(text)

if (!SEND) { console.log('\n(dry run — pass --send)'); process.exit(0) }

// Telegram caps a message at 4096 chars; split on blank lines so nothing is lost.
const chunks: string[] = []
for (const para of text.split('\n\n')) {
  if (chunks.length && (chunks.at(-1)!.length + para.length + 2) < 3900) chunks[chunks.length - 1] += '\n\n' + para
  else chunks.push(para)
}
for (const chunk of chunks) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env[client.chatIdEnv], text: chunk, parse_mode: 'HTML' }),
  })
  const b = await r.json()
  console.log(r.ok && b.ok ? `sent ${chunk.length} chars ✓` : `FAILED: ${b.description}`)
}
