// The client registry for the 8am ads brief.
//
// Non-secret config lives here, in git, where it can be reviewed and changed
// without touching code. Tokens do NOT: each client names the env var holding
// its Meta token, and the value stays in Vercel's environment settings.
//
// Adding a client is an edit to this file plus two env vars. Vercel Hobby caps
// a project at 2 cron jobs and both are used, so ONE cron loops over this list
// rather than each client getting its own schedule.

export type AdClient = {
  id: string // stable key — also the `client` column in competitor_ads
  name: string // shown in the Telegram header
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
   * Where this client is in its lifecycle, in plain words. Handed to the model
   * so a pre-launch brief can talk about dates and what to build, instead of
   * analysing performance numbers that do not exist yet. Update it as the
   * client moves on — it is describing a moment in time, not a fixed fact.
   */
  briefContext?: string
}

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
    briefContext:
      'PRE-LAUNCH. This ad account has never run an ad — zero campaigns, zero lifetime spend, ' +
      'and that is expected, not a tracking fault. Planning stage as of 29 July 2026. ' +
      'Landing page to be confirmed by 31 July 2026. First ads go live 2 August 2026. ' +
      'The offer is an AI workshop for Malaysian and Singaporean business owners and SMEs, ' +
      'including HRD Corp claimable training.',
  },
]

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
