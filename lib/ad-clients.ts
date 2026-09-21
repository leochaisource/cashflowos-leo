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
   * EXTRA places this client's brief goes — typically a group shared with that
   * client's team. Additive: the owner's own chat always receives it too, so
   * pointing a brief at a group never costs you your own copy.
   *
   * Names of env vars, not ids, matching the pattern used for tokens: the value
   * lives in Vercel, so a group id never lands in git. Per CLIENT on purpose —
   * the global TELEGRAM_TEAM_CHAT_IDS applies to every project at once, which
   * would put one client's spend, leads and revenue in another client's group.
   * That is the one mistake this field exists to make impossible.
   *
   * Group chat ids are NEGATIVE (supergroups look like -1001234567890). Send the
   * bot /chatid inside the group to get it.
   */
  briefChatIdEnvs?: string[]
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
   * BRAND WATCH. Facebook pages to pull IN FULL, by page id, one per run in
   * rotation. Adyntel's /facebook endpoint returns everything a page is
   * running (verified 2026-09-21: Hustle Malaysia's 10 live ads in one call).
   * A keyword search cannot do this — searching a page's NAME returns other
   * advertisers who share the words (the "Hustle Malaysia" search came back
   * with Toyota Malaysia and a sauna shop, and not one Hustle ad).
   * One credit per page per run; the brief tags these ads "page:<name>".
   */
  watchPages?: { name: string; pageId: string }[]

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

  /**
   * THE FOCUS LIST. Ranked projects (1 = first) are the ones the 8am brief
   * reports and the ones the home page leads with; everything else is still
   * tracked, synced and visible, just not briefed. Three briefs you read beat
   * seven you skim. A ranked project with no ad account yet is briefed anyway —
   * competitor intelligence is exactly what a pre-launch client needs.
   *
   * Adyntel competitor research is ALSO focus-only (decided 2026-09-21): an
   * unranked client spends no credits — no keyword searches, no brand watch —
   * and the seed script refuses it without --force.
   */
  rank?: number
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

// Dianna ('dianna-nlp') was REMOVED from this registry on 2026-08-23 — the
// engagement ended. Removing the entry is the archive: her `ad_daily`,
// `competitor_ads` and `records` history stays in Supabase untouched, filed
// under 'dianna-nlp', and nothing reads it while no registry entry carries that
// id. To bring her back, restore the entry from git history and everything
// reappears intact. Her env vars (META_AD_ACCOUNT_ID / META_ACCESS_TOKEN) are
// now unused; revoke the token in Business Manager rather than merely deleting
// the vars.
export const AD_CLIENTS: AdClient[] = [
  {
    // Renamed from 'kingsley-ai' on 2026-08-08. The id is a foreign key in three
    // tables (ad_daily.project, competitor_ads.client, project_funnel.project),
    // so the rename came with a data migration — see scripts/rename-project.mjs.
    // The env var NAMES keep the old prefix on purpose: renaming those would
    // mean re-entering the token in Vercel for no gain.
    id: 'claude-malaysia',
    rank: 1,
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
    // Page ids come from the stored competitor_ads rows (page_id column).
    watchPages: [
      { name: 'Hustle Malaysia', pageId: '791929197338366' }, // "Certified Claude AI Professional" — the direct competitor
      { name: 'BELLS Tech', pageId: '385890621834316' }, // SG, SkillsFuture-subsidy angle
      { name: 'Vibe Coding 实战工作坊', pageId: '1049464534913369' }, // Chinese-language hands-on workshop, 137d+
    ],
    currency: 'RM',
    // The old account fired fb_pixel_lead; Kingsley's own account fires the pixel
    // CUSTOM event for the webinar registration (verified 21 Sep 2026: 157 in 30d).
    // leadsOf() takes the max across types, so listing both is safe on either.
    leadActionTypes: [...PIXEL_LEAD, 'offsite_conversion.fb_pixel_custom'],
    chatIdEnv: 'OWNER_CHAT_ID',
    // Set CLAUDE_MALAYSIA_GROUP_CHAT_ID in Vercel to the group's id and this
    // client's morning brief goes there instead of a private chat. Unset, it
    // falls back to the owner — so adding this line changes nothing until the
    // env var exists.
    briefChatIdEnvs: ['CLAUDE_MALAYSIA_GROUP_CHAT_ID'],
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
    // 'claude malaysia' excludes the client's OWN page — it was being quoted back
    // to them as a competitor. Exclusions read the advertiser name, so this works.
    excludeTerms: ['real estate', 'property', 'properties', 'condo', 'condominium', 'insurance', 'langsir', 'curtain', 'renovation', 'skincare', 'forex', 'claude malaysia', 'closerking', 'kingsley low'],
    briefContext:
      'LIVE on Kingsley\'s OWN ad account ("Kingsley Low Monday Funnels", connected 21 Sep 2026). The previous ' +
      'account ran the 1-day-workshop opt-in campaign 2 Aug–13 Sep at ~RM 2.50 a lead and is now paused; its rows ' +
      'are still in the data, so a 30-day window straddles both accounts until mid-October — say which account a ' +
      'number comes from when it matters. The NEW funnel is different and its numbers are not comparable with the ' +
      'old CPL: "[SF] CM1D Webinar Campaign" (live 15 Sep) drives webinar registrations, and the lead is the pixel ' +
      'CUSTOM event (offsite_conversion.fb_pixel_custom) — ~RM 7.60 each in its first week; "[SF] CM1D Direct Ticket ' +
      'Campaign" (live 17 Sep) sells the RM397 ticket straight from the ad — judge it by initiate_checkout, ' +
      'add_payment_info and purchases, never by CPL, and say plainly when purchases are not in the data. CM1D = ' +
      'Claude Malaysia 1 Day. The morning question is whether the webinar route and the direct-ticket route are ' +
      'each earning their spend.',
  },
]

// ---------------------------------------------------------------- Starcity
// Third real ad client — added 2026-08-16, WAITING ON CREDENTIALS. Until
// STARCITY_META_AD_ACCOUNT_ID and STARCITY_META_ACCESS_TOKEN exist in Vercel,
// isConfigured() is false, so the morning cron skips it (no Meta call, no
// Adyntel spend) and the dashboard shows it as "no delivery recorded".
AD_CLIENTS.push({
  id: 'starcity-global',
  rank: 2,
  name: 'Starcity Global — HK Property',
  client: 'Starcity Global',
  stage: 'active',
  adAccountEnv: 'STARCITY_META_AD_ACCOUNT_ID',
  tokenEnv: 'STARCITY_META_ACCESS_TOKEN',
  chatIdEnv: 'OWNER_CHAT_ID',
  // WHAT THIS ACTUALLY IS — corrected 2026-09-21. The account's 2021-22 relics
  // were Wing Heong bak kwa; the LIVE business is 星匯國際 × Florence 火姐
  // selling Malaysian property (KL / Johor) to Hong Kong buyers through free
  // in-person HK seminars ("HK Seminar 12 & 13 Sept": RM 8.1k, 45
  // registrations, 25 Aug–12 Sep). The market watch is HK overseas-property
  // advertising, in Chinese, because that is how it is sold.
  // First pull (2026-09-21) taught the vocabulary: '大馬物業投資' returned 11 ads /
  // 10 on-topic; '吉隆坡樓盤', '新山樓盤', '海外置業講座' returned 2–4 each, so they
  // are out. 'MM2H' returned 28 immigration-agency ads — the adjacent competitor
  // for the same HK buyer's money, kept, with visa/移居 words added to the
  // relevance offer group so they pass.
  // Verified 2026-09-21: '馬來西亞物業' returns 0 ads in HK and 'MM2H' / '大馬物業投資'
  // return travel and Greater-Bay noise; '馬來西亞樓' and '第二家園' carry the market.
  keywords: ['馬來西亞樓', '第二家園', '馬來西亞置業', '吉隆坡樓盤', '大馬樓', '馬來西亞第二家園', 'Malaysia property'],
  countries: ['HK'],
  keywordsPerRun: 2, // 2 credits/day, full list every 3 days
  watchPages: [
    { name: '優選良屋', pageId: '770012512868363' }, // MM2H-consult hook, spending now
    { name: 'Ecoworks MM2H', pageId: '1088270961045556' }, // 90d+ MM2H WhatsApp funnel
    { name: 'Malaysia Top Property', pageId: '108536222207315' }, // KLCC hotel suite, 0% DP / 15% ROI claims
    { name: 'Summer Koh', pageId: '425840764829395' }, // Bukit Bintang, Wyndham-managed, free MM2H
  ],
  currency: 'RM', // the ad account bills in MYR even though the market is HK
  // VERIFIED against the Sept campaign: the seminar registration fires the
  // Pixel's CUSTOM event (offsite_conversion.fb_pixel_custom — 44 of 45 came
  // from the Leads campaign). No named custom conversion exists on the account
  // and no standard lead event fires, so this is the only honest "lead" here.
  // Messaging conversations were 2 in a month — not the funnel.
  leadActionTypes: ['offsite_conversion.fb_pixel_custom'],
  targetCPL: 150, // RM per registration; the Sept run came in at ~RM 181
  relevanceTerms: [
    // subject: overseas property at all — Malaysia is the direct set, other
    // countries the indirect one competing for the same HK buyer's money
    // Generic 樓盤/物業 are deliberately NOT here: they let every HK domestic
    // agency through, and Kowloon flats are not this client's market.
    // Group 1: a MALAYSIAN PROPERTY signal — compounds, place names, the visa.
    // A bare '馬來西亞' is not one: in HK it labels furniture origin, SIM cards
    // and package tours, which is exactly what leaked through before.
    ['馬來西亞樓', '馬來西亞物業', '马来西亚物业', '馬來西亞置業', '马来西亚置业', '馬來西亞房產', '马来西亚房产',
     '馬來西亞 房產', '马来西亚 房产', '馬來西亞 物業', '大馬樓', '大馬物業', '大馬置業', '大馬房產', '大馬第2家園',
     '吉隆坡', '新山', '柔佛', '檳城', '槟城', '雙子塔', '双子塔', 'kuala lumpur', 'klcc', 'johor', 'penang', 'mont kiara',
     'bukit bintang', 'iskandar', 'mm2h', '第二家園', '第二家园', 'malaysia property', 'malaysian property',
     'property in malaysia', 'malaysia real estate',
     // Adjacent overseas-property sellers compete for the same HK wallet.
     '海外物業', '海外物业', '海外置業', '海外置业', '海外樓', '海外樓盤', '海外房產',
     '日本樓', '英國樓', '泰國樓', '澳洲樓', '杜拜樓', 'dubai property', 'thailand property', 'japan property', 'uk property'],
    // Group 2: it is SELLING property / a seat, not just mentioning a place.
    ['樓盤', '楼盘', '物業', '物业', '房產', '房产', '房地產', '房地产', '公寓', '住宅', 'condo', 'condominium', 'apartment',
     'suite', 'suites', 'residence', 'residences', 'freehold', '永久產權', '永久产权', '置業', '置业', '買樓', '买楼', '買房', '买房',
     '購屋', '购屋', '投資', '投资', '租金', 'rental', 'roi', '回報', '回报', '首期', 'downpayment', 'down payment',
     '講座', '讲座', 'seminar', '分享會', '分享会', '研討會', '研讨会', '發展商', '開發商', '开发商', 'developer', 'property'],
  ],
  // Greater-Bay retirement flats borrow '第二家園' too; page names carry the rest.
  // No bare '保險' here: CJK terms match as substrings, and 保险库 (a vault, a
  // KL condo selling point) contains 保险. Name the insurance PRODUCT instead.
  excludeTerms: ['保險公司', '保险公司', '人壽', '人寿', '儲蓄保險', '储蓄保险', 'insurance', 'forex', 'crypto', '貸款', '贷款',
    '肉乾', '月餅', '寵物', '宠物', '星匯', 'starcity',
    '中山', '珠海', '惠州', '佛山', '傢俬', '傢私', '家具', 'furniture', 'sim', 'wifi', '旅行社', '定制', '機票', '机票', '痛症', 'beauty'],
  briefContext:
    'LIVE, BETWEEN CAMPAIGNS. 星匯國際 (Starcity Global) × Florence 火姐 — 26 years in overseas property — ' +
    'sells Malaysian property (KL, Johor) to Hong Kong buyers via free in-person HK seminars. The 12–13 Sept ' +
    'seminar campaign ran 25 Aug–12 Sep: ~RM 8,100, 45 registrations (~RM 181 each), 123k impressions. ' +
    'Angles used: "AI 揀樓 實戰Demo" (data-driven picking), five-gate screening (五關), 8% ROI / 15-year ' +
    'retirement plan, HK-prices-too-high pain, a four-expert panel. Landing: class.starcityglobal.com/offline. ' +
    'Nothing is delivering right now, which is expected between seminars — do not call it paused or a ' +
    'problem; the useful question is what to run for the NEXT seminar. Registrations are the lead; a ' +
    'registration that attends is the real outcome, and attendance is not in the data.',
  sources: {},
})

// ---------------------------------------------------------------- Mr Money
// Rank 3, still in negotiation (2026-09-21): no ad account, no sheet. On the
// focus list anyway so the brief runs as competitor intelligence — what the
// market is doing is exactly what you want in hand walking into the deal.
// NICHE IS ASSUMED (financial education / investing courses, Malaysia): the
// keywords are a first guess, to correct the moment the offer is confirmed.
AD_CLIENTS.push({
  id: 'mr-money-academy',
  rank: 3,
  name: 'Mr Money Academy',
  client: 'Mr Money Academy',
  stage: 'pre-launch',
  adAccountEnv: 'MRMONEY_META_AD_ACCOUNT_ID',
  tokenEnv: 'MRMONEY_META_ACCESS_TOKEN',
  chatIdEnv: 'OWNER_CHAT_ID',
  keywords: ['財務自由課程', 'investing course Malaysia', '股票投資課程', 'financial freedom webinar', 'passive income masterclass', 'money management class'],
  countries: ['MY'],
  keywordsPerRun: 2,
  watchPages: [
    { name: 'PressPlay Academy', pageId: '387824567984964' }, // 存股 dividend investing, 247d+
    { name: 'The Khairi Aizat', pageId: '637786352748015' }, // Malay debt-free classes, 15 ads
    { name: 'Beyond Insights', pageId: '161380287227521' }, // Kathlyn Toh, the established brand
    { name: 'WEKAH 名家商学院', pageId: '115221704898970' }, // Sdn Bhd restructuring class
  ],
  currency: 'RM',
  leadActionTypes: PIXEL_LEAD, // unverified — no account yet
  relevanceTerms: [
    ['invest', 'investing', 'investment', '投資', '投资', 'stock', 'stocks', '股票', 'trading', 'trader', '財務', '财务', 'finance', 'financial',
     'money', 'wealth', '理財', '理财', 'passive income', 'dividend', '被動收入', '被动收入', 'cashflow', 'cash flow', 'retire', '退休'],
    ['course', 'class', 'webinar', 'masterclass', 'workshop', 'seminar', 'bootcamp', 'programme', 'program', 'academy',
     '課程', '课程', '講座', '讲座', '班', 'register', 'free', '免費', '免费', 'learn', 'mentor', 'coaching'],
  ],
  excludeTerms: ['insurance', '保險', '保险', 'loan', '貸款', '贷款', 'property', 'real estate', '地產', '地产', 'mr money'],
  briefContext:
    'IN NEGOTIATION — not yet a client, no ad account connected. Treat as pre-launch: no own performance to ' +
    'analyse. The offer is ASSUMED to be financial education (investing / money-management courses) for ' +
    'Malaysians; if the market you see contradicts that, say so plainly rather than forcing it. The job of ' +
    'this brief is to arm the negotiation: what the category is running, at what angle, and where the gap is.',
  sources: {},
})

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
/** The minimum a thing needs to be matchable — work projects qualify too. */
export type Matchable = { id: string; name: string; client?: string | null }

export function matchProject<T extends Matchable = Project>(
  text: string | undefined | null,
  /** Which projects are selectable right now — the demo switch narrows this,
   *  and callers may widen it with work projects. */
  pool: T[] = PROJECTS as unknown as T[],
): { project?: T; candidates: T[] } {
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

/** Today's watched page — one per run, cycling through the list. */
export function watchPageForToday(c: AdClient, date = new Date()): { name: string; pageId: string } | null {
  const list = c.watchPages ?? []
  if (!list.length) return null
  const start = new Date(date.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86400000)
  return list[dayOfYear % list.length]
}

/** Adyntel credits this client will spend on one run. */
export function creditsPerRun(c: AdClient): number {
  if (typeof c.rank !== 'number') return 0 // competitor research is focus-only
  return keywordsForToday(c).length * c.countries.length + (c.watchPages?.length ? 1 : 0)
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
  'DELIVERY — two or three lines when a DELIVERY block is present. State yesterday\'s spend, CPM, ' +
  'link CTR, CPC and CPL, then how each compares with the 3-day-per-day average, in that order. ' +
  'Say plainly which way each moved: a lower CPM, CPC or CPL is better, a higher CTR is better. ' +
  'If one metric explains another — CPM up while CTR held, so CPL rose on auction price rather than ' +
  'creative fatigue — say so; that is the whole point of showing them together.\n' +
  'If a LEADS section is present, then these three short blocks, using "-" bullets:\n' +
  '  LEADS: opt-ins yesterday vs the 7-day pattern, and which ad produced them. If one ad is producing ' +
  'most of the leads, say so by name.\n' +
  '  MONEY: who paid and how much, and the gap between opt-ins and payments in plain words.\n' +
  '  CHASE TODAY: name up to 5 specific people to contact, with their phone number and how many days ' +
  'they have been waiting. Real names from the data, never invented ones. If someone has been waiting ' +
  'longer than the others, put them first and say so.\n' +
  'Then three to five lines on specific competitor ads - name the advertiser, quote the actual hook or ' +
  'headline, and say the format and how long it has run. Run length is the ONLY results signal the Ad ' +
  'Library gives (spend and reach are never available): an ad still running after 60+ days is one the ' +
  'advertiser keeps paying for, several live variations of one idea means they are scaling it, and a ' +
  'brand-new ad proves nothing yet - read them that way and say so; ' +
  'then exactly 3 numbered actions, each one sentence and specific enough to do today. ' +
  "If an OWNER'S NEXT STEPS list is present, the actions MUST start from it: anything OVERDUE or due " +
  'today/tomorrow comes first, quoted with its real deadline; only after those may you add ad-side ' +
  'actions. A step with no deadline set should be nudged once ("set a date for X") rather than ignored. ' +
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
  'pain-first, authority) rather than listing ads at random. Run length is the ONLY results signal available ' +
  '(spend and reach never are): 60+ days live means the advertiser keeps paying for it, several live ' +
  'variations of one idea means they are scaling it, a brand-new ad proves nothing yet.\n' +
  'ADS TO BUILD: exactly 3 concrete ad concepts this client could produce this week. For each give a headline they ' +
  'could actually run, the format (image/video/carousel), the angle, and say plainly whether it COPIES a structure ' +
  'that several competitors are using or COUNTERS a gap none of them are covering. Write the headline as finished ' +
  'copy, not a description of a headline.\n' +
  'THEN 3 numbered actions for today, each one sentence, specific, and tied to the launch timeline in the ' +
  'SITUATION line if one is given. ' +
  HONESTY

