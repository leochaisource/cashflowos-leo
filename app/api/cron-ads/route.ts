import Anthropic from '@anthropic-ai/sdk'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'
import { flattenAds, normaliseAd, competitorSection, stripLoneSurrogates, type NormalisedAd, type PriorAd } from '@/lib/adyntel'
import { AD_CLIENTS, keywordsForToday, isConfigured, LIVE_PROMPT, PRE_LAUNCH_PROMPT, type AdClient } from '@/lib/ad-clients'

// The 8am ads brief, once per client. For each client in lib/ad-clients.ts:
//   ① Meta Marketing API — yesterday vs the trailing 7-day average, per campaign.
//   ② Adyntel — what competitors are running in that client's niche right now.
//   ③ Claude — turns both into what changed + 3 things to do about it.
// Then one Telegram message per client.
//
// ONE cron drives ALL clients: Vercel Hobby caps a project at 2 cron jobs and
// both slots are spoken for, so adding a client must never mean adding a schedule.
//
// AUTH FAILS CLOSED, exactly like cron-daily: this endpoint spends Anthropic +
// Adyntel credit, so with no CRON_SECRET set it returns 401 to everyone.
//
// Every external call is wrapped: if Meta is down you still get the competitor
// half, if Adyntel is down you still get your numbers, and one client blowing up
// never stops the others. A half report beats silence.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const GRAPH = 'https://graph.facebook.com/v23.0'

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = (cur: string, n: number) => cur + n.toLocaleString('en-MY', { maximumFractionDigits: 2 })

/** Where this client's brief goes: the team list if set, else its own chat id. */
function recipients(client: AdClient): string[] {
  const team = (process.env.TELEGRAM_TEAM_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s))
  const list = team.length
    ? team
    : ([process.env[client.chatIdEnv]?.trim()].filter(Boolean) as string[])
  return Array.from(new Set(list))
}

// ---------------------------------------------------------------- Meta
type Camp = { name: string; spend: number; impressions: number; leads: number; cpl: number }

/**
 * Meta reports conversions in an `actions` array, and which action_type carries
 * the lead depends on how the funnel is built — a native instant form reports
 * `lead`, a landing-page form firing the Pixel reports
 * `offsite_conversion.fb_pixel_lead`. Each client declares its own list; we take
 * the max rather than the sum because Meta often reports the same conversion
 * under several overlapping types and adding them double-counts.
 */
function leadsOf(actions: { action_type: string; value: string }[] | undefined, types: string[]): number {
  if (!Array.isArray(actions)) return 0
  const hits = actions.filter((a) => types.includes(a.action_type)).map((a) => Number(a.value) || 0)
  return hits.length ? Math.max(...hits) : 0
}

async function metaCampaigns(client: AdClient, datePreset: string): Promise<Camp[]> {
  const token = process.env[client.tokenEnv]?.trim()
  const acct = process.env[client.adAccountEnv]?.trim()
  if (!token || !acct) return []
  const url =
    `${GRAPH}/act_${acct}/insights?level=campaign&date_preset=${datePreset}` +
    `&fields=campaign_name,spend,impressions,actions&limit=200`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Meta ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { data?: Record<string, unknown>[] }
  return (json.data ?? []).map((d) => {
    const spend = Number(d.spend) || 0
    const leads = leadsOf(d.actions as { action_type: string; value: string }[], client.leadActionTypes)
    return {
      name: String(d.campaign_name ?? 'Unnamed'),
      spend,
      impressions: Number(d.impressions) || 0,
      leads,
      cpl: leads > 0 ? spend / leads : 0,
    }
  })
}

// ---------------------------------------------------------------- Adyntel
// Parsing lives in lib/adyntel.ts and is verified against a captured raw
// response (data/adyntel-raw-latest.json). It recursively flattens results,
// accepts both snake_case and camelCase, and keeps the whole ad — copy,
// headline, CTA, landing URL, every image and video URL, and the untouched
// payload. The previous version kept 6 truncated fields and binned the rest,
// which is why this brief could only ever report counts.
async function adyntelSearch(keyword: string, country: string): Promise<NormalisedAd[]> {
  const api_key = process.env.ADYNTEL_API_KEY?.trim()
  const email = process.env.ADYNTEL_EMAIL?.trim()
  if (!api_key || !email) return []
  const res = await fetch('https://api.adyntel.com/facebook_ad_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key, email, keyword, country_code: country }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Adyntel ${res.status} on "${keyword}" (${country})`)
  const json = await res.json()
  return flattenAds(json)
    .map((a) => normaliseAd(a))
    .filter((a) => a.ad_archive_id)
}

// ------------------------------------------------- competitor_ads (Supabase)
// One row per individual ad PER CLIENT, upserted on
// (client, competitor, ad_archive_id) so the same creative is updated rather
// than duplicated, and first_seen_at survives across runs.
async function loadPrior(clientId: string): Promise<PriorAd[]> {
  if (!supabaseConfigured) return []
  const { data, error } = await supabase
    .from('competitor_ads')
    .select('ad_archive_id, competitor, is_active, title, body_text')
    .eq('client', clientId)
  if (error) {
    console.error('[CFO] competitor_ads read failed:', error.message)
    return []
  }
  return (data ?? []) as PriorAd[]
}

async function saveAds(clientId: string, ads: NormalisedAd[], keyword: string): Promise<number> {
  if (!supabaseConfigured || !ads.length) return 0
  const iso = (u: number | null) => (u === null ? null : new Date(u * 1000).toISOString())
  const rows = ads.map((a) => ({
    client: clientId,
    competitor: a.page_name,
    page_id: a.page_id,
    ad_archive_id: a.ad_archive_id,
    last_seen_at: new Date().toISOString(),
    keywords: [keyword],
    meta_start_date: iso(a.start_date),
    meta_end_date: iso(a.end_date),
    is_active: a.is_active,
    run_days: a.run_days,
    run_days_basis: a.run_days_basis,
    body_text: a.body_text || null,
    body_html: a.body_html,
    title: a.title,
    caption: a.caption,
    link_description: a.link_description,
    cta_text: a.cta_text,
    cta_type: a.cta_type,
    link_url: a.link_url,
    display_format: a.display_format,
    publisher_platform: a.publisher_platform,
    collation_count: a.collation_count,
    image_urls: a.images.map((i) => i.original_image_url ?? i.resized_image_url).filter(Boolean),
    video_urls: a.videos.map((v) => v.video_hd_url ?? v.video_sd_url).filter(Boolean),
    thumbnail_urls: a.videos.map((v) => v.video_preview_image_url).filter(Boolean),
    raw_payload: a.raw_payload,
    updated_at: new Date().toISOString(),
  }))
  const { data, error } = await supabase
    .from('competitor_ads')
    .upsert(rows, { onConflict: 'client,competitor,ad_archive_id' })
    .select('id')
  if (error) {
    console.error('[CFO] competitor_ads upsert failed:', error.message)
    return 0
  }
  return data?.length ?? 0
}

// ------------------------------------------------------------- one client
async function runClient(client: AdClient) {
  const notes: string[] = []
  const cur = client.currency
  const money = (n: number) => fmt(cur, n)

  // ① Yesterday vs the trailing 7-day daily average.
  let yesterday: Camp[] = []
  let week: Camp[] = []
  let month: Camp[] = []
  try {
    ;[yesterday, week, month] = await Promise.all([
      metaCampaigns(client, 'yesterday'),
      metaCampaigns(client, 'last_7d'),
      metaCampaigns(client, 'last_30d'),
    ])
  } catch (e) {
    notes.push(`Meta unavailable: ${(e as Error).message}`)
  }

  const weekByName = new Map(week.map((c) => [c.name, c]))
  const movers = yesterday
    .filter((c) => c.spend > 0)
    .map((c) => {
      const w = weekByName.get(c.name)
      const avgCpl = w && w.leads > 0 ? w.spend / w.leads : 0
      const cplDelta = avgCpl > 0 && c.cpl > 0 ? Math.round(((c.cpl - avgCpl) / avgCpl) * 100) : 0
      return { ...c, avgCpl, cplDelta }
    })
    .sort((a, b) => b.spend - a.spend)

  let spent = movers.reduce((s, c) => s + c.spend, 0)
  let leads = movers.reduce((s, c) => s + c.leads, 0)

  // Nothing ran yesterday (paused account, or a gap between campaigns)? Reporting
  // "RM0, 0 leads" every morning is technically true and completely useless, so
  // fall back to the trailing week and SAY that's what you're looking at.
  let window = 'yesterday'
  if (spent === 0) {
    const fallback: [string, Camp[]][] = [
      ['last 7 days (nothing ran yesterday)', week],
      ['last 30 days (nothing ran this week)', month],
    ]
    for (const [label, rows] of fallback) {
      if (!rows.some((c) => c.spend > 0)) continue
      window = label
      movers.length = 0
      movers.push(
        ...rows
          .filter((c) => c.spend > 0)
          .map((c) => ({ ...c, avgCpl: c.cpl, cplDelta: 0 }))
          .sort((a, b) => b.spend - a.spend),
      )
      spent = movers.reduce((s, c) => s + c.spend, 0)
      leads = movers.reduce((s, c) => s + c.leads, 0)
      break
    }
    if (window === 'yesterday') {
      window = 'no delivery'
      notes.push('No Meta spend in the last 30 days — nothing has been delivering on this ad account.')
    }
  }

  // ② The market — individual ads, not a headcount.
  const prior = await loadPrior(client.id)
  const todaysKeywords = keywordsForToday(client)
  let competitors: NormalisedAd[] = []
  let stored = 0
  let credits = 0
  try {
    const jobs = todaysKeywords.flatMap((k) => client.countries.map((c) => [k, c] as const))
    const batches = await Promise.all(
      jobs.map(([k, c]) => adyntelSearch(k, c).then((ads) => [k, ads] as const)),
    )
    credits = jobs.length
    const byId = new Map<string, NormalisedAd>()
    for (const [keyword, ads] of batches) {
      for (const ad of ads) if (!byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
      stored += await saveAds(client.id, ads, keyword)
    }
    competitors = Array.from(byId.values())
  } catch (e) {
    notes.push(`Adyntel unavailable: ${(e as Error).message}`)
  }

  const market = competitorSection(competitors, prior, client.countries.join('+'), {}, client.relevanceTerms, client.excludeTerms)
  if (client.keywordsPerRun && client.keywordsPerRun < client.keywords.length)
    notes.push(
      `Watching ${todaysKeywords.length} of ${client.keywords.length} keywords today (rotating): ${todaysKeywords.join(', ')}`,
    )

  // ③ Turn it into advice.
  // An account that has never delivered is a different report, not a broken one:
  // there is nothing to optimise, so the whole brief becomes competitor
  // intelligence and what to BUILD from it.
  const preLaunch = window === 'no delivery'

  const factsRaw = [
    `CLIENT: ${client.name}`,
    client.briefContext ? `SITUATION: ${client.briefContext}` : '',
    preLaunch
      ? 'OWN PERFORMANCE: none. This account has no delivery in any window, so there are no numbers to analyse.'
      : `WINDOW = ${window.toUpperCase()}: spent ${money(spent)}, ${leads} leads across ${movers.length} campaigns.`,
    ...(preLaunch
      ? []
      : movers.slice(0, 8).map(
          (c) =>
            `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}` +
            (c.cplDelta ? ` (${c.cplDelta > 0 ? '+' : ''}${c.cplDelta}% vs 7-day avg ${money(c.avgCpl)})` : ''),
        )),
    '',
    market.text,
  ]
    .filter((l) => l !== '')
    .join('\n')
  // Belt and braces: one lone surrogate anywhere in this block 400s the model
  // call and costs the whole briefing, so sanitise the finished string too.
  const facts = stripLoneSurrogates(factsRaw)

  let report = ''
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (key) {
    try {
      const anthropic = new Anthropic({ apiKey: key })
      const res = await anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 3000,
        system: preLaunch ? PRE_LAUNCH_PROMPT(client.name) : LIVE_PROMPT(client.name),
        messages: [{ role: 'user', content: facts }],
      })
      report = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
    } catch (e) {
      notes.push(`Claude unavailable: ${(e as Error).message}`)
    }
  }

  const header =
    `📊 <b>${esc(client.name)}</b> — ${window}: ${money(spent)} spent · ${leads} leads` +
    (movers.length ? ` · ${movers.length} live campaigns` : '')
  const text = [
    header,
    '',
    report ? esc(report) : esc(facts),
    notes.length ? '\n⚠️ ' + notes.map(esc).join('\n⚠️ ') : '',
  ]
    .filter(Boolean)
    .join('\n')

  // Telegram rejects anything over 4096 characters outright — the whole brief
  // would vanish with only a server-side log. Split on blank lines so a long
  // report arrives as two readable messages instead of none.
  const chunks: string[] = []
  for (const para of text.split('\n\n')) {
    const last = chunks[chunks.length - 1]
    if (last !== undefined && last.length + para.length + 2 < 3900) chunks[chunks.length - 1] = last + '\n\n' + para
    else chunks.push(para)
  }
  const to = recipients(client)
  for (const chat of to) for (const chunk of chunks) await sendMessage(chat, chunk)

  return {
    client: client.id,
    sent: to.length,
    messages: chunks.length,
    window,
    spend: spent,
    leads,
    campaigns: movers.length,
    keywords_today: todaysKeywords,
    adyntel_credits: credits,
    competitor_ads_stored: stored,
    ...market.stats,
    notes,
  }
}

// ---------------------------------------------------------------- the route
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  const authed = !!secret && req.headers.get('authorization') === `Bearer ${secret}`
  if (!authed) return new Response('forbidden', { status: 401 })

  // ?client=<id> runs just one, for testing without spending every client's credit.
  const only = new URL(req.url).searchParams.get('client')
  const queue = AD_CLIENTS.filter((c) => (only ? c.id === only : true))

  const results: unknown[] = []
  const skipped: string[] = []
  // Sequential on purpose: each client is several Adyntel calls plus a model
  // call, and running them all at once risks rate limits and a 300s timeout.
  for (const client of queue) {
    if (!isConfigured(client)) {
      skipped.push(`${client.id} (missing ${client.adAccountEnv} or ${client.tokenEnv})`)
      continue
    }
    try {
      results.push(await runClient(client))
    } catch (e) {
      // One client failing must never take the others down with it.
      console.error(`[CFO] client ${client.id} failed:`, e)
      results.push({ client: client.id, ok: false, error: (e as Error).message })
    }
  }

  return Response.json({ ok: true, clients: results.length, skipped, results })
}
