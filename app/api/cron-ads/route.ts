import Anthropic from '@anthropic-ai/sdk'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'
import { flattenAds, normaliseAd, competitorSection, stripLoneSurrogates, mediaUrls, isRelevant, type NormalisedAd, type PriorAd } from '@/lib/adyntel'
import { persistThumbnails } from '@/lib/creatives'
import { refreshProfiles } from '@/lib/competitor-profiles'
import { AD_CLIENTS, keywordsForToday, searchesForToday, watchPageForToday, isConfigured, BRIEF_ANALYSIS_PROMPT, type AdClient } from '@/lib/ad-clients'
import {
  loadDigestProfiles,
  competitorDigest,
  clampAnalysis,
  operatorAlerts,
  competitorsLink,
  dayLabel,
  type FreshAdvertiser,
} from '@/lib/brief-digest'
import {
  ghlPerformance,
  renderPerformance,
  ghlConfigured,
  formSubmissionRows,
  saleRows,
  dayBounds,
  type LeadRow,
  type SaleRow,
} from '@/lib/ghl'
import { archiveRun, archiveRegistry } from '@/lib/archive'
import { loadAdRows } from '@/lib/metrics'
import { focusProjects } from '@/lib/settings'
import { campaignInsights, type Camp } from '@/lib/meta'
import { leadsSummary } from '@/lib/leads-sheet'
import { demoCampaigns, demoCompetitors, demoLeadsBlock } from '@/lib/demo'
import { projectScorecard } from '@/lib/metrics'
import { syncProjectAds } from '@/lib/ad-sync'
import { getRecords, type Rec } from '@/lib/records'
import { stepsFor } from '@/lib/work-projects'

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

/**
 * Where THIS client's brief goes. Every destination is ADDITIVE:
 *   • the owner's own chat — always, so you never lose your copy by pointing a
 *     brief at a group;
 *   • TELEGRAM_TEAM_CHAT_IDS — the whole-agency list, every project;
 *   • the client's own destinations (briefChatIdEnvs) — a group shared with that
 *     client's team.
 *
 * The per-client list is the important one. TELEGRAM_TEAM_CHAT_IDS is GLOBAL: put
 * a client group there and every OTHER client's spend, leads and revenue lands in
 * it too. Keeping each client's group on the client makes that impossible.
 *
 * Deduped, owner first, so the same id listed twice sends once. Ids may be
 * negative — that's what a group id looks like.
 */
/**
 * Two audiences, deliberately separated.
 *
 * OPERATOR = the owner and the internal team. They get the warning notes:
 * Adyntel credit burn, a missing schema migration, an API billing failure.
 * CLIENT = the per-client group shared with the client themselves. They get the
 * same brief WITHOUT those notes — "your credit balance is too low to access
 * the Anthropic API" is a message about our plumbing, and it does not belong in
 * front of the client whose campaign this is.
 *
 * A chat that appears in both lists is treated as operator, so the owner never
 * loses a warning by also being in the group.
 */
function recipients(client: AdClient): { operator: string[]; client: string[] } {
  const ids = (s: string | undefined) =>
    (s || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^-?\d+$/.test(x))

  const operator = Array.from(
    new Set([...ids(process.env[client.chatIdEnv]), ...ids(process.env.TELEGRAM_TEAM_CHAT_IDS)]),
  )
  const shared = Array.from(
    new Set((client.briefChatIdEnvs ?? []).flatMap((name) => ids(process.env[name]))),
  ).filter((id) => !operator.includes(id))
  return { operator, client: shared }
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

/**
 * Everything ONE PAGE is running, by page id — Adyntel's /facebook endpoint.
 * This is the only way to watch a named brand: a keyword search for the
 * page's name returns whoever shares the words, not the page. One credit.
 */
async function adyntelPage(pageId: string): Promise<{ ads: NormalisedAd[]; calls: number }> {
  const api_key = process.env.ADYNTEL_API_KEY?.trim()
  const email = process.env.ADYNTEL_EMAIL?.trim()
  if (!api_key || !email) return { ads: [], calls: 0 }
  const res = await fetch('https://api.adyntel.com/facebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key, email, facebook_url: `https://www.facebook.com/${pageId}` }),
    signal: AbortSignal.timeout(60000),
  })
  if (res.status === 402) throw new OutOfCredits('Adyntel is out of credits — top up at app.adyntel.com')
  if (!res.ok) throw new Error(`Adyntel ${res.status} on page ${pageId}`)
  const byId = new Map<string, NormalisedAd>()
  for (const raw of flattenAds(await res.json())) {
    const ad = normaliseAd(raw)
    if (ad.ad_archive_id && !byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
  }
  return { ads: Array.from(byId.values()), calls: 1 }
}

// ------------------------------------------------- competitor_ads (Supabase)
// One row per individual ad PER CLIENT, upserted on
// (client, competitor, ad_archive_id) so the same creative is updated rather
// than duplicated, and first_seen_at survives across runs.
type PriorRow = PriorAd & { keywords: string[] | null }

// PAGED. PostgREST returns at most 1,000 rows per request, and Claude Malaysia
// holds ~2,000 ads: an unpaged read silently knew only half of them, so every
// morning ~half the "new" ads were ads stored weeks ago (found 2026-09-26).
async function loadPrior(clientId: string): Promise<PriorRow[]> {
  if (!supabaseConfigured) return []
  const out: PriorRow[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from('competitor_ads')
      .select('ad_archive_id, competitor, is_active, title, body_text, keywords')
      .eq('client', clientId)
      .order('id')
      .range(from, from + size - 1)
    if (error) {
      console.error(`[CFO] competitor_ads read failed at row ${from}:`, error.message)
      break
    }
    out.push(...((data ?? []) as PriorRow[]))
    if (!data || data.length < size) break
  }
  return out
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
  client: AdClient,
  ads: NormalisedAd[],
  keywordsByAd: Map<string, Set<string>>,
  prior: PriorRow[],
  watchedIds: Set<string>,
): Promise<{ stored: number; note?: string }> {
  if (!supabaseConfigured || !ads.length) return { stored: 0 }
  const clientId = client.id
  const priorKeywords = new Map(prior.map((p) => [p.ad_archive_id, p.keywords ?? []]))
  const iso = (u: number | null) => (u === null ? null : new Date(u * 1000).toISOString())
  const rows: Record<string, unknown>[] = ads.map((a) => {
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
    // The relevance verdict, scored once here so the archive can filter "on
    // topic vs noise" in SQL instead of re-deriving it from raw_payload on every
    // page view. A watched brand's ads are on-topic by definition: the point of
    // watching a brand is to see everything it runs. "Watched" means EVER pulled
    // by brand watch (a page: keyword survives the merge above), not just today
    // — otherwise an ad brand-watched on Monday and keyword-found on Tuesday
    // would flip to noise. scripts/adyntel-rescore.ts applies the same rule.
    on_topic:
      watchedIds.has(a.ad_archive_id) ||
      [...keywords].some((k) => k.startsWith('page:')) ||
      isRelevant(a, client.relevanceTerms, client.excludeTerms),
    raw_payload: a.raw_payload,
    updated_at: new Date().toISOString(),
    }
  })
  const write = (payload: Record<string, unknown>[]) =>
    supabase.from('competitor_ads').upsert(payload, { onConflict: 'client,competitor,ad_archive_id' }).select('id')

  // Columns added by LATER migrations. If one has not been run, PostgREST
  // rejects the WHOLE batch over one unknown column — and a missing follower
  // count or relevance flag is not worth losing a day of competitor tracking
  // for. Drop what's missing, write everything else, and say which file to run.
  const OPTIONAL: Record<string, string> = {
    page_like_count: 'supabase/competitor-ads-enrich.sql',
    page_categories: 'supabase/competitor-ads-enrich.sql',
    page_profile_uri: 'supabase/competitor-ads-enrich.sql',
    on_topic: 'supabase/competitor-archive.sql',
  }
  const dropped = new Set<string>()
  let payload = rows
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await write(payload)
    if (!error) {
      const files = [...new Set([...dropped].map((c) => OPTIONAL[c]))]
      return {
        stored: data?.length ?? 0,
        note: files.length
          ? `Competitor ads stored without ${[...dropped].join(', ')} — run ${files.join(' and ')} once to enable them.`
          : undefined,
      }
    }
    const named = Object.keys(OPTIONAL).filter((c) => !dropped.has(c) && error.message.includes(c))
    if (!named.length) {
      console.error('[CFO] competitor_ads upsert failed:', error.message)
      return { stored: 0, note: `Competitor ads not stored: ${error.message}` }
    }
    for (const c of named) dropped.add(c)
    // The enrich columns arrive together — one missing means all three are.
    if (named.some((c) => c.startsWith('page_')))
      for (const c of ['page_like_count', 'page_categories', 'page_profile_uri']) dropped.add(c)
    payload = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !dropped.has(k))))
  }
  return { stored: 0, note: 'Competitor ads not stored: gave up after dropping every optional column.' }
}

/**
 * Split a brief into Telegram-sized messages.
 *
 * Telegram rejects anything over 4096 characters OUTRIGHT, so an oversized
 * message does not arrive truncated — it does not arrive at all, for every
 * recipient, leaving only a server log. Blank lines first, then line
 * boundaries, and a hard slice only as a last resort.
 */
const LIMIT = 3800
function chunk(text: string): string[] {
  const pieces: string[] = []
  for (const para of text.split('\n\n')) {
    if (para.length <= LIMIT) {
      pieces.push(para)
      continue
    }
    let buf = ''
    for (const line of para.split('\n')) {
      if (buf && buf.length + line.length + 1 > LIMIT) {
        pieces.push(buf)
        buf = line
      } else buf = buf ? buf + '\n' + line : line
    }
    if (buf) pieces.push(buf)
  }
  const out: string[] = []
  for (const piece of pieces) {
    // A single line can still be too long (a long ad body will do it). Slice it,
    // backing off any trailing partial HTML entity so the escaped text never
    // splits inside an "&amp;" and trips Telegram's parser instead.
    let rest = piece
    while (rest.length > LIMIT) {
      let cut = rest.slice(0, LIMIT)
      const amp = cut.lastIndexOf('&')
      if (amp > LIMIT - 10 && !cut.slice(amp).includes(';')) cut = cut.slice(0, amp)
      out.push(cut)
      rest = rest.slice(cut.length)
    }
    const last = out[out.length - 1]
    if (last !== undefined && last.length + rest.length + 2 < LIMIT) out[out.length - 1] = last + '\n\n' + rest
    else if (rest) out.push(rest)
  }
  return out
}

// ------------------------------------------------------------- one client
async function runClient(client: AdClient, records: Rec[]) {
  const notes: string[] = []
  const cur = client.currency
  const money = (n: number) => fmt(cur, n)

  // A demo project has no ad account: it reads the tables a real client's Meta
  // pull would have filled. Everything downstream is identical.
  const isDemo = client.demo === true

  // ① Yesterday vs the trailing 7-day daily average.
  let yesterday: Camp[] = []
  let week: Camp[] = []
  let month: Camp[] = []
  try {
    ;[yesterday, week, month] = isDemo
      ? await Promise.all([demoCampaigns(client, 1), demoCampaigns(client, 7), demoCampaigns(client, 30)])
      : await Promise.all([
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
  if (!isDemo) {
    try {
      synced = await syncProjectAds(client, 7)
    } catch (e) {
      notes.push(`Dashboard sync failed: ${(e as Error).message}`)
    }
  }

  // ①a THE PERFORMANCE BLOCK — spend from Meta, leads and sales from GHL.
  //
  // It covers YESTERDAY, complete. The brief goes out at 8am; "today" at 8am is
  // two hours of spend and almost no opt-ins, which reads as a collapse every
  // single morning. The header carries the date of the data, so the number at
  // the top always matches the numbers underneath.
  let perf: Awaited<ReturnType<typeof ghlPerformance>> = null
  let perfText = ''
  // The individual opt-ins and sales behind the counts, kept for the archive.
  let leadRows: LeadRow[] = []
  let saleRowsForDay: SaleRow[] = []
  if (client.ghl) {
    if (!ghlConfigured(client)) {
      notes.push(
        `⛔ GoHighLevel is NOT connected — ${client.ghl.locationEnv} / ${client.ghl.tokenEnv} are missing in this ` +
          'deployment, so opt-ins and sales are unavailable (not zero). Add them in Vercel and redeploy.',
      )
    } else {
      try {
        const reportDay = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
        const rows = await loadAdRows([client.id], client.ghl.spendSince)
        const spendByCampaign = (campaign: string, from: string, to: string) =>
          rows
            .filter((r) => r.date >= from && r.date <= to && (campaign === '*' || r.campaign_name === campaign))
            .reduce((s, r) => s + r.spend, 0)
        perf = await ghlPerformance(client, reportDay, spendByCampaign)

        // The rows themselves, for the archive. Sales are re-read from the last
        // class onward rather than just the report day: the upsert is
        // idempotent, and re-reading is what repairs a day the cron missed.
        try {
          const g = client.ghl
          const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
          const { start, end } = dayBounds(reportDay, tz)
          const token = process.env[g.tokenEnv]!.trim()
          const loc = process.env[g.locationEnv]!.trim()
          for (const f of g.funnels) leadRows.push(...(await formSubmissionRows(loc, token, f.formId, start, end)))
          saleRowsForDay = await saleRows(
            loc,
            token,
            dayBounds(g.salesSince, tz).start,
            end,
            g.excludeOrderSources ?? [],
          )
        } catch (e) {
          notes.push(`Archive detail unavailable: ${(e as Error).message}`)
        }
        if (perf) {
          perfText = renderPerformance(perf)
          notes.push(...perf.problems)
        }
      } catch (e) {
        notes.push(`Performance block failed: ${(e as Error).message}`)
      }
    }
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
      if (!isConfigured(client)) {
        window = 'not connected'
        notes.push(
          `⛔ Meta is NOT connected for this client — ${client.adAccountEnv} / ${client.tokenEnv} are missing in this deployment. Own-performance is unavailable, not zero. Add them in Vercel and redeploy.`,
        )
      } else {
        window = 'no delivery'
        notes.push('No Meta spend in the last 30 days — nothing has been delivering on this ad account.')
      }
    }
  }

  // ② The market — individual ads, not a headcount.
  const prior = await loadPrior(client.id)
  const todaysSearches = searchesForToday(client)
  const todaysKeywords = keywordsForToday(client)
  let competitors: NormalisedAd[] = []
  // Ads from today's watched brand page — shown whatever the relevance filter thinks.
  const watchedIds = new Set<string>()
  let stored = 0
  let credits = 0
  let partial: string[] = []
  let echo: Record<string, unknown> = {}
  // A demo project has no ad account, but its MARKET is real: these are genuine
  // Malaysian clinics and training providers, and Adyntel doesn't care that our
  // side of the account is seeded. So every project searches for real
  // competitors; only if that fails does a demo project fall back to the ads
  // already stored against it (which keeps the brief whole when credits run out).
  //
  // COMPETITOR RESEARCH IS FOR THE FOCUS LIST ONLY (ranked 1–3). Anyone else
  // spends no Adyntel credits: a demo project reuses what is already stored,
  // a real client gets a one-line note instead of a market section.
  const focus = typeof client.rank === 'number'
  if (!focus) {
    notes.push('Competitor research runs only for the focus list (ranked 1–3) — no Adyntel credits spent on this client.')
    if (isDemo) competitors = await demoCompetitors(client)
  }
  if (focus) try {
    const jobs = todaysSearches // keyword × country pairs: one credit each
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
    // ③ Brand watch — one whole page per run, tagged "page:<name>" so the
    // brief can tell a watched brand's ad from a keyword hit.
    const watched = watchPageForToday(client)
    if (watched) {
      try {
        const r = await adyntelPage(watched.pageId)
        credits += r.calls
        for (const ad of r.ads) {
          if (!byId.has(ad.ad_archive_id)) byId.set(ad.ad_archive_id, ad)
          watchedIds.add(ad.ad_archive_id)
          ;(keywordsByAd.get(ad.ad_archive_id) ?? keywordsByAd.set(ad.ad_archive_id, new Set()).get(ad.ad_archive_id)!).add(`page:${watched.name}`)
        }
        notes.push(`Brand watch today: ${watched.name} — ${r.ads.length} live ad(s) pulled in full.`)
      } catch (e) {
        if (e instanceof OutOfCredits) throw e
        notes.push(`Brand watch failed for ${watched.name}: ${(e as Error).message}`)
      }
    }
    competitors = Array.from(byId.values())
    const saved = await saveAds(client, competitors, keywordsByAd, prior, watchedIds)
    stored = saved.stored
    if (saved.note) notes.push(saved.note)

    // Keep the creatives of what is NEW and on-topic while their URLs still
    // work — Meta's CDN links expire within weeks, and a library of blank cards
    // is not an archive. Only new ones (older ads are the backfill script's
    // job) and only on-topic ones (noise is not worth the storage). Capped per
    // run; never allowed to cost the brief.
    try {
      const known = new Set(prior.map((p) => p.ad_archive_id))
      const candidates = competitors
        .filter((a) => !known.has(a.ad_archive_id))
        .filter((a) => watchedIds.has(a.ad_archive_id) || isRelevant(a, client.relevanceTerms, client.excludeTerms))
        .map((a) => {
          const m = mediaUrls(a)
          return { ad_archive_id: a.ad_archive_id, urls: [...m.thumbs, ...m.images] }
        })
      if (candidates.length) {
        const t = await persistThumbnails(supabase, client.id, candidates)
        if (t.bucketMissing)
          notes.push('Creatives not saved — the competitor-creatives bucket is missing; run supabase/competitor-archive.sql once.')
        else if (t.saved || t.failed || t.expired)
          notes.push(
            `Creatives: ${t.saved} new thumbnail(s) saved` +
              (t.expired ? `, ${t.expired} already expired` : '') +
              (t.failed ? `, ${t.failed} failed` : '') +
              (t.skipped ? `, ${t.skipped} over today's cap` : '') +
              '.',
          )
      }
    } catch (e) {
      notes.push(`Creatives not saved: ${(e as Error).message}`)
    }

    // The Competitors tab: bring the profiles of everyone seen this morning up
    // to date (new advertisers get a row, known ones fresh counts and landing
    // pages), and write a USP for up to 10 that have none. refreshProfiles
    // never throws — a failure is a note, never a lost brief.
    const seenToday = [...new Set(competitors.map((a) => a.page_name).filter(Boolean))]
    if (seenToday.length) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
      const p = await refreshProfiles(supabase, client, {
        competitors: seenToday,
        anthropic: anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null,
        maxUsp: 10,
      })
      if (p.note) notes.push(p.note)
    }

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
    // Fall back to what's already stored so the brief still has a market
    // section. Only for demo projects: a real client deserves to SEE that the
    // feed broke, not a quietly recycled one from last week.
    if (isDemo) {
      competitors = await demoCompetitors(client)
      if (competitors.length) notes.push('Competitor section rebuilt from stored ads (no fresh search this run).')
    }
  }

  const market = competitorSection(competitors, prior, client.countries.join('+'), {}, client.relevanceTerms, client.excludeTerms, watchedIds)
  const allSearches = client.keywords.length * client.countries.length
  if (focus && todaysSearches.length < allSearches)
    notes.push(
      `Watching ${todaysSearches.length} of ${allSearches} keyword×country searches today (rotating): ${todaysSearches.map(([k, cc]) => `${k} (${cc})`).join(', ')}`,
    )

  // Who turned up this morning with on-topic ads never stored before — the
  // "new" half of the competitor summary. A demo client re-reads stored ads,
  // so nothing about it is new.
  const knownIds = new Set(prior.map((p) => p.ad_archive_id))
  const knownAdvertisers = new Set(prior.map((p) => p.competitor))
  const freshBy = new Map<string, FreshAdvertiser>()
  if (!isDemo)
    for (const a of competitors) {
      if (!a.page_name || knownIds.has(a.ad_archive_id)) continue
      if (!watchedIds.has(a.ad_archive_id) && !isRelevant(a, client.relevanceTerms, client.excludeTerms)) continue
      const f = freshBy.get(a.page_name) ?? { competitor: a.page_name, newAds: 0, newAdvertiser: !knownAdvertisers.has(a.page_name) }
      f.newAds++
      freshBy.set(a.page_name, f)
    }

  // ②b The client's own book of leads. This is the half of the funnel Meta
  // cannot see: who opted in, who actually paid, and who nobody has called yet.
  let sheet: Awaited<ReturnType<typeof leadsSummary>> = null
  let demoLeads: string[] = []
  try {
    if (isDemo) demoLeads = await demoLeadsBlock(client, 30, money)
    else {
      sheet = await leadsSummary(client)
      if (sheet && !sheet.ok) notes.push(`Master leads sheet: ${sheet.error}`)
    }
  } catch (e) {
    notes.push(`Leads unreadable: ${(e as Error).message}`)
  }

  const leadsBlock = isDemo
    ? demoLeads
    : sheet && sheet.ok
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

  // ②c The owner's OWN to-do list for this client — the mini-PM layer. The
  // model is told to fold the urgent ones into its 3 actions, so the brief
  // stops suggesting work in a vacuum and starts scheduling what's real.
  const openSteps = stepsFor(records, client.id).open
  const stepsBlock = openSteps.length
    ? [
        '',
        "OWNER'S NEXT STEPS for this client (their own to-do list, with deadlines — fold the urgent ones into the 3 actions; never invent a deadline that isn't here):",
        ...openSteps
          .slice(0, 6)
          .map((st) => `- ${st.title}${st.due ? ` (due ${st.due}${st.overdue ? ' — OVERDUE' : ''})` : ' (no deadline set)'}`),
      ]
    : []

  // ③ Turn it into advice.
  // An account that has never delivered is a different report, not a broken one:
  // there is nothing to optimise, so the whole brief becomes competitor
  // intelligence and what to BUILD from it.
  const notConnected = window === 'not connected'
  const preLaunch = window === 'no delivery' || notConnected

  // ①c DELIVERY — yesterday against the trailing 3 days, from the ad_daily rows
  // the sync just refreshed. This is where CPM and CTR come from: they were
  // always derivable from what we store, and simply never computed.
  let deliveryBlock: string[] = []
  try {
    const card = await projectScorecard(client, 30)
    const pctS = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(2)}%`)
    const line = (label: string, d: typeof card.yesterday) =>
      `- ${label}: ${money(d.spend)} · ${d.impressions.toLocaleString('en-MY')} impressions · ` +
      `CPM ${d.cpm === null ? 'n/a' : money(d.cpm)} · CTR ${pctS(d.ctr)} (link ${pctS(d.linkCtr)}) · ` +
      `${d.clicks} clicks (${d.linkClicks} link) · CPC ${d.cpc === null ? 'n/a' : money(d.cpc)} · ` +
      `${d.leads} leads · CPL ${d.cpl === null ? 'n/a' : money(d.cpl)}`
    // Deltas are what turn two rows of numbers into a signal. Only quote one
    // when both sides exist, so a first day never reads as a 100% collapse.
    const delta = (now: number | null, base: number | null) =>
      now === null || base === null || base === 0 ? '' : ` (${now >= base ? '+' : ''}${Math.round(((now - base) / base) * 100)}% vs 3-day)`
    deliveryBlock = card.yesterday.spend > 0 || card.last3.spend > 0
      ? [
          '',
          'DELIVERY (from the stored daily snapshot):',
          line('YESTERDAY', card.yesterday),
          line('LAST 3 DAYS, PER DAY', card.last3PerDay),
          `- yesterday vs the 3-day average: CPM${delta(card.yesterday.cpm, card.last3PerDay.cpm)}, ` +
            `link CTR${delta(card.yesterday.linkCtr, card.last3PerDay.linkCtr)}, ` +
            `CPL${delta(card.yesterday.cpl, card.last3PerDay.cpl)}`,
          '- for CPM, CPC and CPL a NEGATIVE change is an improvement; for CTR and leads a positive change is.',
        ]
      : []
  } catch (e) {
    notes.push(`Delivery metrics unavailable: ${(e as Error).message}`)
  }

  const factsRaw = [
    `CLIENT: ${client.name}`,
    client.briefContext ? `SITUATION: ${client.briefContext}` : '',
    notConnected
      ? 'OWN PERFORMANCE: NOT AVAILABLE — the ad account is not connected to this system yet (credentials ' +
        'missing). Do NOT describe performance, and do NOT say there is none or that nothing is running; say ' +
        'the account is not connected and move on to the market.'
      : preLaunch
      ? 'OWN PERFORMANCE: none. This account has no delivery in any window, so there are no numbers to analyse.'
      : `WINDOW = ${window.toUpperCase()}: spent ${money(spent)}, ${leads} leads across ${movers.length} campaigns.`,
    ...(preLaunch
      ? []
      : movers.slice(0, 8).map(
          (c) =>
            `- ${c.name}: ${money(c.spend)}, ${c.leads} leads, CPL ${c.cpl ? money(c.cpl) : 'n/a'}` +
            `, CPM ${c.cpm === null ? 'n/a' : money(c.cpm)}, CTR ${c.ctr === null ? 'n/a' : (c.ctr * 100).toFixed(2) + '%'}` +
            `, link CTR ${c.linkCtr === null ? 'n/a' : (c.linkCtr * 100).toFixed(2) + '%'}` +
            (c.frequency ? `, frequency ${c.frequency.toFixed(2)}` : '') +
            (c.cplDelta ? ` (${c.cplDelta > 0 ? '+' : ''}${c.cplDelta}% CPL vs 7-day avg ${money(c.avgCpl)})` : ''),
        )),
    ...(perf
      ? [
          '',
          'PERFORMANCE BLOCK ALREADY SENT (verbatim, above your text — do not restate it):',
          perfText,
        ]
      : []),
    ...deliveryBlock,
    ...leadsBlock,
    ...stepsBlock,
    '',
    market.text,
  ]
    .filter((l) => l !== '')
    .join('\n')
  // Belt and braces: one lone surrogate anywhere in this block 400s the model
  // call and costs the whole briefing, so sanitise the finished string too.
  const facts = stripLoneSurrogates(factsRaw)

  // ③a WHO IS ADVERTISING, ON WHAT ANGLE — built in code from the competitor
  // profiles, before the model runs, so the model can see what is already said
  // and the summary survives a model outage (lib/brief-digest.ts).
  let digest = ''
  let competitorCount: number | null = null
  if (focus && supabaseConfigured) {
    const profiles = await loadDigestProfiles(supabase, client.id, [...freshBy.keys()])
    if (profiles.error) notes.push(`Competitor summary unavailable: ${profiles.error}`)
    competitorCount = profiles.competitors
    digest = competitorDigest({
      title: perfText ? 'Competitors' : `${client.client ?? client.name} — competitors`,
      dateLabel: dayLabel(),
      fresh: [...freshBy.values()],
      profiles,
    })
  }

  // ③b The model adds AT MOST five lines under it — what the angles mean and
  // what to do today. clampAnalysis() enforces the five whatever it writes.
  let report = ''
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (key) {
    try {
      const anthropic = new Anthropic({ apiKey: key })
      const res = await anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 700,
        system: BRIEF_ANALYSIS_PROMPT(client.name),
        messages: [
          {
            role: 'user',
            content: facts + (digest ? `\n\nCOMPETITOR SUMMARY ALREADY SENT (do not repeat it):\n${digest.replace(/<[^>]+>/g, '')}` : ''),
          },
        ],
      })
      report = clampAnalysis(
        res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      )
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
  // THE MESSAGE (owner's format, 2026-09-26): the performance block, then who is
  // advertising and on what angle, then at most five lines of analysis, a link
  // to the full list, and at most two alerts he must act on. ONE message.
  //
  // What it no longer carries: the raw facts block (the model's INPUT — it used
  // to be sent whenever the model failed, raw image URLs and all), and every
  // internal note. Both are still archived in full (brief_daily.notes,
  // adyntel_runs.facts_text) and shown on the Research log page.
  const alerts = operatorAlerts(notes)
  const text = [
    perfText ? esc(perfText) : spent > 0 || !focus ? header : '',
    digest,
    report ? esc(report) : '',
    focus ? competitorsLink(client.id, competitorCount) : '',
    alerts.map((a) => `⚠️ ${esc(a)}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  const chunks = chunk(text)
  // THE CLIENT GROUP GETS THE NUMBERS AND NOTHING ELSE (owner's instruction,
  // 2026-09-23). The competitor summary is working material for the operator —
  // it names the client's rivals, which is not a conversation to have in the
  // client's own group. No numbers, no message to the group.
  const clientChunks = perfText ? chunk(esc(perfText)) : []
  const to = recipients(client)
  // Track delivery per destination. A group the bot was removed from, or a
  // mistyped id, must show up in the run result — otherwise the brief goes
  // missing for a week before anyone notices (which has already happened once
  // here, with Adyntel).
  const delivered: string[] = []
  const failed: { chat: string; error: string }[] = []
  for (const [chats, parts] of [
    [to.operator, chunks],
    [to.client, clientChunks],
  ] as const) {
    for (const chat of chats) {
      if (!parts.length) continue
      let ok = true
      for (const part of parts) {
        const r = await sendMessage(chat, part, { noPreview: true })
        if (!r.ok) {
          ok = false
          failed.push({ chat, error: r.error ?? 'unknown' })
          break // don't send the rest of a brief nobody is receiving
        }
      }
      if (ok) delivered.push(chat)
    }
  }
  if (failed.length)
    console.error(`[CFO] ${client.id}: brief undelivered to ${failed.map((f) => `${f.chat} (${f.error})`).join(', ')}`)

  // ④ Write the morning down. This happens AFTER delivery on purpose: the brief
  // is the product, the archive is the record of it, and a storage fault must
  // never be the reason a client did not get their numbers.
  const archiveNotes = await archiveRun({
    client,
    date: perf?.date ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10),
    perf,
    performanceText: perfText,
    reportText: report,
    recipients: [...to.operator, ...to.client],
    delivered,
    failed,
    notes,
    leads: leadRows,
    sales: saleRowsForDay,
    adyntel: focus
      ? {
          searches: todaysSearches.map(([keyword, country]) => ({ keyword, country })),
          watchPage: watchPageForToday(client)?.name ?? null,
          credits,
          adsSeen: competitors.length,
          adsStored: stored,
          advertisers: new Set(competitors.map((a) => a.page_name)).size,
          concepts: Number(market.stats.concepts ?? 0),
          newConcepts: Number(market.stats.new_concepts ?? 0),
          newVariations: Number(market.stats.new_variations ?? 0),
          partial,
          factsText: market.text,
          stats: market.stats,
          seenIds: competitors.map((a) => a.ad_archive_id),
        }
      : null,
  })
  notes.push(...archiveNotes)

  return {
    client: client.id,
    sent: delivered.length,
    recipients: [...to.operator, ...to.client],
    client_groups: to.client,
    delivered,
    failed,
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
  // THE POINT OF THE DEMO SWITCH: with it off, the sample clients are not
  // briefed at all, so they stop spending Adyntel credits between presentations.
  // Asking for one by name still runs it, so a demo brief can be previewed
  // without turning the whole thing back on.
  // THE SCHEDULED RUN COVERS THE FOCUS LIST ONLY — the ranked top projects
  // (lib/settings.ts, FOCUS_MAX). Everything else stays on the dashboard and
  // keeps syncing, but is not briefed: three briefs you read beat seven you
  // skim. Asking for one by name still runs it, ranked or not, so any client
  // can be previewed on demand; the demo switch still hides demo clients from
  // the scheduled run.
  const queue = only ? AD_CLIENTS.filter((c) => c.id === only) : await focusProjects()

  // One records read shared by every client in the run — next steps live there.
  const records = await getRecords()

  // Mirror the registry so the projects can be queried in Supabase next to the
  // data that describes them. Every client, not just the focus list — the point
  // is a complete picture, and it costs one upsert.
  const registryNote = await archiveRegistry(AD_CLIENTS)

  const results: unknown[] = []
  const skipped: string[] = []
  const runnable = queue.filter((c) => {
    // A FOCUS project with no ad account connected is briefed anyway — the
    // brief becomes competitor intelligence, which is exactly what a client
    // you're about to sign needs. Only unranked, unconfigured clients are skipped.
    if (isConfigured(c) || typeof c.rank === 'number') return true
    skipped.push(`${c.id} (missing ${c.adAccountEnv} or ${c.tokenEnv})`)
    return false
  })

  // TWO AT A TIME. Fully sequential was right at two clients and stops being
  // right at four: each one is several Adyntel calls plus a model write-up —
  // call it 40-70s — and four in a row runs at the 300s ceiling, where the last
  // client's brief silently never sends. All-at-once instead risks rate limits.
  // Pairs halve the wall time and keep concurrent load where it already was.
  const CONCURRENCY = 2
  for (let i = 0; i < runnable.length; i += CONCURRENCY) {
    const batch = runnable.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(
      batch.map((client) =>
        runClient(client, records).catch((e) => {
          // One client failing must never take the others down with it.
          console.error(`[CFO] client ${client.id} failed:`, e)
          return { client: client.id, ok: false, error: (e as Error).message }
        }),
      ),
    )
    results.push(...settled)
  }

  return Response.json({
    ok: true,
    clients: results.length,
    skipped,
    ...(registryNote ? { registry: registryNote } : {}),
    results,
  })
}
