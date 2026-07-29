// Replays the 8am brief from ALREADY-STORED data and sends it to Telegram.
// Makes NO Adyntel call — competitor ads are rebuilt from competitor_ads.raw_payload,
// which is exactly why raw_payload is kept. Meta is read live (free) and Claude
// writes it up. Run: node scripts/ads-brief-replay.ts [--send]
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { normaliseAd, competitorSection, stripLoneSurrogates, type NormalisedAd } from '../lib/adyntel.ts'

const SEND = process.argv.includes('--send')
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const money = (n: number) => 'RM' + n.toLocaleString('en-MY', { maximumFractionDigits: 2 })
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- competitors: straight out of Supabase, no API call -------------------
const { data: rows, error } = await s.from('competitor_ads').select('raw_payload, ad_archive_id')
if (error) { console.error(error.message); process.exit(1) }
const ads: NormalisedAd[] = (rows ?? [])
  .map((r) => normaliseAd(r.raw_payload as Record<string, unknown>))
  .filter((a) => a.ad_archive_id)
console.log(`rebuilt ${ads.length} competitor ads from Supabase (0 Adyntel calls)`)

// ---- Meta: live, free ------------------------------------------------------
type Camp = { name: string; spend: number; leads: number; cpl: number }
async function meta(preset: string): Promise<Camp[]> {
  const url = `https://graph.facebook.com/v23.0/act_${env.META_AD_ACCOUNT_ID}/insights` +
    `?level=campaign&date_preset=${preset}&fields=campaign_name,spend,actions&limit=200`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` } })
  if (!res.ok) return []
  const j = (await res.json()) as { data?: Record<string, unknown>[] }
  return (j.data ?? []).map((d) => {
    const spend = Number(d.spend) || 0
    const acts = (d.actions ?? []) as { action_type: string; value: string }[]
    const hits = acts.filter((a) => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped').map((a) => Number(a.value) || 0)
    const leads = hits.length ? Math.max(...hits) : 0
    return { name: String(d.campaign_name ?? 'Unnamed'), spend, leads, cpl: leads ? spend / leads : 0 }
  })
}
const month = (await meta('last_30d')).filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend)
const spend = month.reduce((n, c) => n + c.spend, 0)
const leads = month.reduce((n, c) => n + c.leads, 0)
const window = 'last 30 days (nothing ran this week)'
console.log(`Meta: ${money(spend)} across ${month.length} campaign(s), ${leads} leads`)

// ---- build + write ---------------------------------------------------------
const market = competitorSection(ads, [], 'MY')
const facts = stripLoneSurrogates([
  `WINDOW = ${window.toUpperCase()}: spent ${money(spend)}, ${leads} leads across ${month.length} campaigns.`,
  ...month.slice(0, 8).map((c) => `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}`),
  '',
  market.text,
].join('\n'))

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const res = await anthropic.messages.create({
  model: 'claude-opus-5',
  max_tokens: 2000,
  system:
    'You write an 8am ads briefing for a busy Malaysian coaching business owner. ' +
    'Be concrete and short. No preamble, no markdown headers, no bullet symbols other than "-". ' +
    'Structure: one line on what changed in the numbers; then three to five lines on specific competitor ads - ' +
    'name the advertiser, quote the actual hook or headline, and say the format and how long it has run; ' +
    'then exactly 3 numbered actions, each one sentence and specific enough to do today. ' +
    'Prefer naming a real ad over generalising about "competitors". ' +
    'CRITICAL - how to talk about run length: a long-running ad, repeated variations of one concept, and ' +
    'continued activity are PUBLIC signals only. You have no conversion data for any competitor. ' +
    'Never write that an ad converts, works, is profitable, or is proven. ' +
    'Say instead: "may be strategically important based on observable public signals, but private conversion ' +
    'performance is unavailable." ' +
    'Never invent numbers that are not in the data. If data is missing, say which part is missing.',
  messages: [{ role: 'user', content: facts }],
})
const report = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()

const header =
  `📊 <b>Ads brief</b> — ${window}: ${money(spend)} spent · ${leads} leads · ${month.length} live campaigns\n` +
  `<i>Test replay of the ${new Date().toISOString().slice(0, 10)} fetch — rebuilt from ${ads.length} stored ads, no new Adyntel call.</i>`
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
    body: JSON.stringify({ chat_id: env.OWNER_CHAT_ID, text: chunk, parse_mode: 'HTML' }),
  })
  const b = await r.json()
  console.log(r.ok && b.ok ? `sent ${chunk.length} chars ✓` : `FAILED: ${b.description}`)
}
