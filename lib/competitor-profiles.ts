import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import type { AdClient } from './ad-clients.ts'
// Explicit .ts extensions: this module is shared with scripts/ run by Node's
// native TypeScript support, which resolves only exact paths.
import { normaliseAd, isRelevant } from './adyntel.ts'
import { clip } from './format.ts'

// COMPETITOR PROFILES — one row per real competitor, built from their stored ads.
//
// The ads library answers "what are they running"; this answers "who ARE they":
// the page, where their ads send people, and what they sell and why a buyer
// would pick them. Schema and reasoning: supabase/competitor-profiles.sql.
//
// Like lib/creatives.ts this takes its Supabase and Anthropic clients as
// PARAMETERS instead of importing the server-only singletons, so the cron and
// scripts/competitor-profiles.ts build profiles with exactly the same code.
//
// The USP is read from the ad copy by a model. Everything else — landing pages,
// counts, run lengths — is plain aggregation and never waits on the model: a
// profile with no USP yet is still a useful row, and says "pending" rather
// than pretending there is nothing to say.

export const USP_MODEL = 'claude-opus-5'
/** Advertisers per model request — enough to amortise the instructions, small enough to stay precise. */
const USP_BATCH = 8
const LIVE_DAYS = 14

// ---------------------------------------------------------------- landing pages

export type LandingKind = 'website' | 'whatsapp' | 'messenger' | 'form' | 'instagram' | 'facebook' | 'none'
export type Landing = { kind: LandingKind; label: string; url: string | null; ads: number }

const SHORTENERS = /^(bit\.ly|ezy\.la|tinyurl\.com|linktr\.ee|s\.id|rb\.gy|cutt\.ly|t\.co|lnkd\.in|shorturl\.at)$/i
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Where one ad's call-to-action leads.
 *
 * The CTA type outranks the URL: Meta's Ad Library reports many conversation
 * ads with a generic "fb.me" link, and only the CTA (WHATSAPP_MESSAGE,
 * MESSAGE_PAGE) says whether that tap opens WhatsApp or Messenger. A bare fb.me
 * on a Sign up / Learn more button is an on-Facebook instant form. For a real
 * website the query string is dropped (it is utm noise), and when the link is a
 * shortener the ad's display domain — which is the page the shortener leads to —
 * becomes the label.
 */
export function classifyLanding(
  linkUrl: string | null,
  caption: string | null,
  ctaType: string | null,
): { kind: LandingKind; label: string; url: string | null } {
  const cta = (ctaType ?? '').toUpperCase()
  if (cta === 'WHATSAPP_MESSAGE') return { kind: 'whatsapp', label: 'WhatsApp chat', url: null }
  if (cta === 'MESSAGE_PAGE') return { kind: 'messenger', label: 'Messenger chat', url: null }
  if (cta === 'INSTAGRAM_MESSAGE') return { kind: 'instagram', label: 'Instagram DM', url: null }
  if (!linkUrl) return { kind: 'none', label: 'No link (stays on Facebook)', url: null }

  let u: URL
  try {
    u = new URL(linkUrl)
  } catch {
    return { kind: 'none', label: 'No usable link', url: null }
  }
  const host = u.host.replace(/^www\./, '').toLowerCase()
  if (/(^|\.)wa\.me$|whatsapp\.com$|^wa\.link$/.test(host)) return { kind: 'whatsapp', label: 'WhatsApp chat', url: null }
  if (host === 'm.me' || host.endsWith('messenger.com')) return { kind: 'messenger', label: 'Messenger chat', url: null }
  if (host === 'fb.me') return { kind: 'form', label: 'Facebook instant form', url: null }
  if (host.endsWith('instagram.com')) return { kind: 'instagram', label: 'Instagram profile', url: `https://${host}${u.pathname}` }
  if (host === 'facebook.com' || host === 'fb.com' || host.endsWith('.facebook.com'))
    return { kind: 'facebook', label: 'Facebook page', url: `https://${host}${u.pathname}` }

  const clean = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '')
  const path = u.pathname.replace(/\/$/, '')
  const cap = (caption ?? '').trim().toLowerCase().replace(/^www\./, '')
  // A shortener hides the destination; the display caption names it.
  if (SHORTENERS.test(host) && DOMAIN.test(cap) && cap !== host)
    return { kind: 'website', label: `${cap} (via ${host})`, url: clean }
  return { kind: 'website', label: clip(`${host}${path}`, 48), url: clean }
}

// ---------------------------------------------------------------- the profile

/** The columns a profile is built from — no raw_payload once on_topic exists. */
export type ProfileAd = {
  competitor: string
  page_id: string | null
  link_url: string | null
  caption: string | null
  cta_type: string | null
  cta_text: string | null
  is_active: boolean
  first_seen_at: string
  last_seen_at: string
  run_days: number | null
  title: string | null
  body_text: string | null
}

export type ProfileRow = {
  project: string
  competitor: string
  page_id: string | null
  page_url: string | null
  landings: Landing[]
  ads: number
  active_ads: number
  longest_run: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  updated_at: string
}

export function buildProfile(project: string, competitor: string, ads: ProfileAd[], now = Date.now()): ProfileRow {
  const pageId = ads.find((a) => a.page_id)?.page_id ?? null
  const landings = new Map<string, Landing>()
  for (const a of ads) {
    const l = classifyLanding(a.link_url, a.caption, a.cta_type)
    const key = `${l.kind}|${l.url ?? l.label}`
    const cur = landings.get(key)
    if (cur) cur.ads++
    else landings.set(key, { ...l, ads: 1 })
  }
  const runs = ads.map((a) => a.run_days).filter((n): n is number => typeof n === 'number')
  const first = ads.map((a) => a.first_seen_at).sort()[0] ?? null
  const last = ads.map((a) => a.last_seen_at).sort().at(-1) ?? null
  return {
    project,
    competitor,
    page_id: pageId,
    page_url: pageId ? `https://www.facebook.com/${pageId}` : null,
    // Most-used destination first; three is enough to see the pattern.
    landings: [...landings.values()].sort((a, b) => b.ads - a.ads).slice(0, 3),
    ads: ads.length,
    active_ads: ads.filter((a) => a.is_active && Date.parse(a.last_seen_at) >= now - LIVE_DAYS * 864e5).length,
    longest_run: runs.length ? Math.max(...runs) : null,
    first_seen_at: first,
    last_seen_at: last,
    updated_at: new Date(now).toISOString(),
  }
}

/**
 * What the model reads for one advertiser: their destinations and up to four
 * DISTINCT ads, longest-running first — the ones they keep paying for say the
 * most about the offer. Near-duplicate copy (the same ad in five sizes) is
 * collapsed, or one creative would crowd out the rest.
 */
export function dossierFor(competitor: string, ads: ProfileAd[], landings: Landing[]): string {
  const seen = new Set<string>()
  const distinct: ProfileAd[] = []
  for (const a of [...ads].sort((x, y) => (y.run_days ?? -1) - (x.run_days ?? -1))) {
    const key = (a.body_text ?? a.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 90).toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    distinct.push(a)
    if (distinct.length === 4) break
  }
  const lines = [
    `ADVERTISER: ${competitor}`,
    `Ads stored: ${ads.length}. CTA leads to: ${landings.map((l) => `${l.label} (${l.ads})`).join('; ') || 'unknown'}.`,
    ...distinct.map(
      (a, i) =>
        `[${i + 1}] ${a.run_days !== null ? `ran ${a.run_days}d` : 'run length unknown'}` +
        `${a.cta_text ? ` · button "${a.cta_text}"` : ''}\n` +
        `${a.title ? `Headline: ${clip(a.title.replace(/\s+/g, ' '), 140)}\n` : ''}` +
        `Copy: ${clip((a.body_text ?? '').replace(/\s+/g, ' ').trim(), 450) || '(no copy)'}`,
    ),
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------- the USP

export type UspResult = {
  competitor: string
  usp: string
  offer: string | null
  is_competitor: boolean | null
  /** The angle in a few words — what the 8am summary shows. Optional: older imports have none. */
  angle?: string | null
}

const USP_SCHEMA = {
  type: 'object',
  properties: {
    profiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          competitor: { type: 'string' },
          usp: { type: 'string' },
          offer: { type: 'string' },
          angle: { type: 'string' },
          is_competitor: { type: 'boolean' },
        },
        required: ['competitor', 'usp', 'offer', 'angle', 'is_competitor'],
        additionalProperties: false,
      },
    },
  },
  required: ['profiles'],
  additionalProperties: false,
} as const

const uspSystem = (client: AdClient) =>
  `You profile competitors for a marketing agency. The client is ${client.client ?? client.name}` +
  `${client.briefContext ? ` — context: ${clip(client.briefContext, 400)}` : ''}.\n` +
  'For each advertiser you are given their Meta ads (headline, copy, button, where the button leads). ' +
  'Return, in English whatever language the ads are in:\n' +
  '- usp: ONE sentence, at most 28 words: what they sell and the main reason they give a buyer to choose ' +
  'them over the alternatives (the promise, credential, method, speed, price position or guarantee they lean on). ' +
  'Be specific to THIS advertiser — never a generic phrase like "high-quality services". If the ads are too thin ' +
  'to tell, say what they sell and "USP not stated in the ads".\n' +
  '- offer: the concrete hook in the ads, if any — a price, a free class or seat, a discount, a bonus, a deadline, ' +
  'a guarantee. Quote numbers and currencies exactly as the ads give them. Empty string if there is none.\n' +
  '- angle: the pitch in 3 to 8 words, lower case, no full stop — the lever they pull, as a marketer would ' +
  'name it (e.g. "official Claude partner certification", "gov\'t-subsidised short courses", "build your own ' +
  'CRM in 2 days", "free 1-day AI clone workshop"). Not the product category alone.\n' +
  "- is_competitor: true if someone who would buy the client's offer could plausibly buy this INSTEAD — the same " +
  'kind of product or a real substitute for it. false for what the keyword search merely dragged in: software or ' +
  'hardware vendors, conferences and expos, courses on unrelated subjects or for another market. When false, end ' +
  'the usp with a few words saying why (e.g. "— software, not training").\n' +
  'Use the advertiser name exactly as given. Do not invent facts that are not in the ads.'

/**
 * Write USPs for a batch of advertisers. Returns what it managed and never
 * throws on a model problem — a missing USP is retried on the next run, a
 * thrown error would cost the caller everything else it built.
 */
export async function writeUsps(
  anthropic: Anthropic,
  client: AdClient,
  items: { competitor: string; dossier: string }[],
): Promise<{ results: UspResult[]; error: string | null }> {
  const results: UspResult[] = []
  let error: string | null = null
  for (let i = 0; i < items.length; i += USP_BATCH) {
    const batch = items.slice(i, i + USP_BATCH)
    try {
      const res = await anthropic.messages.parse({
        model: USP_MODEL,
        max_tokens: 4000,
        // Summarising copy that is already in front of it: low effort is plenty.
        output_config: { effort: 'low', format: jsonSchemaOutputFormat(USP_SCHEMA) },
        system: uspSystem(client),
        messages: [{ role: 'user', content: batch.map((b) => b.dossier).join('\n\n---\n\n') }],
      })
      if (res.stop_reason === 'refusal') {
        error = 'the model declined one batch — those stay pending and are retried next run'
        continue
      }
      const wanted = new Set(batch.map((b) => b.competitor))
      for (const p of res.parsed_output?.profiles ?? []) {
        if (!wanted.has(p.competitor) || !p.usp.trim()) continue // a renamed advertiser would orphan the row
        results.push({
          competitor: p.competitor,
          usp: p.usp.trim(),
          offer: p.offer.trim() || null,
          angle: p.angle.trim() || null,
          is_competitor: p.is_competitor,
        })
      }
    } catch (e) {
      error = (e as Error).message
      // Out of credit, bad key, rate limit: every further batch fails the same way.
      if (/credit balance|authentication|invalid x-api-key|rate/i.test(error)) break
    }
  }
  return { results, error }
}

// ---------------------------------------------------------------- reading the ads

const PROFILE_COLS =
  'competitor, page_id, link_url, caption, cta_type, cta_text, is_active, first_seen_at, last_seen_at, run_days, title, body_text'

/**
 * Every ON-TOPIC stored ad for a client, optionally for named advertisers only.
 *
 * Paged at 500 — PostgREST caps a response at 1,000 rows, and a paging loop
 * that treats an error as "no more rows" silently stops half way (it happened:
 * a probe read exactly 1,000 of 1,933 ads). Errors THROW here.
 *
 * Before supabase/competitor-archive.sql has been run there is no on_topic
 * column, so relevance is recomputed from raw_payload — heavier, in smaller
 * pages, with the same rule the cron uses (brand-watched = on-topic).
 */
export async function loadProfileAds(
  db: SupabaseClient,
  client: AdClient,
  competitors?: string[],
): Promise<{ ads: ProfileAd[]; scored: 'column' | 'recomputed' }> {
  const out: ProfileAd[] = []
  const probe = await db.from('competitor_ads').select('on_topic').eq('client', client.id).limit(1)
  const hasColumn = !probe.error
  const size = hasColumn ? 500 : 200
  for (let from = 0; ; from += size) {
    let q = db
      .from('competitor_ads')
      .select(hasColumn ? PROFILE_COLS : PROFILE_COLS + ', keywords, raw_payload')
      .eq('client', client.id)
      .order('id')
      .range(from, from + size - 1)
    if (hasColumn) q = q.eq('on_topic', true)
    if (competitors?.length) q = q.in('competitor', competitors)
    const { data, error } = await q
    if (error) throw new Error(`competitor_ads read failed at row ${from}: ${error.message}`)
    const rows = (data ?? []) as unknown as (ProfileAd & { keywords?: string[]; raw_payload?: Record<string, unknown> })[]
    for (const r of rows) {
      if (!hasColumn) {
        const watched = (r.keywords ?? []).some((k) => k.startsWith('page:'))
        if (!watched && !isRelevant(normaliseAd(r.raw_payload ?? {}), client.relevanceTerms, client.excludeTerms)) continue
      }
      const { keywords: _k, raw_payload: _p, ...ad } = r
      out.push(ad)
    }
    if (rows.length < size) break
  }
  return { ads: out, scored: hasColumn ? 'column' : 'recomputed' }
}

/** Group ads by advertiser. */
export function byCompetitor(ads: ProfileAd[]): Map<string, ProfileAd[]> {
  const m = new Map<string, ProfileAd[]>()
  for (const a of ads) (m.get(a.competitor) ?? m.set(a.competitor, []).get(a.competitor)!).push(a)
  return m
}

// ---------------------------------------------------------------- the refresh

/**
 * Rebuild profiles for a client (all advertisers, or just the named ones) and
 * write USPs for those that have none, up to `maxUsp`.
 *
 * Aggregates are always rewritten; a USP already written is never overwritten
 * here — it is the expensive part, and an advertiser's pitch rarely changes in
 * a week. Never throws: returns a note for the caller's warning line.
 */
export async function refreshProfiles(
  db: SupabaseClient,
  client: AdClient,
  opts: { competitors?: string[]; anthropic?: Anthropic | null; maxUsp?: number } = {},
): Promise<{ built: number; uspWritten: number; uspPending: number; note: string | null }> {
  try {
    // No table, no point reading the ads (the heavy part) just to fail the write.
    const probe = await db.from('competitor_profiles').select('id').limit(1)
    if (probe.error)
      return {
        built: 0,
        uspWritten: 0,
        uspPending: 0,
        note: /competitor_profiles|schema cache|does not exist/i.test(probe.error.message)
          ? 'Competitor profiles not stored — run supabase/competitor-profiles.sql once in the SQL editor.'
          : `Competitor profiles not stored: ${probe.error.message}`,
      }
    const { ads } = await loadProfileAds(db, client, opts.competitors)
    const groups = byCompetitor(ads)
    if (!groups.size) return { built: 0, uspWritten: 0, uspPending: 0, note: null }

    const rows = [...groups.entries()].map(([name, list]) => buildProfile(client.id, name, list))
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from('competitor_profiles').upsert(rows.slice(i, i + 200), { onConflict: 'project,competitor' })
      if (error) {
        const missing = /competitor_profiles|schema cache|does not exist/i.test(error.message)
        return {
          built: 0,
          uspWritten: 0,
          uspPending: 0,
          note: missing
            ? 'Competitor profiles not stored — run supabase/competitor-profiles.sql once in the SQL editor.'
            : `Competitor profiles not stored: ${error.message}`,
        }
      }
    }

    // Which of these still have no USP?
    const names = rows.map((r) => r.competitor)
    const have = new Set<string>()
    for (let i = 0; i < names.length; i += 150) {
      const { data } = await db
        .from('competitor_profiles')
        .select('competitor')
        .eq('project', client.id)
        .in('competitor', names.slice(i, i + 150))
        .not('usp', 'is', null)
      for (const r of (data ?? []) as { competitor: string }[]) have.add(r.competitor)
    }
    // The biggest advertisers first: when the budget runs out, the tail waits.
    const todo = rows
      .filter((r) => !have.has(r.competitor))
      .sort((a, b) => b.active_ads - a.active_ads || b.ads - a.ads)
    if (!todo.length || !opts.anthropic || !opts.maxUsp)
      return { built: rows.length, uspWritten: 0, uspPending: todo.length, note: null }

    const pick = todo.slice(0, opts.maxUsp)
    const { results, error } = await writeUsps(
      opts.anthropic,
      client,
      pick.map((r) => ({ competitor: r.competitor, dossier: dossierFor(r.competitor, groups.get(r.competitor)!, r.landings) })),
    )
    if (results.length) await saveUsps(db, client.id, results, USP_MODEL, groups)
    const pending = todo.length - results.length
    return {
      built: rows.length,
      uspWritten: results.length,
      uspPending: pending,
      note: error ? `Competitor USPs: ${results.length} written, ${pending} pending — ${error}` : null,
    }
  } catch (e) {
    return { built: 0, uspWritten: 0, uspPending: 0, note: `Competitor profiles skipped: ${(e as Error).message}` }
  }
}

/** Store written USPs. `source` records who wrote them — a model id, or the session that did. */
export async function saveUsps(
  db: SupabaseClient,
  project: string,
  results: UspResult[],
  source: string,
  groups?: Map<string, ProfileAd[]>,
): Promise<number> {
  let saved = 0
  let withAngle = true // until the database says the column isn't there yet
  const now = new Date().toISOString()
  for (const r of results) {
    const row: Record<string, unknown> = {
      usp: r.usp,
      offer: r.offer,
      is_competitor: r.is_competitor,
      usp_source: source,
      usp_ads: groups?.get(r.competitor)?.length ?? null,
      usp_updated_at: now,
    }
    if (withAngle && r.angle !== undefined) row.angle = r.angle
    const write = (values: Record<string, unknown>) =>
      db.from('competitor_profiles').update(values).eq('project', project).eq('competitor', r.competitor)
    let { error } = await write(row)
    // Before the angle column exists, keep the USP rather than lose it.
    if (error && /angle/.test(error.message)) {
      withAngle = false
      delete row.angle
      ;({ error } = await write(row))
    }
    if (!error) saved++
  }
  return saved
}

/** Store angles on their own — the in-session backfill for profiles written before angles existed. */
export async function saveAngles(
  db: SupabaseClient,
  project: string,
  items: { competitor: string; angle: string }[],
): Promise<{ saved: number; error: string | null }> {
  let saved = 0
  for (const i of items) {
    const { error } = await db
      .from('competitor_profiles')
      .update({ angle: i.angle.trim() || null })
      .eq('project', project)
      .eq('competitor', i.competitor)
    if (error) return { saved, error: error.message }
    saved++
  }
  return { saved, error: null }
}
