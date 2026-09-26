import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { publicThumbUrl } from './creatives'
import type { CompetitorStats } from './adyntel'
import type { Landing } from './competitor-profiles'

// THE COMPETITOR ARCHIVE — read side.
//
// Everything the 8am runs have found, for one project, as something a person
// can browse: the competitors list (/projects/<id>/competitors), the ads
// library (/competitors/ads) and the daily research log (/competitors/log),
// plus the bot's archive tools.
//
// Three rules shape every query here:
//
// 1. NEVER LOAD EVERYTHING. PostgREST caps a response at 1,000 rows and REST
//    calls time out at 4s (lib/supabase.ts); Claude Malaysia alone holds more
//    ads than one response can carry. Pages are 50 rows; counts are head-only;
//    advertiser/keyword facets come from views that aggregate in the database.
//
// 2. DON'T TRUST is_active ALONE. It is Meta's flag as of the LAST time a search
//    returned the ad, and keyword rotation means an ad can go unseen for days
//    while still running. So status is derived: live (active, seen within 14
//    days), stale (active on paper, not seen since), ended (Meta says inactive).
//
// 3. DEGRADE, DON'T BREAK. Before supabase/competitor-archive.sql has been run,
//    on_topic, the facet views and the run facts do not exist. Every loader
//    retries without them and reports `migrationPending`, so the library still
//    shows the ads while saying exactly which file to run.

export const PAGE_SIZE = 50
/** Longer than the longest keyword cycle (11 days) plus the brand-watch cycle. */
export const STALE_AFTER_DAYS = 14
export const MIGRATION_FILE = 'supabase/competitor-archive.sql'

export type AdStatus = 'live' | 'stale' | 'ended'
export type AdSort = 'run' | 'first' | 'last'
export type AdFilters = {
  adv: string | null
  kw: string | null
  status: 'all' | AdStatus
  topic: 'all' | 'on' | 'off'
  sort: AdSort
  /** An adyntel_runs date: show only what that morning's run returned. */
  run: string | null
  page: number
}

export type StoredAd = {
  id: string
  competitor: string
  page_id: string | null
  ad_archive_id: string
  first_seen_at: string
  last_seen_at: string
  keywords: string[]
  meta_start_date: string | null
  is_active: boolean
  run_days: number | null
  run_days_basis: string | null
  title: string | null
  body_text: string | null
  caption: string | null
  cta_text: string | null
  link_url: string | null
  display_format: string | null
  publisher_platform: string[]
  collation_count: number | null
  image_urls: string[]
  video_urls: string[]
  thumbnail_urls: string[]
  local_media: { kind?: string; path?: string }[] | null
  on_topic?: boolean | null
}

// Explicit columns — never `*` (raw_payload is large) and never the enrich
// columns, which may not exist.
const AD_COLS_BASE =
  'id, competitor, page_id, ad_archive_id, first_seen_at, last_seen_at, keywords, meta_start_date, ' +
  'is_active, run_days, run_days_basis, title, body_text, caption, cta_text, link_url, display_format, ' +
  'publisher_platform, collation_count, image_urls, video_urls, thumbnail_urls, local_media'
const AD_COLS = AD_COLS_BASE + ', on_topic'

const needsMigration = (msg: string) =>
  /on_topic|facts_text|seen_ids|competitor_ads_advertisers|competitor_ads_keywords|schema cache|does not exist/i.test(msg)

const staleCutoff = (now = Date.now()) => new Date(now - STALE_AFTER_DAYS * 864e5).toISOString()

// ---------------------------------------------------------------- pure helpers

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null

export function parseAdFilters(sp: Record<string, string | string[] | undefined>): AdFilters {
  const pick = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T =>
    v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
  const page = Math.max(1, Math.floor(Number(one(sp.page)) || 1))
  const date = one(sp.run)
  return {
    adv: one(sp.adv)?.trim() || null,
    kw: one(sp.kw)?.trim() || null,
    status: pick(one(sp.status), ['all', 'live', 'stale', 'ended'] as const, 'all'),
    // On-topic by default: the library opens on the market the brief is about,
    // not on every ad that happened to share a keyword. Noise is one click away.
    topic: pick(one(sp.topic), ['all', 'on', 'off'] as const, 'on'),
    sort: pick(one(sp.sort), ['run', 'first', 'last'] as const, 'run'),
    run: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    page,
  }
}

/** A link to the library with some filters changed. Defaults are omitted; any change but paging resets to page 1. */
export function adFilterHref(id: string, f: AdFilters, patch: Partial<AdFilters>): string {
  const next: AdFilters = { ...f, ...patch, page: patch.page ?? 1 }
  const q = new URLSearchParams()
  if (next.adv) q.set('adv', next.adv)
  if (next.kw) q.set('kw', next.kw)
  if (next.status !== 'all') q.set('status', next.status)
  if (next.topic !== 'on') q.set('topic', next.topic)
  if (next.sort !== 'run') q.set('sort', next.sort)
  if (next.run) q.set('run', next.run)
  if (next.page > 1) q.set('page', String(next.page))
  const s = q.toString()
  return `/projects/${encodeURIComponent(id)}/competitors/ads${s ? `?${s}` : ''}`
}

export function adStatus(a: Pick<StoredAd, 'is_active' | 'last_seen_at'>, now = Date.now()): AdStatus {
  if (!a.is_active) return 'ended'
  return new Date(a.last_seen_at).getTime() >= now - STALE_AFTER_DAYS * 864e5 ? 'live' : 'stale'
}

/** The permanent public page for an ad. Survives every CDN expiry. */
export const adLibraryUrl = (adArchiveId: string) =>
  `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adArchiveId)}`

/**
 * The best picture for a card. A thumbnail saved to Storage is permanent; a
 * Meta CDN URL works until its signature expires, so `durable` tells the page
 * which kind it has.
 */
export function thumbFor(a: StoredAd): { url: string; durable: boolean } | null {
  const stored = (a.local_media ?? []).find((m) => m?.path)
  if (stored?.path) return { url: publicThumbUrl(supabase, stored.path), durable: true }
  const live = a.thumbnail_urls?.[0] ?? a.image_urls?.[0]
  return live ? { url: live, durable: false } : null
}

/** A keyword tag as a person reads it: brand-watch tags become "👁 Hustle Malaysia". */
export const keywordLabel = (k: string) => (k.startsWith('page:') ? `👁 ${k.slice(5)}` : k)

// ---------------------------------------------------------------- the library

type Q = ReturnType<ReturnType<typeof supabase.from>['select']>

/** Apply the status filter to a query (shared by the list and the counts). */
function withStatus<T extends Q>(q: T, status: AdFilters['status']): T {
  const cutoff = staleCutoff()
  if (status === 'live') return q.eq('is_active', true).gte('last_seen_at', cutoff) as T
  if (status === 'stale') return q.eq('is_active', true).lt('last_seen_at', cutoff) as T
  if (status === 'ended') return q.eq('is_active', false) as T
  return q
}

/**
 * The ad ids one morning's run returned. Runs recorded before the migration
 * have no seen_ids; for those, fall back to "first stored the morning after the
 * report date" — the ads that run DISCOVERED, which is labelled approximate.
 */
async function idsForRun(projectId: string, date: string): Promise<{ ids: string[] | null; approximate: boolean }> {
  const { data, error } = await supabase
    .from('adyntel_runs')
    .select('seen_ids')
    .eq('project', projectId)
    .eq('date', date)
    .maybeSingle()
  const ids = !error ? ((data as { seen_ids?: string[] | null } | null)?.seen_ids ?? null) : null
  return ids?.length ? { ids, approximate: false } : { ids: null, approximate: true }
}

export async function loadAds(
  projectId: string,
  f: AdFilters,
): Promise<{
  rows: StoredAd[]
  total: number | null
  error: string | null
  migrationPending: boolean
  runApproximate: boolean
}> {
  const empty = { rows: [], total: null, migrationPending: false, runApproximate: false }
  if (!supabaseConfigured) return { ...empty, error: 'Supabase is not configured.' }

  let runIds: string[] | null = null
  let runApproximate = false
  if (f.run) ({ ids: runIds, approximate: runApproximate } = await idsForRun(projectId, f.run))

  const build = (cols: string, withTopic: boolean) => {
    let q = supabase.from('competitor_ads').select(cols, { count: 'exact' }).eq('client', projectId) as unknown as Q
    if (f.adv) q = q.eq('competitor', f.adv) as Q
    if (f.kw) q = q.contains('keywords', [f.kw]) as Q
    q = withStatus(q, f.status)
    if (withTopic && f.topic === 'on') q = q.eq('on_topic', true) as Q
    if (withTopic && f.topic === 'off') q = q.eq('on_topic', false) as Q
    if (f.run && runIds) q = q.in('ad_archive_id', runIds) as Q
    if (f.run && !runIds) {
      // Discovered that morning: first stored on the day after the report date (UTC).
      const d = new Date(`${f.run}T00:00:00Z`)
      const from = new Date(d.getTime() + 864e5).toISOString()
      const to = new Date(d.getTime() + 2 * 864e5).toISOString()
      q = q.gte('first_seen_at', from).lt('first_seen_at', to) as Q
    }
    const order =
      f.sort === 'first'
        ? q.order('first_seen_at', { ascending: false })
        : f.sort === 'last'
          ? q.order('last_seen_at', { ascending: false })
          : q.order('run_days', { ascending: false, nullsFirst: false })
    const start = (f.page - 1) * PAGE_SIZE
    // A tie-breaker, or two pages can show the same ad and skip another.
    return order.order('ad_archive_id').range(start, start + PAGE_SIZE - 1)
  }

  const first = await build(AD_COLS, true)
  if (!first.error)
    return { rows: (first.data ?? []) as unknown as StoredAd[], total: first.count ?? null, error: null, migrationPending: false, runApproximate }
  if (!needsMigration(first.error.message)) return { ...empty, error: first.error.message }

  // Before the migration: the same list, without the on-topic column or filter.
  const retry = await build(AD_COLS_BASE, false)
  if (retry.error) return { ...empty, error: retry.error.message, migrationPending: true }
  return { rows: (retry.data ?? []) as unknown as StoredAd[], total: retry.count ?? null, error: null, migrationPending: true, runApproximate }
}

export type AdSummary = {
  total: number | null
  live: number | null
  stale: number | null
  ended: number | null
  running30: number | null
  onTopic: number | null
  unscored: number | null
  firstSeen: string | null
  /**
   * Live / not-seen-lately / ended counts WITHIN the current topic filter, for
   * the status chips — so the number on a chip is what clicking it shows.
   * The fields above describe the whole archive and stay put as filters change.
   */
  byStatus: { live: number | null; stale: number | null; ended: number | null }
}

/** Head-only counts for the header tiles: no rows travel, only numbers. */
export async function loadAdSummary(projectId: string, topic: AdFilters['topic'] = 'all'): Promise<AdSummary> {
  const nothing: AdSummary = {
    total: null, live: null, stale: null, ended: null, running30: null, onTopic: null, unscored: null, firstSeen: null,
    byStatus: { live: null, stale: null, ended: null },
  }
  if (!supabaseConfigured) return nothing
  const base = () => supabase.from('competitor_ads').select('id', { count: 'exact', head: true }).eq('client', projectId) as unknown as Q
  const count = async (q: Q) => {
    const { count: n, error } = await q
    return error ? null : (n ?? null)
  }
  // The topic-filtered base for the chip counts. If on_topic doesn't exist yet
  // the count errors and comes back null — the page then hides the chip count
  // rather than showing a number that ignores the filter.
  const topical = () =>
    topic === 'on' ? (base().eq('on_topic', true) as Q) : topic === 'off' ? (base().eq('on_topic', false) as Q) : base()
  const [tLive, tStale, tEnded] = await Promise.all([
    count(withStatus(topical(), 'live')),
    count(withStatus(topical(), 'stale')),
    count(withStatus(topical(), 'ended')),
  ])
  const [total, live, stale, ended, running30, onTopic, unscored, first] = await Promise.all([
    count(base()),
    count(withStatus(base(), 'live')),
    count(withStatus(base(), 'stale')),
    count(withStatus(base(), 'ended')),
    count(base().eq('is_active', true).gte('run_days', 30) as Q),
    count(base().eq('on_topic', true) as Q),
    count(base().is('on_topic', null) as Q),
    supabase
      .from('competitor_ads')
      .select('first_seen_at')
      .eq('client', projectId)
      .order('first_seen_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])
  return {
    total,
    live,
    stale,
    ended,
    running30,
    onTopic,
    unscored,
    firstSeen: (first.data as { first_seen_at?: string } | null)?.first_seen_at ?? null,
    byStatus: { live: tLive, stale: tStale, ended: tEnded },
  }
}

export type AdvertiserFacet = {
  competitor: string
  page_id: string | null
  ads: number
  active: number
  on_topic: number
  longest_run: number | null
  first_seen_at: string
  last_seen_at: string
}
export type KeywordFacet = { keyword: string; ads: number; active: number }

/** The chip rows, aggregated by the database (see supabase/competitor-archive.sql). */
export async function loadAdFacets(
  projectId: string,
): Promise<{ advertisers: AdvertiserFacet[]; keywords: KeywordFacet[]; migrationPending: boolean }> {
  if (!supabaseConfigured) return { advertisers: [], keywords: [], migrationPending: false }
  const [adv, kw] = await Promise.all([
    supabase
      .from('competitor_ads_advertisers')
      .select('competitor, page_id, ads, active, on_topic, longest_run, first_seen_at, last_seen_at')
      .eq('client', projectId)
      .order('ads', { ascending: false })
      .limit(200),
    supabase
      .from('competitor_ads_keywords')
      .select('keyword, ads, active')
      .eq('client', projectId)
      .order('ads', { ascending: false })
      .limit(100),
  ])
  const pending = !!(adv.error && needsMigration(adv.error.message)) || !!(kw.error && needsMigration(kw.error.message))
  return {
    advertisers: adv.error ? [] : ((adv.data ?? []) as AdvertiserFacet[]),
    keywords: kw.error ? [] : ((kw.data ?? []) as KeywordFacet[]),
    migrationPending: pending,
  }
}

// ---------------------------------------------------------------- the research log

export type RunRow = {
  date: string
  created_at: string
  searches: { keyword: string; country: string }[] | null
  watch_page: string | null
  credits: number
  ads_seen: number | null
  ads_stored: number | null
  advertisers: number | null
  concepts: number | null
  new_concepts: number | null
  new_variations: number | null
  partial: string[] | null
  facts_text?: string | null
  stats?: CompetitorStats | null
  seen_ids?: string[] | null
}
export type BriefRow = {
  date: string
  sent_at: string
  performance_text: string | null
  report_text: string | null
  delivered: string[] | null
  failed: { chat: string; error: string }[] | null
  notes: string[] | null
}

const RUN_COLS_BASE =
  'date, created_at, searches, watch_page, credits, ads_seen, ads_stored, advertisers, concepts, new_concepts, new_variations, partial'

/** One row per morning, newest first. The heavy columns stay out of the list. */
export async function loadResearchLog(
  projectId: string,
  limit = 60,
): Promise<{ runs: RunRow[]; briefDates: Set<string>; error: string | null }> {
  if (!supabaseConfigured) return { runs: [], briefDates: new Set(), error: 'Supabase is not configured.' }
  const [runs, briefs] = await Promise.all([
    supabase.from('adyntel_runs').select(RUN_COLS_BASE).eq('project', projectId).order('date', { ascending: false }).limit(limit),
    supabase.from('brief_daily').select('date').eq('project', projectId).order('date', { ascending: false }).limit(limit),
  ])
  if (runs.error) return { runs: [], briefDates: new Set(), error: runs.error.message }
  return {
    runs: (runs.data ?? []) as RunRow[],
    briefDates: new Set(((briefs.data ?? []) as { date: string }[]).map((b) => b.date)),
    error: null,
  }
}

/** Everything about one morning: the run in full, and the brief that went out. */
export async function loadRunDetail(
  projectId: string,
  date: string,
): Promise<{ run: RunRow | null; brief: BriefRow | null; migrationPending: boolean }> {
  if (!supabaseConfigured) return { run: null, brief: null, migrationPending: false }
  const briefQ = supabase
    .from('brief_daily')
    .select('date, sent_at, performance_text, report_text, delivered, failed, notes')
    .eq('project', projectId)
    .eq('date', date)
    .maybeSingle()
  const full = await supabase
    .from('adyntel_runs')
    .select(RUN_COLS_BASE + ', facts_text, stats, seen_ids')
    .eq('project', projectId)
    .eq('date', date)
    .maybeSingle()
  let run = full.data as RunRow | null
  let migrationPending = false
  if (full.error) {
    migrationPending = needsMigration(full.error.message)
    const base = await supabase.from('adyntel_runs').select(RUN_COLS_BASE).eq('project', projectId).eq('date', date).maybeSingle()
    run = (base.data as RunRow | null) ?? null
  }
  const brief = await briefQ
  return { run, brief: (brief.data as BriefRow | null) ?? null, migrationPending }
}

// ---------------------------------------------------------------- the bot

/**
 * A free-text search over the archive for the Telegram bot: an advertiser named
 * loosely ("hustle"), a keyword, a status, and a recency window on when the ad
 * was last seen. Read-only; never calls Adyntel, never spends a credit.
 */
export async function searchArchivedAds(
  projectId: string,
  opts: { advertiser?: string; keyword?: string; status?: AdStatus; days?: number; limit?: number },
): Promise<{ rows: StoredAd[]; total: number | null; error: string | null }> {
  if (!supabaseConfigured) return { rows: [], total: null, error: 'Supabase is not configured.' }
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20)
  // Named advertiser → everything they run. No advertiser → only on-topic ads,
  // or "what are competitors running" answers with whatever noise shared a keyword.
  const run = async (cols: string, topicOnly: boolean) => {
    let q = supabase.from('competitor_ads').select(cols, { count: 'exact' }).eq('client', projectId) as unknown as Q
    if (topicOnly && !opts.advertiser) q = q.eq('on_topic', true) as Q
    if (opts.advertiser) q = q.ilike('competitor', `%${opts.advertiser.replace(/[%_]/g, '')}%`) as Q
    if (opts.keyword) q = q.contains('keywords', [opts.keyword]) as Q
    if (opts.status) q = withStatus(q, opts.status)
    if (opts.days) q = q.gte('last_seen_at', new Date(Date.now() - opts.days * 864e5).toISOString()) as Q
    return q.order('run_days', { ascending: false, nullsFirst: false }).order('ad_archive_id').limit(limit)
  }
  const first = await run(AD_COLS, true)
  const res = first.error && needsMigration(first.error.message) ? await run(AD_COLS_BASE, false) : first
  if (res.error) return { rows: [], total: null, error: res.error.message }
  return { rows: (res.data ?? []) as unknown as StoredAd[], total: res.count ?? null, error: null }
}

// ---------------------------------------------------------------- the competitors list

// One row per competitor (supabase/competitor-profiles.sql), built from the
// stored ads by lib/competitor-profiles.ts. Small next to competitor_ads, but
// it still grows every morning, so the database filters, sorts and pages it.

export const PROFILES_MIGRATION_FILE = 'supabase/competitor-profiles.sql'
export type ProfileShow = 'competitors' | 'others' | 'all'
export type ProfileSort = 'active' | 'ads' | 'run' | 'new' | 'name'
export type ProfileFilters = { show: ProfileShow; sort: ProfileSort; q: string | null; page: number }

export type CompetitorProfile = {
  id: number
  competitor: string
  page_id: string | null
  page_url: string | null
  landings: Landing[]
  usp: string | null
  offer: string | null
  /** The pitch in a few words. Absent until supabase/competitor-profiles.sql adds the column. */
  angle?: string | null
  is_competitor: boolean | null
  usp_source: string | null
  ads: number
  active_ads: number
  longest_run: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  updated_at: string
}

export type ProfileCounts = {
  competitors: number | null
  others: number | null
  advertisingNow: number | null
  newThisWeek: number | null
  uspPending: number | null
}

const PROFILE_COLS =
  'id, competitor, page_id, page_url, landings, usp, offer, is_competitor, usp_source, ads, active_ads, ' +
  'longest_run, first_seen_at, last_seen_at, updated_at'

const profilesMissing = (msg: string) => /competitor_profiles|is_competitor|schema cache|does not exist/i.test(msg)

export function parseProfileFilters(sp: Record<string, string | string[] | undefined>): ProfileFilters {
  const pick = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T =>
    v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
  // Characters PostgREST's filter grammar gives meaning to are dropped, not escaped.
  const q = (one(sp.q) ?? '').replace(/[%_,.()*:"\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    show: pick(one(sp.show), ['competitors', 'others', 'all'] as const, 'competitors'),
    sort: pick(one(sp.sort), ['active', 'ads', 'run', 'new', 'name'] as const, 'active'),
    q: q ? q.slice(0, 60) : null,
    page: Math.max(1, Math.floor(Number(one(sp.page)) || 1)),
  }
}

/** A link to the competitors list with some filters changed; defaults omitted, page reset unless paging. */
export function profileFilterHref(id: string, f: ProfileFilters, patch: Partial<ProfileFilters>): string {
  const next: ProfileFilters = { ...f, ...patch, page: patch.page ?? 1 }
  const p = new URLSearchParams()
  if (next.show !== 'competitors') p.set('show', next.show)
  if (next.sort !== 'active') p.set('sort', next.sort)
  if (next.q) p.set('q', next.q)
  if (next.page > 1) p.set('page', String(next.page))
  const s = p.toString()
  return `/projects/${encodeURIComponent(id)}/competitors${s ? `?${s}` : ''}`
}

/** The ads library, filtered to one advertiser. */
export const adsOfHref = (id: string, competitor: string) =>
  adFilterHref(id, parseAdFilters({}), { adv: competitor })

export async function loadProfiles(
  projectId: string,
  f: ProfileFilters,
): Promise<{
  rows: CompetitorProfile[]
  total: number | null
  counts: ProfileCounts
  error: string | null
  migrationPending: boolean
}> {
  const noCounts: ProfileCounts = { competitors: null, others: null, advertisingNow: null, newThisWeek: null, uspPending: null }
  if (!supabaseConfigured) return { rows: [], total: null, counts: noCounts, error: 'Supabase is not configured.', migrationPending: false }

  const base = (cols: string, head = false) =>
    supabase.from('competitor_profiles').select(cols, { count: 'exact', head }).eq('project', projectId) as unknown as Q
  // "Not judged yet" (NULL) counts as a competitor until a USP pass says otherwise.
  const realOnly = (q: Q) => q.not('is_competitor', 'is', false) as Q
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString()

  const from = (f.page - 1) * PAGE_SIZE
  const listQuery = (withAngle: boolean) => {
    let list = base(withAngle ? PROFILE_COLS + ', angle' : PROFILE_COLS)
    if (f.show === 'competitors') list = realOnly(list)
    if (f.show === 'others') list = list.is('is_competitor', false) as Q
    if (f.q)
      list = list.or(
        `competitor.ilike.%${f.q}%,usp.ilike.%${f.q}%,offer.ilike.%${f.q}%${withAngle ? `,angle.ilike.%${f.q}%` : ''}`,
      ) as Q
    if (f.sort === 'active') list = list.order('active_ads', { ascending: false }).order('ads', { ascending: false }) as Q
    if (f.sort === 'ads') list = list.order('ads', { ascending: false }) as Q
    if (f.sort === 'run') list = list.order('longest_run', { ascending: false, nullsFirst: false }) as Q
    if (f.sort === 'new') list = list.order('first_seen_at', { ascending: false, nullsFirst: false }) as Q
    if (f.sort === 'name') list = list.order('competitor') as Q
    return list.order('id').range(from, from + PAGE_SIZE - 1) as Q
  }
  // The angle column arrived after the table (2026-09-26); read without it until it exists.
  const withAngle = async () => {
    const r = await listQuery(true)
    return r.error && /angle/.test(r.error.message) ? listQuery(false) : r
  }

  const [res, comp, others, now, fresh, pending] = await Promise.all([
    withAngle(),
    realOnly(base('id', true)),
    base('id', true).is('is_competitor', false),
    realOnly(base('id', true)).gt('active_ads', 0),
    realOnly(base('id', true)).gte('first_seen_at', weekAgo),
    realOnly(base('id', true)).is('usp', null),
  ])
  if (res.error) {
    const pendingMigration = profilesMissing(res.error.message)
    return { rows: [], total: null, counts: noCounts, error: pendingMigration ? null : res.error.message, migrationPending: pendingMigration }
  }
  const n = (r: { error: unknown; count: number | null }) => (r.error ? null : r.count)
  return {
    rows: (res.data ?? []) as unknown as CompetitorProfile[],
    total: res.count ?? null,
    counts: { competitors: n(comp), others: n(others), advertisingNow: n(now), newThisWeek: n(fresh), uspPending: n(pending) },
    error: null,
    migrationPending: false,
  }
}

/**
 * Profiles for the Telegram bot: the biggest real competitors, or the ones
 * whose name matches. Null when the table doesn't exist yet, so the caller can
 * fall back to the ads-only advertiser list.
 */
export async function profilesForBot(
  projectId: string,
  opts: { name?: string; top?: number },
): Promise<CompetitorProfile[] | null> {
  if (!supabaseConfigured) return null
  const run = (cols: string) => {
    let q = supabase.from('competitor_profiles').select(cols).eq('project', projectId) as unknown as Q
    if (opts.name) q = q.ilike('competitor', `%${opts.name.replace(/[%_]/g, '')}%`) as Q
    else q = q.not('is_competitor', 'is', false) as Q
    return q
      .order('active_ads', { ascending: false })
      .order('ads', { ascending: false })
      .limit(Math.min(Math.max(opts.top ?? 10, 1), 25))
  }
  let { data, error } = await run(PROFILE_COLS + ', angle')
  if (error && /angle/.test(error.message)) ({ data, error } = await run(PROFILE_COLS))
  return error ? null : ((data ?? []) as unknown as CompetitorProfile[])
}
