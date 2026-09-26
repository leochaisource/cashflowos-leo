import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extension: shared with scripts/brief-preview.ts, run by Node's
// native TypeScript support, which resolves only exact paths.
import { clip } from './format.ts'

// THE 8AM BRIEF, AS A PERSON READS IT.
//
// Owner's verdict on the old brief (2026-09-26): the performance block is good —
// "short and sweet" — and everything after it was too long to follow. So the
// rest of the message is rebuilt around one question: WHO is advertising in this
// market, and on WHAT angle?
//
//   1. competitorDigest() — built in CODE from competitor_profiles and this
//      morning's search, like the performance block: accurate, and present even
//      when the model is unavailable.
//   2. clampAnalysis()    — the model's contribution, cut to 5 lines whatever it
//      wrote. A limit in a prompt is a request; this is the guarantee.
//   3. operatorAlerts()   — the run's notes, reduced to the 0–2 things the owner
//      must act on, in plain words. Everything else (rotation, brand watch,
//      thumbnails saved, raw API errors) stays in brief_daily.notes, where the
//      Research log page shows it.
//
// Pure apart from loadDigestProfiles(), which takes its Supabase client as a
// parameter so scripts/brief-preview.ts renders exactly what the cron sends.

export const APP_URL = (process.env.APP_URL?.trim() || 'https://cashflowos-leo.vercel.app').replace(/\/+$/, '')
const BIGGEST = 5
const NEW_LINES = 4

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type DigestProfile = {
  competitor: string
  angle?: string | null
  offer: string | null
  usp: string | null
  is_competitor: boolean | null
  active_ads: number
  ads: number
  longest_run: number | null
}

/** One advertiser that showed up with ads this morning that were never stored before. */
export type FreshAdvertiser = { competitor: string; newAds: number; newAdvertiser: boolean }

/**
 * The angle in a few words. The written `angle` when there is one; until then
 * the concrete offer if it is short, then the first clause of the USP — never
 * the whole 28-word sentence, which is what made the old brief unreadable.
 */
export function angleOf(p: Pick<DigestProfile, 'angle' | 'offer' | 'usp'>): string | null {
  if (p.angle?.trim()) return clip(p.angle.trim(), 70)
  if (p.offer?.trim() && p.offer.trim().length <= 60) return p.offer.trim()
  const usp = p.usp?.trim()
  if (!usp || /not a ([\w-]+ ){0,2}competitor/i.test(usp)) return null
  const first = usp.split(/ — |: |; |\. /)[0]
  return clip(first, 70)
}

const PROFILE_COLS = 'competitor, offer, usp, is_competitor, active_ads, ads, longest_run'

/**
 * The profiles the digest needs: the biggest real competitors right now, the
 * ones that were fresh this morning, and the two totals. Tolerates a database
 * where the `angle` column has not been added yet.
 */
export async function loadDigestProfiles(
  db: SupabaseClient,
  project: string,
  freshNames: string[],
): Promise<{ biggest: DigestProfile[]; fresh: Map<string, DigestProfile>; competitors: number | null; live: number | null; error: string | null }> {
  const run = async (cols: string) => {
    const real = () => db.from('competitor_profiles').select(cols).eq('project', project).not('is_competitor', 'is', false)
    return Promise.all([
      real().order('active_ads', { ascending: false }).order('ads', { ascending: false }).limit(BIGGEST),
      freshNames.length
        ? db.from('competitor_profiles').select(cols).eq('project', project).in('competitor', freshNames.slice(0, 100))
        : Promise.resolve({ data: [], error: null }),
      db.from('competitor_profiles').select('id', { count: 'exact', head: true }).eq('project', project).not('is_competitor', 'is', false),
      db.from('competitor_profiles').select('id', { count: 'exact', head: true }).eq('project', project).not('is_competitor', 'is', false).gt('active_ads', 0),
    ])
  }
  let [top, fresh, all, live] = await run(PROFILE_COLS + ', angle')
  if (top.error && /angle/.test(top.error.message)) [top, fresh, all, live] = await run(PROFILE_COLS)
  if (top.error) return { biggest: [], fresh: new Map(), competitors: null, live: null, error: top.error.message }
  const freshRows = (fresh.data ?? []) as unknown as DigestProfile[]
  return {
    biggest: (top.data ?? []) as unknown as DigestProfile[],
    fresh: new Map(freshRows.map((p) => [p.competitor, p])),
    competitors: all.error ? null : all.count,
    live: live.error ? null : live.count,
    error: null,
  }
}

/**
 * "Who is advertising, and on what angle" — the summary that sits on top.
 *
 *   🔎 Competitors · 26 Sep
 *   New this morning: 2 advertisers · 5 new ads
 *   • Anik Singal — free 1-day "AI clone" workshop · new
 *   Biggest right now (live ads):
 *   • Hustle Malaysia · 44 — official Claude partner certification
 */
export function competitorDigest(args: {
  title: string
  dateLabel: string
  fresh: FreshAdvertiser[]
  profiles: { biggest: DigestProfile[]; fresh: Map<string, DigestProfile> }
}): string {
  const lines: string[] = [`🔎 <b>${esc(args.title)}</b> · ${esc(args.dateLabel)}`]

  // Ruled-out advertisers (software, expos…) are not news, however many ads they launch.
  const fresh = args.fresh
    .filter((f) => args.profiles.fresh.get(f.competitor)?.is_competitor !== false)
    .sort((a, b) => Number(b.newAdvertiser) - Number(a.newAdvertiser) || b.newAds - a.newAds)
  if (fresh.length) {
    const ads = fresh.reduce((s, f) => s + f.newAds, 0)
    lines.push(`New this morning: <b>${fresh.length}</b> advertiser${fresh.length === 1 ? '' : 's'} · <b>${ads}</b> new ad${ads === 1 ? '' : 's'}`)
    for (const f of fresh.slice(0, NEW_LINES)) {
      const p = args.profiles.fresh.get(f.competitor)
      const angle = p ? angleOf(p) : null
      const tag = f.newAdvertiser ? 'new advertiser' : `${f.newAds} new ad${f.newAds === 1 ? '' : 's'}`
      lines.push(`• <b>${esc(clip(f.competitor.trim(), 40))}</b>${angle ? ` — ${esc(angle)}` : ''} · <i>${tag}</i>`)
    }
    if (fresh.length > NEW_LINES) lines.push(`  …and ${fresh.length - NEW_LINES} more`)
  } else {
    lines.push('Nothing new from competitors this morning.')
  }

  if (args.profiles.biggest.length) {
    lines.push('Biggest right now:')
    for (const p of args.profiles.biggest) {
      const angle = angleOf(p)
      lines.push(`• <b>${esc(clip(p.competitor.trim(), 40))}</b> · ${p.active_ads} live${angle ? ` — ${esc(angle)}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** The model's analysis, cut to at most `max` lines, whatever it wrote. */
export function clampAnalysis(text: string, max = 5): string {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^[*•]\s+/, '- ').replace(/^#+\s*/, ''))
    .filter((l) => l && !/^(analysis|summary|what it means)\s*:?$/i.test(l))
    .slice(0, max)
    .map((l) => clip(l, 260))
    .join('\n')
}

/**
 * The run's notes, reduced to what the owner must DO something about, in plain
 * words, most urgent first, at most two. Raw API errors never reach Telegram.
 */
export function operatorAlerts(notes: string[], max = 2): string[] {
  // A credit problem shows up in several notes (the analysis, the USP writer);
  // once it is said, the other notes about it are the same news.
  const credit = notes.some((n) => /credit balance is too low/i.test(n))
  notes = credit ? notes.filter((n) => !/credit balance is too low/i.test(n) || /^Claude unavailable/i.test(n)) : notes
  const rules: [RegExp, (n: string) => string][] = [
    [/credit balance is too low/i, () => 'Anthropic API is out of credit — no AI analysis or new USPs today. Top up at platform.claude.com → Billing.'],
    [/Meta is NOT connected/i, () => 'Meta ad account not connected — own ad performance is unavailable (not zero).'],
    [/out of credits/i, () => 'Adyntel is out of credits — no competitor search today.'],
    [/^Adyntel unavailable/i, (n) => `Competitor search failed: ${short(n)}`],
    [/^Meta unavailable/i, (n) => `Meta API failed: ${short(n)}`],
    [/^Performance block failed|^GHL|GoHighLevel/i, (n) => `GHL figures incomplete: ${short(n)}`],
    [/^Master leads sheet|^Leads unreadable/i, () => 'Master leads sheet could not be read.'],
    [/run supabase\/[\w-]+\.sql/i, (n) => `Database update needed: ${n.match(/supabase\/[\w-]+\.sql/i)?.[0]} (paste it in the Supabase SQL editor).`],
    [/^Claude unavailable/i, (n) => `AI analysis failed: ${short(n)}`],
  ]
  const out: string[] = []
  const used = new Set<string>()
  for (const [re, say] of rules) {
    const hit = notes.find((n) => re.test(n) && !used.has(n))
    if (hit) used.add(hit)
    if (hit) {
      const line = say(hit)
      if (!out.includes(line)) out.push(line)
    }
    if (out.length >= max) break
  }
  return out
}

/** The readable part of an error note: no JSON bodies, no request ids. */
function short(note: string): string {
  const msg = note.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? note.replace(/^[^:]+:\s*/, '')
  return clip(msg.replace(/\{[\s\S]*$/, '').trim() || 'unknown error', 90)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "26 Sep" — the day in Kuala Lumpur, whatever zone the server runs in. */
export function dayLabel(d = new Date()): string {
  const [y, m, day] = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).split('-').map(Number)
  return y ? `${day} ${MONTHS[m - 1]}` : ''
}

/** The link at the bottom of the brief. */
export const competitorsLink = (project: string, n: number | null) =>
  `<a href="${APP_URL}/projects/${encodeURIComponent(project)}/competitors">${n ? `All ${n} competitors` : 'All competitors'} →</a>`
