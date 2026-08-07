import Anthropic from '@anthropic-ai/sdk'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'
import { flattenAds, normaliseAd, competitorSection, stripLoneSurrogates, mediaUrls, type NormalisedAd, type PriorAd } from '@/lib/adyntel'
import { AD_CLIENTS, keywordsForToday, isConfigured, LIVE_PROMPT, PRE_LAUNCH_PROMPT, type AdClient } from '@/lib/ad-clients'
import { campaignInsights, type Camp } from '@/lib/meta'
import { leadsSummary } from '@/lib/leads-sheet'
import { syncProjectAds } from '@/lib/ad-sync'

// The 8am ads brief, once per client. For each client in lib/ad-clients.ts:
//   ① Meta Marketing API — yesterday vs the trailing 7-day average, per campaign.
//   ② Adyntel — what competitors are running in that client's niche right now.
//   ③ Claude — turns both into what changed + 3 things to do about it.
//   ④ ad_daily — the same Meta pull, stored per ad per day, so the dashboard is
//      already fresh when you open it. The brief used to fetch this, use it once
//      and throw it away.
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

// ---------------------------------------------------------------- Adyntel
// Parsing lives in lib/adyntel.ts and is verified against a captured raw
// response (data/adyntel-raw-latest.json). It recursively flattens results,
// accepts both snake_case and camelCase, and keeps the whole ad — copy,
// headline, CTA, landing URL, every image and video URL, and the untouched
// payload. The previous version kept 6 truncated fields and binned the rest,
// which is why this brief could only ever report counts.
/** Thrown when the account is out of credits, so one 402 stops the whole run. */
class OutOfCredits extends Error {}

type SearchResult = { ads: NormalisedAd[]; calls: number; complete: boolean; echo: Record<string, unknown> }

/**
 * One keyword × country, paginated.
 *
 * Adyntel returns ~30 ads and a `continuation_token`; passing the token back
 * fetches the next slice until `is_result_complete` is true. We used to read
 * page one and stop — which is why a broad keyword's results churned between
 * runs and the brief kept reporting ads as "no longer appearing" when they had
 * simply fallen off an unseen page.
 *
 * EVERY PAGE COSTS A CREDIT, so this is capped rather than exhaustive: pages
 * are the one thing here that can quietly multiply the bill. `maxPages` is the
 * dial, per client, and the caller is told when it stopped early so the brief
 * can say it was looking at a slice.
 */
async function adyntelSearch(
  keyword: string,
  country: string,
  maxPages = 1,
  extra: Record<string, unknown> = {},
): Promise<SearchResult> {
  const api_key = process.env.ADYNTEL_API_KEY?.trim()
  const email = process.env.ADYNTEL_EMAIL?.trim()
  if (!api_key || !email) return { ads: [], calls: 0, complete: false, echo: {} }

  const byId = new Map<string, NormalisedAd>()
  let token: string | null = null
  let calls = 0
  let complete = false
  let echo: Record<string, unknown> = {}

  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const res = await fetch('https://api.adyntel.com/facebook_ad_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key,
        email,
        keyword,
        country_code: country,
        ...extra,
        ...(token ? { continuation_token: token } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    })
    // 402 = "Insufficient tokens. Please top-up". Every remaining call would
    // fail the same way and each one is a wasted round trip, so stop the run.
    if (res.status === 402) throw new OutOfCredits('Adyntel is out of credits — top up at app.adyntel.com')
    if (!res.ok) throw new Error(`Adyntel ${res.status} on "${keyword}" (${country})`)
    calls++

    const json = (await res.json()) as {
      continuation_token?: string | null
      is_result_complete?: boolean
      [k: string]: unknown
    }
    // The API echoes back the filters it applied. Keeping the echo is how we
    // find out whether an undocumented parameter was honoured or ignored.
    if (page === 0)
      echo = {
        active_status: json.active_status,
        media_types: json.media_types,
        platform: json.platform,
        search_type: json.search_type,
        start_min_date: json.start_min_date,
      }

    for (const raw of flattenAds(json)) {
      const ad = normaliseAd(raw)
      if (ad.ad_archive_id && !byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
    }

    complete = json.is_result_complete === true
    token = json.continuation_token ?? null
    if (complete || !token) break
  }

  return { ads: Array.from(byId.values()), calls, complete, echo }
}

// ------------------------------------------------- competitor_ads (Supabase)
// One row per individual ad PER CLIENT, upserted on
// (client, competitor, ad_archive_id) so the same creative is updated rather
// than duplicated, and first_seen_at survives across runs.
type PriorRow = PriorAd & { keywords: string[] | null }

async function loadPrior(clientId: string): Promise<PriorRow[]> {
  if (!supabaseConfigured) return []
  const { data, error } = await supabase
    .from('competitor_ads')
    .select('ad_archive_id, competitor, is_active, title, body_text, keywords')
    .eq('client', clientId)
  if (error) {
    console.error('[CFO] competitor_ads read failed:', error.message)
    return []
  }
  return (data ?? []) as PriorRow[]
}

/**
 * One upsert for the whole run, with keywords UNIONED.
 *
 * This used to run once per keyword with `keywords: [keyword]`, so the last
 * write won and the column ended up recording exactly one keyword per ad — the
 * database claimed not a single ad had ever matched two of eleven overlapping
 * AI terms, which cannot be true. An ad that shows up under three searches is a
 * more central competitor than one that shows up under a single obscure term,
 * and that ranking signal was being overwritten every morning.
 */
async function saveAds(
  clientId: string,
  ads: NormalisedAd[],
  keywordsByAd: Map<string, Set<string>>,
  prior: PriorRow[],
): Promise<{ stored: number; note?: string }> {
  if (!supabaseConfigured || !ads.length) return { stored: 0 }
  const priorKeywords = new Map(prior.map((p) => [p.ad_archive_id, p.keywords ?? []]))
  const iso = (u: number | null) => (u === null ? null : new Date(u * 1000).toISOString())
  const rows = ads.map((a) => {
    const media = mediaUrls(a) // reads cards[] too — carousels used to save with no media at all
    const keywords = new Set([
      ...(priorKeywords.get(a.ad_archive_id) ?? []),
      ...(keywordsByAd.get(a.ad_archive_id) ?? []),
    ])
    return {
    client: clientId,
    competitor: a.page_name,
    page_id: a.page_id,
    ad_archive_id: a.ad_archive_id,
    last_seen_at: new Date().toISOString(),
    keywords: Array.from(keywords),
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
    image_urls: media.images,
    video_urls: media.videos,
    thumbnail_urls: media.thumbs,
    page_like_count: a.page_like_count,
    page_categories: a.page_categories,
    page_profile_uri: a.page_profile_uri,
    raw_payload: a.raw_payload,
    updated_at: new Date().toISOString(),
    }
  })
  const write = (payload: Record<string, unknown>[]) =>
    supabase.from('competitor_ads').upsert(payload, { onConflict: 'client,competitor,ad_archive_id' }).select('id')

  const { data, error } = await write(rows)
  if (!error) return { stored: data?.length ?? 0 }

  // The three advertiser-context columns are added by
  // supabase/competitor-ads-enrich.sql. If that hasn't been run, PostgREST
  // rejects the WHOLE batch over one unknown column — and a missing follower
  // count is not worth losing a day of competitor tracking for. Drop them and
  // write everything else, then say so out loud.
  const missingColumn = /page_like_count|page_categories|page_profile_uri|schema cache/i.test(error.message)
  if (!missingColumn) {
    console.error('[CFO] competitor_ads upsert failed:', error.message)
    return { stored: 0, note: `Competitor ads not stored: ${error.message}` }
  }
  const trimmed = rows.map(({ page_like_count, page_categories, page_profile_uri, ...rest }) => rest)
  const retry = await write(trimmed)
  if (retry.error) {
    console.error('[CFO] competitor_ads upsert failed:', retry.error.message)
    return { stored: 0, note: `Competitor ads not stored: ${retry.error.message}` }
  }
  return {
    stored: retry.data?.length ?? 0,
    note: 'Stored without advertiser follower count/category — run supabase/competitor-ads-enrich.sql once to enable them.',
  }
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
      campaignInsights(client, 'yesterday'),
      campaignInsights(client, 'last_7d'),
      campaignInsights(client, 'last_30d'),
    ])
  } catch (e) {
    notes.push(`Meta unavailable: ${(e as Error).message}`)
  }

  // ①b Fill the dashboard from the same Meta account, per ad per day. Re-pulls
  // the trailing week because Meta keeps restating attributed conversions for
  // days already past. Failure here must never cost you the briefing.
  let synced: Awaited<ReturnType<typeof syncProjectAds>> | null = null
  try {
    synced = await syncProjectAds(client, 7)
  } catch (e) {
    notes.push(`Dashboard sync failed: ${(e as Error).message}`)
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
  let partial: string[] = []
  let echo: Record<string, unknown> = {}
  try {
    const jobs = todaysKeywords.flatMap((k) => client.countries.map((c) => [k, c] as const))
    const maxPages = client.adyntelMaxPages ?? 1
    const batches = await Promise.all(
      jobs.map(([k, c]) =>
        adyntelSearch(k, c, maxPages, client.adyntelParams ?? {}).then((r) => [k, c, r] as const),
      ),
    )

    // Collect once, keyed by ad, remembering EVERY keyword that surfaced it —
    // then a single upsert per run instead of one per keyword.
    const byId = new Map<string, NormalisedAd>()
    const keywordsByAd = new Map<string, Set<string>>()
    for (const [keyword, country, r] of batches) {
      credits += r.calls // pages, not searches: each page is a credit
      if (!r.complete) partial.push(`${keyword} (${country})`)
      if (!Object.keys(echo).length) echo = r.echo
      for (const ad of r.ads) {
        if (!byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
        ;(keywordsByAd.get(ad.ad_archive_id) ?? keywordsByAd.set(ad.ad_archive_id, new Set()).get(ad.ad_archive_id)!).add(keyword)
      }
    }
    competitors = Array.from(byId.values())
    const saved = await saveAds(client.id, competitors, keywordsByAd, prior)
    stored = saved.stored
    if (saved.note) notes.push(saved.note)

    // Say it plainly when the market read was a slice. Otherwise the brief's
    // "no longer appearing" line silently blames the market for our own cap.
    if (partial.length)
      notes.push(
        `Saw only the first ${maxPages} page(s) for ${partial.length} search(es) — more ads exist for: ${partial.slice(0, 4).join(', ')}${partial.length > 4 ? '…' : ''}. Raise adyntelMaxPages to see deeper (each page costs a credit).`,
      )
  } catch (e) {
    // Out of credits is not "the API is flaky" — it's a bill to pay, and the
    // brief should say so in words rather than leaving you to wonder why the
    // market section went quiet for a week.
    notes.push(
      e instanceof OutOfCredits
        ? `⛔ ${e.message} — the competitor section is blank until then.`
        : `Adyntel unavailable: ${(e as Error).message}`,
    )
  }

  const market = competitorSection(competitors, prior, client.countries.join('+'), {}, client.relevanceTerms, client.excludeTerms)
  if (client.keywordsPerRun && client.keywordsPerRun < client.keywords.length)
    notes.push(
      `Watching ${todaysKeywords.length} of ${client.keywords.length} keywords today (rotating): ${todaysKeywords.join(', ')}`,
    )

  // ②b The client's own book of leads. This is the half of the funnel Meta
  // cannot see: who opted in, who actually paid, and who nobody has called yet.
  let sheet: Awaited<ReturnType<typeof leadsSummary>> = null
  try {
    sheet = await leadsSummary(client)
    if (sheet && !sheet.ok) notes.push(`Master leads sheet: ${sheet.error}`)
  } catch (e) {
    notes.push(`Master leads sheet unreadable: ${(e as Error).message}`)
  }

  const leadsBlock =
    sheet && sheet.ok
      ? [
          '',
          'LEADS (from the client master sheet — this is the truth about opt-ins and payments):',
          `- yesterday: ${sheet.yesterday} new opt-in(s) · today so far: ${sheet.today} · last 7 days: ${sheet.last7} · ${sheet.total} tracked in total`,
          `- paid: ${sheet.signups} of ${sheet.total} (${money(sheet.revenue)} collected)`,
          sheet.attended !== null
            ? `- attended the webinar: ${sheet.attended}`
            : '- attendance: the sheet has no "Attended" column yet, so show-up rate is unknown (do not guess it)',
          sheet.byAd.length
            ? '- opt-ins by ad: ' +
              sheet.byAd
                .slice(0, 6)
                .map((a) => `${a.ad} ${a.leads}${a.paid ? ` (${a.paid} paid)` : ''}`)
                .join(' · ')
            : '',
          sheet.recentPayers.length
            ? '- most recent payments: ' +
              sheet.recentPayers
                .slice(0, 5)
                .map((p) => `${p.name} ${money(p.amount ?? 0)} on ${p.date}`)
                .join(' · ')
            : '- no payments recorded yet',
          sheet.followUps.length
            ? `- ${sheet.followUps.length} lead(s) have no payment and no next action. The coldest: ` +
              sheet.followUps
                .slice(0, 6)
                .map((f) => `${f.name} (${f.phone || 'no phone'}, ${f.days}d, via ${f.ad || 'unknown ad'})`)
                .join(' · ')
            : '- every lead has either paid or has a next action against it',
        ].filter((l) => l !== '')
      : []

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
    ...leadsBlock,
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
    (movers.length ? ` · ${movers.length} live campaigns` : '') +
    (sheet?.ok
      ? `\n🧲 <b>${sheet.yesterday}</b> opt-in(s) yesterday · <b>${sheet.signups}</b> paid (${money(sheet.revenue)}) · <b>${sheet.followUps.length}</b> to follow up`
      : '')
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
    adyntel_partial: partial,
    adyntel_echo: echo, // proves whether the optional filters were honoured
    competitor_ads_stored: stored,
    ad_daily_rows: synced?.rows ?? 0,
    active_ads: synced?.active_ads ?? null,
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
