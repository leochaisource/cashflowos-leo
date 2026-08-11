// The client registry for the 8am ads brief AND the project dashboard.
//
// ONE list, two consumers: the morning brief (app/api/cron-ads) and the
// dashboard (app/page.tsx, app/projects/[id]). They read the same objects on
// purpose — a project that exists in the brief but not on the dashboard, or a
// lead definition that disagrees between them, is a bug you'd only find by
// noticing two numbers that should match and don't.
//
// Non-secret config lives here, in git, where it can be reviewed and changed
// without touching code. Tokens do NOT: each client names the env var holding
// its Meta token, and the value stays in Vercel's environment settings.
//
// Adding a client is an edit to this file plus two env vars. Vercel Hobby caps
// a project at 2 cron jobs and both are used, so ONE cron loops over this list
// rather than each client getting its own schedule.

/**
 * Where a number that ISN'T from Meta comes from. A plain label, shown under
 * the tile so you always know what you're looking at ("Master leads sheet ·
 * Attended"). Leave a field out and the dashboard says "not connected yet" and
 * shows a blank — which is the honest answer, unlike a zero.
 */
export type MetricSources = {
  leads?: string
  attended?: string
  appointments?: string
  signups?: string
  cash?: string
}

export type AdClient = {
  id: string // stable key — also the `client` column in competitor_ads + ad_daily
  name: string // shown in the Telegram header and as the project title
  adAccountEnv: string // env var holding the numeric Meta ad account id
  tokenEnv: string // env var holding that account's access token
  keywords: string[] // what "the competition" means for this client
  countries: string[] // Adyntel country codes
  /**
   * Adyntel bills one credit per keyword per country per run. With 11 keywords
   * across 2 countries that is 22 credits every morning, ~660/month, for one
   * client. Rotating a slice each day keeps full coverage on a short cycle at a
   * fraction of the cost: every keyword is still checked every few days, and
   * "new since last fetch" stays correct because it diffs against the database,
   * not against yesterday alone.
   *
   * 0 = no rotation, run every keyword every day.
   */
  keywordsPerRun: number
  currency: string
  /**
   * Meta reports conversions in an `actions` array and the action type depends
   * entirely on how the funnel is wired. A native instant form reports `lead`;
   * a landing-page form firing the Pixel reports `offsite_conversion.fb_pixel_lead`
   * or a custom conversion. Counting the wrong one silently reports 0 leads and
   * an infinite cost per lead.
   */
  leadActionTypes: string[]
  chatIdEnv: string // env var holding the Telegram chat id for this brief
  /**
   * Broad keywords drag in advertisers who merely share vocabulary — searching
   * "automate business operations" returns a real-estate app, an IT reseller and
   * a curtain shop, and because they have run for two years they outrank every
   * genuine competitor in a longest-running list.
   *
   * Every ad is still STORED; these terms decide only what the brief talks
   * about. An ad must mention at least one, as a whole word, to be quoted.
   * Empty or omitted = no filtering.
   */
  relevanceTerms?: string[][]
  /**
   * Escape hatch for advertisers that satisfy the term groups but are plainly
   * not competitors — a property app whose copy happens to say "AI tech
   * empowered" and "learn more". One matching term excludes the ad from the
   * brief; it is still stored.
   */
  excludeTerms?: string[]
  /**
   * Where this client is in its lifecycle, in plain words. Handed to the model
   * so a pre-launch brief can talk about dates and what to build, instead of
   * analysing performance numbers that do not exist yet. Update it as the
   * client moves on — it is describing a moment in time, not a fixed fact.
   */
  briefContext?: string

  /**
   * How many PAGES to pull per keyword × country. Adyntel returns ~30 ads and a
   * continuation token; each page is a separate credit. 1 (the default) is the
   * old behaviour — cheap, but a broad keyword's results then churn between
   * runs as ads move on and off that first page, and the brief mistakes that
   * for competitors switching ads off.
   *
   * Cost is exactly linear: keywords/run × countries × maxPages credits per day.
   */
  adyntelMaxPages?: number

  /**
   * Extra search parameters passed straight through to Adyntel.
   *
   * VERIFIED IGNORED, 2026-08-08. The API echoes back active_status,
   * search_type, media_types and start_min_date, which looked like they were
   * accepted as inputs. They are not: two identical searches — one plain, one
   * sending all four — returned the SAME 30 ads, and the echo showed the
   * server's own defaults (active_status "active", search_type
   * "keyword_unordered") in both. The echo describes what Adyntel did, not what
   * we asked for.
   *
   * Kept as a passthrough in case they ever ship real filtering; don't spend
   * time on it again without evidence that changed.
   */
  adyntelParams?: Record<string, unknown>

  // ---------------------------------------------------- dashboard-only fields
  // All optional: the brief never reads them, so a client added for the brief
  // alone still renders (with blanks where these would have gone).
  /** Who the work is for, if that differs from the project name. */
  client?: string
  /** Where the project is in its life. Drives the status pill on the card. */
  stage?: 'pre-launch' | 'active' | 'paused' | 'done'
  /** What the thing being sold costs. Turns sign-ups into revenue when no cash figure has been entered. */
  coursePrice?: number
  /** The date ads go (or went) live — shown while a project is pre-launch. */
  launchDate?: string
  /** What you consider an acceptable cost per lead. The CPL tile is judged green/amber/red against it. */
  targetCPL?: number
  /** Where the non-Meta numbers come from. Omit a field = not connected yet. */
  sources?: MetricSources

  /**
   * The master leads sheet — one row per opt-in, with whether they paid.
   *
   * Read through Google's CSV export, which works for any sheet shared as
   * "anyone with the link": no API key, no OAuth, no service account to expire
   * at the worst possible moment. The trade is that the sheet must stay
   * link-shared, and that we can only read it, never write — which is the right
   * permission for a robot to have over the client's book of leads anyway.
   */
  leadsSheet?: { id: string; gid?: string }

  /**
   * A DEMO project: it has no Meta ad account and no leads sheet of its own.
   * Everything it shows comes from seeded rows in `ad_daily`, `project_funnel`
   * and `competitor_ads` (see scripts/sample-data.mjs).
   *
   * It runs through the SAME morning brief, the same scorecard and the same bot
   * tools as a real client — only the source of the numbers differs, and it
   * spends no Meta call, no Adyntel credit. Deleting the seeded rows leaves an
   * empty project rather than a broken one.
   */
  demo?: boolean
}

/** Same objects, named for the dashboard's vocabulary. A client IS a project here. */
export type Project = AdClient

/** Instant-form funnels. */
const NATIVE_LEAD = ['lead', 'onsite_conversion.lead_grouped']

/** Landing-page opt-ins that fire the Pixel, including custom conversions. */
const PIXEL_LEAD = [
  'offsite_conversion.fb_pixel_lead',
  'offsite_conversion.fb_pixel_complete_registration',
  'onsite_web_lead',
  'lead',
]

export const AD_CLIENTS: AdClient[] = [
  {
    id: 'dianna-nlp',
    name: 'Dianna — Recalibration Masterclass',
    adAccountEnv: 'META_AD_ACCOUNT_ID',
    tokenEnv: 'META_ACCESS_TOKEN',
    keywords: ['NLP practitioner', 'transformational coaching', 'mindset webinar'],
    countries: ['MY'],
    keywordsPerRun: 0, // only 3 keywords — cheap enough to run them all daily
    currency: 'RM',
    leadActionTypes: NATIVE_LEAD,
    chatIdEnv: 'OWNER_CHAT_ID',
    client: 'Dianna',
    stage: 'active',
    // 👉 Fill these in when you have them — every one of them unlocks a tile.
    // coursePrice: 0,
    // targetCPL: 0,
    sources: {
      // 👉 Name a source here once it's wired; until then the tile stays blank.
      // leads: 'GHL landing page',
      // attended: 'Master leads sheet · Attended',
    },
    relevanceTerms: [
      ['nlp', 'coaching', 'coach', 'hypnosis', 'hypnotherapy', 'mindset', 'transformational', 'timeline therapy', 'subconscious'],
      ['practitioner', 'certification', 'certified', 'training', 'course', 'workshop', 'masterclass', 'webinar', 'programme', 'program', 'bootcamp', 'class', 'seminar', 'intake', 'enrol', 'enroll'],
    ],
  },
  {
    // Renamed from 'kingsley-ai' on 2026-08-08. The id is a foreign key in three
    // tables (ad_daily.project, competitor_ads.client, project_funnel.project),
    // so the rename came with a data migration — see scripts/rename-project.mjs.
    // The env var NAMES keep the old prefix on purpose: renaming those would
    // mean re-entering the token in Vercel for no gain.
    id: 'claude-malaysia',
    name: 'Claude Malaysia Ads',
    adAccountEnv: 'KINGSLEY_META_AD_ACCOUNT_ID',
    tokenEnv: 'KINGSLEY_META_ACCESS_TOKEN',
    keywords: [
      'AI workshop',
      'AI for business owners',
      'ChatGPT workshop',
      'AI automation workshop',
      'AI agents workshop',
      'AI for SME',
      'automate business operations',
      'AI sales automation',
      'HRD Corp AI training',
      'make money with AI',
      'Claude workshop',
    ],
    countries: ['MY', 'SG'],
    keywordsPerRun: 4, // 4 × 2 countries = 8 credits/day, full cycle every 3 days
    currency: 'RM',
    leadActionTypes: PIXEL_LEAD,
    chatIdEnv: 'OWNER_CHAT_ID',
    client: 'Claude Malaysia',
    stage: 'active',
    launchDate: '2026-08-02',
    coursePrice: 397, // the real ticket price, read off the sheet's "RM397 (General)"
    targetCPL: 15,
    // The master leads sheet — every opt-in, and whether they paid.
    leadsSheet: { id: '1zI9FCROdsU0OwfzNuOPzHhrL9MWEggPzKQhzPKASIik' },
    sources: {
      leads: 'Master leads sheet',
      attended: 'Master leads sheet · Attended column',
      appointments: 'Master leads sheet · Booked 1-1?',
      signups: 'Master leads sheet · Purchase Ticket',
      cash: 'Master leads sheet · Purchase Ticket',
    },
    relevanceTerms: [
      // subject: is it about AI at all?
      ['ai', 'a.i', 'artificial intelligence', 'chatgpt', 'gpt', 'claude', 'gemini', 'llm', 'genai', 'prompt', 'prompting', 'automation', 'automate', 'agent', 'agents', 'agentic', 'copilot', 'n8n', 'zapier', 'no-code', 'nocode'],
      // offer type: is it TEACHING it, or just using it? Without this, a property
      // app whose copy says "AI tech empowered" outranks every real competitor.
      ['workshop', 'bootcamp', 'masterclass', 'training', 'course', 'courses', 'class', 'classes', 'seminar', 'webinar', 'programme', 'program', 'cohort', 'certification', 'certified', 'hrd', 'hrdc', 'hrdf', 'learn', 'upskill', 'reskill', 'academy', 'curriculum'],
    ],
    excludeTerms: ['real estate', 'property', 'properties', 'condo', 'condominium', 'insurance', 'langsir', 'curtain', 'renovation', 'skincare', 'forex'],
    briefContext:
      'LIVE since 2 August 2026, after a pre-launch period. Early days: a few hundred ringgit spent ' +
      'so far, so treat swings in CPL as small-sample noise rather than trends, and do not recommend ' +
      'killing an ad on one bad day. Lead tracking is VERIFIED — the landing-page opt-in fires ' +
      'offsite_conversion.fb_pixel_lead, and Meta reports the same conversion under three names, ' +
      'which the brief already de-duplicates. The offer is an AI workshop for Malaysian and ' +
      'Singaporean business owners and SMEs, including HRD Corp claimable training.',
  },
]

// ---------------------------------------------------------------- demo clients
// Two more projects so the dashboard shows a portfolio rather than a single
// client. They carry no credentials and cost nothing to run: their numbers are
// seeded into the same tables a real client fills from Meta, so every screen and
// every tool treats them identically.
AD_CLIENTS.push(
  {
    id: 'lotus-clinic',
    name: 'Lotus Clinic Group — Aesthetics',
    client: 'Lotus Clinic Group',
    demo: true,
    stage: 'active',
    adAccountEnv: 'LOTUS_META_AD_ACCOUNT_ID',
    tokenEnv: 'LOTUS_META_ACCESS_TOKEN',
    chatIdEnv: 'OWNER_CHAT_ID',
    keywords: ['aesthetic clinic', 'skin treatment', 'slimming treatment', 'botox filler promo', 'acne treatment clinic'],
    countries: ['MY'],
    keywordsPerRun: 2, // 2 credits/day, whole list covered every 3 days
    currency: 'RM',
    leadActionTypes: NATIVE_LEAD, // instant forms straight into WhatsApp follow-up
    relevanceTerms: [
      // subject: is this about aesthetics/skin at all?
      ['aesthetic', 'aesthetics', 'skin', 'facial', 'face', 'beauty', 'slimming', 'botox', 'filler',
       'laser', 'acne', 'pigmentation', 'whitening', 'glow', 'anti-ageing', 'anti-aging', 'derma',
       'dermatology', 'hair removal', 'clinic', 'aesthetician'],
      // offer type: is something actually being SOLD or booked?
      ['treatment', 'package', 'promo', 'promotion', 'consultation', 'consult', 'appointment',
       'book', 'booking', 'trial', 'session', 'doctor', 'dr', 'certified', 'free', 'rm', 'discount',
       'voucher', 'whatsapp'],
    ],
    // country_code=MY still returns clinics in Bangkok, Kerala and Taipei, and a
    // brief about the wrong country is worse than a shorter brief.
    excludeTerms: ['bangkok', 'thailand', 'thrissur', 'kerala', 'india', 'taipei', 'taiwan',
      'jakarta', 'vietnam', 'manila', 'dubai', 'property', 'real estate', 'insurance', 'forex', 'crypto'],
    coursePrice: 2500,
    targetCPL: 35,
    sources: {
      leads: 'Meta instant form',
      appointments: 'Clinic booking system',
      signups: 'Clinic booking system',
      cash: 'Clinic POS export',
    },
  },
  {
    id: 'kestrel-advisory',
    name: 'Kestrel Advisory — Leadership Bootcamp',
    client: 'Kestrel Advisory',
    demo: true,
    stage: 'active',
    adAccountEnv: 'KESTREL_META_AD_ACCOUNT_ID',
    tokenEnv: 'KESTREL_META_ACCESS_TOKEN',
    chatIdEnv: 'OWNER_CHAT_ID',
    keywords: ['leadership training', 'management bootcamp', 'HRD Corp leadership', 'supervisor training', 'people manager course'],
    countries: ['MY'],
    keywordsPerRun: 2, // 2 credits/day, whole list covered every 3 days
    currency: 'RM',
    leadActionTypes: PIXEL_LEAD,
    relevanceTerms: [
      // subject: is this about leading/managing people?
      ['leadership', 'leader', 'leaders', 'manager', 'managers', 'management', 'supervisor',
       'supervisory', 'executive', 'team lead', 'people management', 'delegation', 'culture',
       'performance review', 'coaching', 'mentoring'],
      // offer type: is it TEACHING it, rather than hiring or consulting?
      ['training', 'course', 'courses', 'bootcamp', 'workshop', 'masterclass', 'programme',
       'program', 'seminar', 'webinar', 'certification', 'certified', 'hrd', 'hrdc', 'hrdf',
       'academy', 'cohort', 'class', 'upskill', 'learn', 'curriculum', 'intake'],
    ],
    // Recruiters and MLMs use the same vocabulary as leadership trainers.
    excludeTerms: ['hiring', 'we are hiring', 'job vacancy', 'vacancy', 'recruitment agency',
      'mlm', 'network marketing', 'forex', 'crypto', 'property', 'real estate', 'insurance',
      'bangkok', 'thailand', 'india', 'jakarta', 'dubai'],
    coursePrice: 1880,
    targetCPL: 40,
    sources: {
      leads: 'Landing page opt-in',
      attended: 'Zoom attendance export',
      appointments: 'Calendly',
      signups: 'Stripe',
      cash: 'Stripe',
    },
  },
)

/** The dashboard's name for the same list. */
export const PROJECTS: Project[] = AD_CLIENTS

/** One project by id, or undefined — the [id] page 404s on undefined. */
export const getProject = (id: string): Project | undefined =>
  PROJECTS.find((p) => p.id === id)

/**
 * Find the project a human meant, from however they typed it: "lotus", "claude
 * malaysia", "the clinic one", or a photo caption like "Lotus Clinic — venue
 * deposit RM1800".
 *
 * Returns the single match, or every candidate when it's ambiguous, so the
 * caller can ASK instead of guessing — filing a receipt against the wrong
 * client's P&L is worse than one extra question.
 */
export function matchProject(
  text: string | undefined | null,
  /** Which projects are selectable right now — the demo switch narrows this. */
  pool: Project[] = PROJECTS,
): { project?: Project; candidates: Project[] } {
  const hay = (text ?? '').toLowerCase().trim()
  if (!hay) return { candidates: pool }

  const exact = pool.find((p) => p.id === hay)
  if (exact) return { project: exact, candidates: [exact] }

  // Score each project on the most specific thing that matched, so "Claude
  // Malaysia" doesn't tie with a project whose name merely contains "ads".
  const scored = pool.map((p) => {
    const names = [p.id.replace(/-/g, ' '), p.name.toLowerCase(), (p.client ?? '').toLowerCase()].filter(Boolean)
    let score = 0
    for (const n of names) {
      if (!n) continue
      if (hay.includes(n)) score = Math.max(score, n.length * 2) // whole name appears
      // Otherwise: how many of the project's own words does the text mention?
      const words = n.split(/[\s—-]+/).filter((w) => w.length > 3)
      const hits = words.filter((w) => hay.includes(w)).length
      if (hits) score = Math.max(score, hits * 3)
    }
    return { p, score }
  }).filter((s) => s.score > 0)

  if (!scored.length) return { candidates: pool }
  scored.sort((a, b) => b.score - a.score)
  // A clear leader wins; a tie goes back to the human.
  if (scored.length === 1 || scored[0].score > scored[1].score) return { project: scored[0].p, candidates: [scored[0].p] }
  return { candidates: scored.map((s) => s.p) }
}

/**
 * Which keywords run today. Rotates by day-of-year so the whole list is covered
 * on a fixed cycle and the same slice never repeats two days running.
 */
export function keywordsForToday(c: AdClient, date = new Date()): string[] {
  const n = c.keywords.length
  if (!c.keywordsPerRun || c.keywordsPerRun >= n) return c.keywords
  const start = new Date(date.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86400000)
  const offset = (dayOfYear * c.keywordsPerRun) % n
  return Array.from({ length: c.keywordsPerRun }, (_, i) => c.keywords[(offset + i) % n])
}

/** Adyntel credits this client will spend on one run. */
export function creditsPerRun(c: AdClient): number {
  return keywordsForToday(c).length * c.countries.length
}

/**
 * A client is only runnable if BOTH its env vars are actually set — except a
 * demo project, which has no credentials by definition and reads its numbers
 * from the database instead.
 */
export function isConfigured(c: AdClient): boolean {
  if (c.demo) return true
  return !!process.env[c.adAccountEnv]?.trim() && !!process.env[c.tokenEnv]?.trim()
}

// ------------------------------------------------------------- the two briefs
// Both share one rule that is not negotiable: run length, repeated variations
// and continued activity are PUBLIC signals. We hold no competitor's conversion
// data and must never imply otherwise.
export const HONESTY =
  'CRITICAL - how to talk about run length: a long-running ad, repeated variations of one concept, and ' +
  'continued activity are PUBLIC signals only. You have no conversion data for any competitor. ' +
  'Never write that an ad converts, works, is profitable, or is proven. ' +
  'Say instead: "may be strategically important based on observable public signals, but private conversion ' +
  'performance is unavailable." ' +
  'Never invent numbers that are not in the data. If data is missing, say which part is missing.'

export const LIVE_PROMPT = (name: string) =>
  `You write an 8am ads briefing for ${name}, a Malaysian business. ` +
  'Be concrete and short. No preamble, no markdown headers, no bullet symbols other than "-". ' +
  'Structure, in this order:\n' +
  'ONE line on what changed in the ad numbers.\n' +
  'If a LEADS section is present, then these three short blocks, using "-" bullets:\n' +
  '  LEADS: opt-ins yesterday vs the 7-day pattern, and which ad produced them. If one ad is producing ' +
  'most of the leads, say so by name.\n' +
  '  MONEY: who paid and how much, and the gap between opt-ins and payments in plain words.\n' +
  '  CHASE TODAY: name up to 5 specific people to contact, with their phone number and how many days ' +
  'they have been waiting. Real names from the data, never invented ones. If someone has been waiting ' +
  'longer than the others, put them first and say so.\n' +
  'Then three to five lines on specific competitor ads - name the advertiser, quote the actual hook or ' +
  'headline, and say the format and how long it has run; ' +
  'then exactly 3 numbered actions, each one sentence and specific enough to do today. ' +
  'Prefer naming a real ad over generalising about "competitors". ' +
  'Never state a show-up rate, attendance figure or conversion rate that is not in the data you were ' +
  'given - if the sheet has no attendance column, say attendance is not being recorded yet. ' +
  HONESTY

// Pre-launch: there is no performance to report, so the entire brief is market
// intelligence turned into things to BUILD before the first ad goes live.
export const PRE_LAUNCH_PROMPT = (name: string) =>
  `You write an 8am pre-launch ads briefing for ${name}, a Malaysian business that has not started advertising yet. ` +
  'Do NOT analyse their own performance - there is none, and saying "RM0 spent, 0 leads" every morning is useless. ' +
  'Open with ONE short line on what moved in the competitor set since yesterday (new concepts, new variations, ads that stopped). ' +
  'Then write these three sections, using "-" for bullets, no markdown headers, no preamble:\n' +
  'WHAT THE MARKET IS DOING: three to five lines, each naming a real advertiser, quoting their actual hook or ' +
  'headline, and stating format and run length. Group by the angle being used (price, certification, testimonial, ' +
  'pain-first, authority) rather than listing ads at random.\n' +
  'ADS TO BUILD: exactly 3 concrete ad concepts this client could produce this week. For each give a headline they ' +
  'could actually run, the format (image/video/carousel), the angle, and say plainly whether it COPIES a structure ' +
  'that several competitors are using or COUNTERS a gap none of them are covering. Write the headline as finished ' +
  'copy, not a description of a headline.\n' +
  'THEN 3 numbered actions for today, each one sentence, specific, and tied to the launch timeline in the ' +
  'SITUATION line if one is given. ' +
  HONESTY

