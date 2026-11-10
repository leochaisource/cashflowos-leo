// 👉 LEO'S CURRENT AI SETUP — what the AI Library researcher and the Saturday ideas
// compare every case against, so an idea never suggests building what already runs
// (lesson from the 2026-11-10 StoreHub study: most of that founder's sales agents
// already existed here; the useful answer was the gaps).
//
// ⚠️ This is a written description, and written descriptions go stale. When you add,
// change or retire an automation, update the list below in the same commit. The
// Saturday ideas also read live facts on their own (the ad clients and their focus
// ranks, the AI Employees list, Leo's answers to past ideas), so the list only needs
// to cover what those don't.

export const WHO = `Leo Chai: growth and performance marketer in Kuala Lumpur. Runs SpeakFunnels, which builds funnels and runs Meta ads for clients who sell webinars, 1-day workshops, seminars and courses (Malaysia, Singapore, Hong Kong buyers). Small team: Ariella closes leads on WhatsApp and calls; "Ari" is the WhatsApp assistant persona. Leo is not a developer: he builds with Claude Code, and his app CashFlowOS (Next.js on Vercel, Supabase, a Telegram bot called Jarvis, GoHighLevel as the CRM) runs his automations in the cloud.`

export const STACK: { name: string; what: string }[] = [
  { name: '8am ads brief', what: 'One Telegram message per focus client: Meta spend and leads, GHL form submissions, sales and seats, built in code; then new competitor ads (Adyntel) with their angles, a 5-line AI analysis and plain alerts. The client group gets the numbers only.' },
  { name: 'Buying-intent judge', what: "Reads every WhatsApp chat in GHL for Claude Malaysia (overnight half-price batch + a 3pm refresh), labels each lead hot/warm/cold, and tags the contact." },
  { name: 'Hot list for the closer', what: "One GHL pipeline that is Ariella's list: hot chats and unpaid checkouts enter by themselves, paid leads leave; an hourly tick pings her when a call-back is due or a lead replies, and moves stale cards." },
  { name: "Ari's WhatsApp follow-ups", what: '5 approved WhatsApp templates (missed call, thinking day 1 and 3, class soon, payment check) fired by tags through GHL workflows.' },
  { name: '9am closing coach', what: "Reads yesterday's WhatsApp threads and tells Ariella why leads didn't close, better lines to use, and 3 leads to close today, on Telegram." },
  { name: 'Hot leads sheet + call tracker', what: 'A Google Sheet copy of the hot list, refreshed through the day. Ariella logs call outcomes by hand in dropdowns; a script turns them into a call log.' },
  { name: 'Funnel X-ray', what: 'Rebuilds each lead\'s journey (opted in, replied, engaged, hot, called, reached payment, paid), shows cost per customer per ad and the bottleneck stage in RM.' },
  { name: 'Ad triage (Head of Marketing)', what: 'Grades every ad by wasted money against the account average and proposes kill/scale decisions as Telegram cards to approve. It never touches the ad account.' },
  { name: 'Competitor archive', what: 'Every competitor ad found, a competitor list with USPs and angles, and a research log, per client, on the dashboard.' },
  { name: 'LinkedIn autopilot', what: "Researches on Saturday, writes and fact-checks on Sunday, draws carousel slides and schedules Leo's Tue/Wed/Thu posts in GHL on Monday, with no approval step. Uses only approved facts about Leo plus his wins sheet." },
  { name: 'Jarvis (Telegram bot)', what: 'Answers questions about his numbers, ads, leads and competitors; adds tasks and leads; files receipt photos as expenses (asks first above a threshold); chases overdue invoices as drafts.' },
  { name: 'Claude API meter', what: 'Prices every Claude call and alerts Leo once a day when spend passes US$0.80.' },
  { name: 'Webinar hype-up reminders', what: 'Reminds Ariella to post the WhatsApp community sequence from 5 days before each webinar.' },
  { name: 'AI Library (this)', what: 'Researches real AI case studies Tue–Fri and sends 3 ideas every Saturday.' },
  { name: 'Job search app (separate, private)', what: 'Finds and scores job openings, drafts outreach and runs an apply robot in his browser, with Telegram alerts.' },
  { name: 'Video editing with ChatCut', what: 'Claude edits videos in ChatCut Desktop on the laptop: talking-head ads, splitting testimonial videos, joining seminar footage.' },
  { name: 'Claude Code skills', what: 'A landing-page pipeline (copy, build, design and conversion reviews), LinkedIn post drafting, rebuilding pages inside GHL, and a skill that improves his skills from session notes.' },
]

/** Gaps already known (2026-11-10). Ideas that close one of these are welcome; don't present them as new discoveries. */
export const KNOWN_GAPS = [
  'Call outcomes are typed by hand; nothing turns a call into notes, a next step and a call-back time.',
  'No single health check across all the crons, sheet triggers and batches: each failure alerts on its own, and some failures were only found days later (a lead event that changed, a renamed campaign).',
  'The sales stack (intent judge, hot list, coach, Funnel X-ray) runs for Claude Malaysia only, not the other clients.',
  'No pre-call card for the closer (which ad they clicked, their opt-in answers, last message, a suggested opener).',
]

export const CONSTRAINTS = [
  'Vercel Hobby: 2 cron slots (both used, 8am and 9am Malaysia), 300 seconds per run; more clocks come from Google Sheets Apps Script triggers.',
  'Claude API budget is watched: US$0.80/day alert. Cheaper models need to be tested against the current one before they replace it.',
  'Leo is not a developer; he wants short Telegram messages and plain English.',
  "Client data stays private. Claude Malaysia results need the client's written OK before going in any public post.",
]

/** The setup as one block of text for a prompt. */
export function stackText(): string {
  return [
    WHO,
    '',
    'WHAT ALREADY RUNS:',
    ...STACK.map((s) => `- ${s.name}: ${s.what}`),
    '',
    'KNOWN GAPS:',
    ...KNOWN_GAPS.map((g) => `- ${g}`),
    '',
    'CONSTRAINTS:',
    ...CONSTRAINTS.map((c) => `- ${c}`),
  ].join('\n')
}
