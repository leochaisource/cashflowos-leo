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
const month = (await meta('last_30d')).filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend)
const spend = month.reduce((n, c) => n + c.spend, 0)
const leads = month.reduce((n, c) => n + c.leads, 0)
const preLaunch = spend === 0
const window = preLaunch ? 'no delivery' : 'last 30 days'
console.log(`Meta: ${money(spend)} across ${month.length} campaign(s), ${leads} leads → ${preLaunch ? 'PRE-LAUNCH' : 'LIVE'} brief`)

// ---- the client's own leads (live read of the master sheet, free) ----------
const sheet = await leadsSummary(client)
if (sheet && !sheet.ok) console.log('sheet unreadable:', sheet.error)
if (sheet?.ok) console.log(`sheet: ${sheet.total} opt-ins · ${sheet.yesterday} yesterday · ${sheet.signups} paid · ${sheet.followUps.length} to chase`)

// Mirrors the LEADS block in app/api/cron-ads/route.ts so a replay reads like
// the real thing.
const leadsBlock = sheet?.ok
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

// ---- build + write ---------------------------------------------------------
const market = competitorSection(ads, [], client.countries.join('+'), {}, client.relevanceTerms, client.excludeTerms)
const facts = stripLoneSurrogates([
  `CLIENT: ${client.name}`,
  client.briefContext ? `SITUATION: ${client.briefContext}` : '',
  preLaunch
    ? 'OWN PERFORMANCE: none. This account has no delivery in any window, so there are no numbers to analyse.'
    : `WINDOW = LAST 30 DAYS: spent ${money(spend)}, ${leads} leads across ${month.length} campaigns.`,
  ...(preLaunch ? [] : month.slice(0, 8).map((c) => `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}`)),
  ...leadsBlock,
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
