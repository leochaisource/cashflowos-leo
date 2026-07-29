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
    id: 'kingsley-ai',
    name: 'Kingsley AI Workshop',
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
    client: 'Kingsley',
    stage: 'pre-launch',
    launchDate: '2026-08-02',
    // coursePrice: 0,
    // targetCPL: 0,
    sources: {
      // leads: 'GHL landing page',
      // attended: 'Master leads sheet · Attended',
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
      'PRE-LAUNCH. This ad account has never run an ad — zero campaigns, zero lifetime spend, ' +
      'and that is expected, not a tracking fault. Planning stage as of 29 July 2026. ' +
      'Landing page to be confirmed by 31 July 2026. First ads go live 2 August 2026. ' +
      'The offer is an AI workshop for Malaysian and Singaporean business owners and SMEs, ' +
      'including HRD Corp claimable training.',
  },
]

/** The dashboard's name for the same list. */
export const PROJECTS: Project[] = AD_CLIENTS

/** One project by id, or undefined — the [id] page 404s on undefined. */
export const getProject = (id: string): Project | undefined =>
  PROJECTS.find((p) => p.id === id)

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

/** A client is only runnable if BOTH its env vars are actually set. */
export function isConfigured(c: AdClient): boolean {
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
  'Structure: one line on what changed in the numbers; then three to five lines on specific competitor ads - ' +
  'name the advertiser, quote the actual hook or headline, and say the format and how long it has run; ' +
  'then exactly 3 numbered actions, each one sentence and specific enough to do today. ' +
  'Prefer naming a real ad over generalising about "competitors". ' +
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

