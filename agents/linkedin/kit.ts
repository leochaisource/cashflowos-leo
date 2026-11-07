// 👉 THIS FILE IS YOURS TO READ — what the LinkedIn autopilot may say about Leo.
//
// The autopilot writes and schedules Leo's posts with nobody reviewing them
// (owner's call, 2026-11-07: "fully automatic, approved facts only"). So it gets
// a closed list, copied from linkedin/profile.md (the laptop kit, the source of
// truth). When Leo adds a result, story or take there, copy it here too:
//   • FACTS: his results, in the exact wording he approved. Nothing else about him.
//   • BUILDS + STORIES: only ones already approved and posted.
//   • TAKES: his opinions.
// Anything not on these lists can't appear, and the code checks back (checks.ts):
// a number in a post must come from FACTS or the verified source page.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE (the dry-run script runs it under plain node).

/** Leo's results, exact wording (profile §2). Peaks always paired with the programme figure. */
export const FACTS = [
  'Webinar funnels: up to 13x ROAS on a single event; typically 4–6x across a full campaign.',
  'Close rates: 44–46% close rate on webinar attendees (two separate programmes).',
  'Short campaign: RM100k revenue from one two-night campaign.',
  'Lead volume: 2,300 leads in three weeks at RM16.87 CPL, 3.22x ROAS (an international summit).',
  'Healthcare: 4,524 enquiries, RM2M+ in sales for a healthcare client.',
  'Loyalty / FMCG: +120% loyalty-programme acquisition; enrolment doubled.',
  "Launch: CPL −50%, landing-page conversion 2x, 4x ROAS for an international trainer's Malaysia launch.",
  'Tech first: the first working Salesforce × MessageBird integration in Asia.',
  'Team ops: marketing-team output +20% in three months through SOPs, QA and workflow redesign.',
  'Award: Agency of the Year 2024, Gold (CRM & Loyalty) and Bronze (Lead Gen). What won it: ideas. The offer had to fit what the market really wanted.',
  '8+ years in performance marketing, CRM and marketing automation.',
]

/** Numbers those facts and builds contain. A post may use these, plus numbers from its verified source. */
export const FACT_NUMBERS = [
  '13', '4', '6', '44', '46', '100', '2300', '16.87', '3.22', '4524', '2', '120', '50', '20', '2024', '8', '3', '0', '52',
]

/** Leo's own systems, built with Claude (he is not an engineer). Describe them only like this. */
export const BUILDS = [
  'The morning brief: at 8am, before he opens his laptop, an AI agent has read the ads in 3 markets and written what changed, what it means and 2 things to do today.',
  'The ad grader: grades every live ad on its real cost per lead and says which to pause, and why.',
  'The follow-up coach: flags leads nobody has replied to yet and suggests the closer\'s next message.',
  'Every agent he builds reports and recommends; a human approves.',
]

/** Approved stories (each already posted with Leo's OK). */
export const STORIES = [
  'The 0 vs 52: his AI morning brief once reported 0 WhatsApp conversations for a client\'s day; there were 52. The agent couldn\'t read the data that morning and said "0" instead of "I don\'t know". His rule since: can\'t read a number, say "unknown", never zero; and list what you couldn\'t check at the bottom of every brief. Never name the client.',
]

/** Leo's takes (profile §3). His two strongest first. Never use the rejected one. */
export const TAKES = [
  'Manual ad targeting is dead. Broad audiences plus strong creative now do the targeting.',
  'Most agencies and marketers work in silos (ads, landing page, emails, WhatsApp, the sales presentation each with a different owner). When congruency fails, the digital experience fails. The journey is broken.',
  'Everyone has AI now. Almost nobody has a system. The bottleneck is setup, not intelligence.',
  'NULL is not zero: a dashboard that says "0" when it couldn\'t read the data is worse than one that admits it doesn\'t know.',
  'Most "lead problems" are follow-up problems. The money is in the WhatsApp chat after the click.',
  'A webinar is a sales room, not a lecture. Teach the "why", sell the "how".',
  "Don't hire for repetitive work you haven't systemised yet. Build the system, then hire.",
  'AI should report and recommend; humans approve.',
  'A great offer with average ads beats perfect ads with a weak offer.',
  'Your AI agents should start working before you do.',
]
export const REJECTED_TAKE = 'judge ads by wasted money, not by cost-per-lead ratio'

/** Phrases Leo never uses (profile §5). Checked in code, case-insensitive. */
export const NEVER_SAY = [
  "in today's fast-paced world", 'game-changer', 'game changer', 'excited to', 'thrilled to', "let's dive in", 'dive in',
  'unlock', 'leverage', 'synergy', "here's the thing", 'let that sink in', 'agree?', '10x your',
]

/** Never in a post: job hunting, private terms, links (checked in code). */
export const NEVER_TOPICS = [
  'open to work', 'my next role', 'next chapter', 'job search', 'looking for a role', 'looking for my next', 'new opportunity',
  'hire me', 'salary', 'revenue share', 'dm me', 'book a call', 'free audit', 'link in bio', 'comment below with',
]

/** People and businesses that must never be named (clients, the team). Competitor and project names are added at run time. */
export const NEVER_NAME = ['Claude Malaysia', 'Kingsley', 'Ariella', 'Starcity', 'Prominds', 'Nicsman', 'Energivity', 'SF Media', 'Mr Money']

export const HOOK_TYPES = ['number', 'story', 'contrarian', 'secret', 'before-after', 'list', 'mistake', 'question', 'trend', 'build'] as const
export const TOPICS = ['ai-for-owners', 'funnels-webinars', 'paid-ads', 'crm-follow-up', 'build-in-public', 'founder-lessons', 'malaysian-market'] as const

/** Who Leo is, for the writer. */
export const WHO = `Leo Chai, growth and performance marketing leader in Kuala Lumpur. Co-founder & Head of Growth Marketing at SpeakFunnels (webinar and event funnels: paid ads → landing page → WhatsApp/CRM follow-up → close). Growth partner for an AI-workshop business for Malaysian founders (never name it). Before: co-founder & strategy director of Edense; lead digital marketer at BrandSight Digital (never name its clients). He builds AI agents with Claude and is not an engineer. Because he builds with Claude and partners with a Claude-focused workshop business, never frame Claude or Anthropic negatively, and don't write posts about AI vendors' pricing disputes, outages or bans.
LinkedIn goal: career and reputation. Readers are marketing leaders, founders, C-level people and recruiters in growth marketing, then Malaysian/SEA founders. Every post should read like the thinking of a senior operator who has run real budgets and built systems.`

export const VOICE = `Voice: short, warm, direct, no corporate fluff. An operator, not a guru. Honest about trade-offs. First person; present tense for opinions, past tense for stories.
Shape: short lines (rarely over 15 words), one idea per line, a blank line between beats. 120–250 words. Malaysian context is welcome (ringgit, KL, WhatsApp-first buyers); Bahasa/Manglish at most one word.
0–2 emoji (never as bullets), 0–3 hashtags at the very end (or none), no links in the body, no em-dash chains.
Hook (lines 1–2, together about 140 characters or less): must contain a specific number, amount or timeframe AND a picture or a curiosity gap.
End with ONE genuine question to readers, then a final line "Source: <publisher or person>, <date>". No sales CTA, no "DM me", no offers.`

/** Two posts Leo approved (2026-10-21), as the bar for voice and shape. */
export const EXAMPLES = [
  `Anthropic's CEO: if AI does 90% of a job, the last 10% becomes the whole job.
In my funnels, that 10% is the gap between 4x and 13x ROAS.

Dario Amodei said it in May, on stage with Jamie Dimon.
His point: the 10% doesn't shrink. It expands.

Then companies choose.
Do the same work with fewer people.
Or do more with the same people, which takes creativity.

Here's what that looks like in marketing.

AI already carries a lot of my volume.
The morning ads report. Grading every ad. Chasing follow-ups.

None of that decided our best result.

One event hit 13x ROAS.
Across a full campaign, we typically land at 4–6x.

The ad platforms were the same.
The difference sat in the 10%:

→ The offer. Does it fit what the market wants right now?
→ The story. Why this, why now.
→ The room. A webinar is a sales room, not a lecture.

AI can write 50 headlines in a minute.
It can't tell you which promise your market is ready to believe.

So I've stopped asking "what can AI do for me?"
I ask "what's my 10%, and am I spending my week on it?"

What's the 10% of your job that AI is making more valuable?

Source: Fortune, 5 May 2026`,
  `3 things I'd steal from Grab's Q1 2026 results.
Its AI assistant drove a 15% GMV uplift for engaged merchants. That's not #1.

About half of Grab's active merchants now use that assistant.
Good number. But these 3 ideas matter more for marketers in our region.

1. Measure against the people who didn't adopt.
Drivers using Grab's Turbo feature saw a 23% uplift in earnings per online hour, against drivers who haven't adopted it.
That's a comparison, not a testimonial.

2. Let customers buy without a meeting.
Average spend per advertiser on Grab's self-serve ad platform grew 44% year on year.

3. Build pages for AI, not only for people.
Grab is investing in Generative Engine Optimization.
It launched web pages designed to be discovered by AI.

For Malaysian marketers, #3 is the one to start now.

When a buyer asks an AI assistant "which workshop should I join?",
is your page in the answer?

Which of the three would move your numbers first?

Source: Grab Q1 2026 Earnings Prepared Remarks, 5 May 2026`,
]
