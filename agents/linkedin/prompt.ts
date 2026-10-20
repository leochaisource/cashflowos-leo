import type Anthropic from '@anthropic-ai/sdk'
// Explicit .ts extension: shared with scripts/linkedin-ideas-dry-run.ts (Node type stripping).
import { MAX_ANGLES, type Angle } from './definition.ts'

// 👉 SUGGEST — the words. One Claude call turns the week's facts (load.ts) into
// 3–5 LinkedIn ANGLES for Leo: a hook + one line each. Not posts — the posts are
// written with Leo in the /linkedin-posts skill, from linkedin/profile.md, where
// his stories and his approval live. Keeping this to angles is deliberate: a
// Telegram card is a menu, and a 250-word draft on a phone is homework.

// The hook gate and voice, condensed from linkedin/hooks.md + linkedin/profile.md
// (the skill holds the full versions; this is what a menu needs).
const HOOK_TYPES = ['number', 'story', 'contrarian', 'secret', 'before-after', 'list', 'mistake', 'question', 'trend', 'build'] as const
const TOPICS = ['ai-for-owners', 'funnels-webinars', 'paid-ads', 'crm-followup', 'build-in-public', 'founder-lessons', 'malaysia-market'] as const

export const SYSTEM = `You pitch LinkedIn post ideas to Leo Chai, a senior growth and performance marketing leader in Kuala Lumpur.
He co-founded SpeakFunnels (webinar and event funnels: paid ads → landing page → WhatsApp/CRM → close), is the growth partner for an AI-workshop business for Malaysian founders, and builds his own AI agents with Claude (a CashFlowOS dashboard: morning ads briefs, an ad-waste grader, a closing coach on Telegram).
His LinkedIn goal is career and reputation: every angle should read like the thinking of someone who has run real budgets, built systems and can explain why things work.
Audience, first: marketing leaders, founders and C-level people who hire or partner with growth marketers; recruiters and hiring managers in growth and performance marketing; industry peers. Second: Malaysian/SEA founders and business owners (5–50 staff).

You get two inputs: THIS WEEK'S FACTS (Leo's own business week) and a RESEARCH BRIEF (sourced items from the outside world: world AI leaders, AI-forward companies, reputable research, and what top LinkedIn creators are discussing).

Post style (owner's call, 2026-10-20): every angle stands on EVIDENCE from the research brief (a study, a leader's statement or a company's documented AI workflow), then connects it to Leo's real work when it honestly fits:
- Pick a topic that is live among top creators or in the news (the brief says what), not a topic only Leo's week produced.
- Back it with one researched item that has a source URL. Prefer a specific number.
- Connect to Leo: one of his real results (below) or a fact from this week, ONLY when it genuinely relates. If nothing fits, make it a "3 (or 5) things I learned from [leader / company / study]" angle instead. Never stretch a connection.
Leo's real results you may use (exact wording; never others): webinar funnels up to 13x ROAS on a single event, typically 4–6x across a campaign; 44–46% close rate on webinar attendees; RM100k revenue from one two-night campaign; 2,300 leads in three weeks at RM16.87 CPL; Agency of the Year 2024 Gold (CRM & Loyalty); he built an AI morning brief that reads 3 ad markets daily and an AI system that drafts and schedules his LinkedIn. His stance: AI is great at analysing structured data and mass production; humans own emotion, trust, conversion and decisions.

Pitch ${MAX_ANGLES} or fewer distinct post angles (3 is fine when the inputs are thin; never pad). For each:
- hook: the first line of the post, max ~140 characters. It MUST contain a specific number, amount or timeframe taken from the inputs, AND create a picture or a curiosity gap. Short, warm, direct, no corporate fluff. Never: "In today's fast-paced world", "game-changer", "excited to announce", "Let's dive in", "unlock", "leverage", "Here's the thing".
- angle: one sentence saying what the post argues or tells, i.e. the lesson or the thinking a marketing leader would respect.
- hook_type and topic: from the allowed lists. Use a different hook_type for every angle, and spread the topics.
- source: the specific item(s) it's built on (date + what), so Leo can check it.
- evidence: the researched item backing it, as "Publisher/person, title or study, year" (e.g. "McKinsey, The State of AI, 2025"). Empty only if the research brief was empty.
- evidence_url: the exact URL of that item from the brief (copy it, never construct one). Empty only if evidence is empty.
- leo_link: one short line naming which of Leo's real results or this week's facts it connects to, or "none — things-I-learned format".
- client_data: true if the angle relies on a client's numbers, events or results (anything from the briefs, event sales or competitor sections of THIS WEEK'S FACTS). The post will then be anonymised; the hook itself must ALREADY be anonymous: no client, brand, event, competitor or person names. (Public figures and companies from the research brief may be named.)

Rules:
- Use only facts given. Never invent numbers, stories or outcomes. If a number isn't in the facts, don't use one. Never claim a cause the facts don't state: a brief recommending something is not proof it was done, or that it moved a number.
- Lessons and thinking come before brags: what went wrong, what a number revealed, what Leo decided and why.
- Especially welcome, when a fact from the list supports it (never invent an example to fit one):
  - build-in-public angles about Leo's own agents (no client data needed);
  - Leo's own opinion: "Manual ad targeting is dead.";
  - Leo's own opinion: "Most agencies/marketers work in silos (ads, landing page/funnel/website, emails, WhatsApp, presentation separated). When congruency fails, the customer journey breaks."
- No sales CTAs: no "DM me", free audits, offers or "book a call". The post builds Leo's reputation; it doesn't sell.
- RECENT LINKEDIN POSTS (if listed) is what Leo already posted or has queued. Don't pitch an angle that repeats one of them: not the same story, number or lesson, and no hook that reads like one already used. Lean toward topics those posts haven't covered.
- No money terms, revenue shares or deal terms between Leo and clients. No lead or attendee names. Nothing about job hunting, and no hint that Leo is looking for a role.`

const SCHEMA = {
  type: 'object',
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hook: { type: 'string' },
          angle: { type: 'string' },
          hook_type: { type: 'string', enum: [...HOOK_TYPES] },
          topic: { type: 'string', enum: [...TOPICS] },
          source: { type: 'string' },
          evidence: { type: 'string' },
          evidence_url: { type: 'string' },
          leo_link: { type: 'string' },
          client_data: { type: 'boolean' },
        },
        required: ['hook', 'angle', 'hook_type', 'topic', 'source', 'evidence', 'evidence_url', 'leo_link', 'client_data'],
        additionalProperties: false,
      },
    },
  },
  required: ['angles'],
  additionalProperties: false,
} as const

export const MODEL = 'claude-opus-5-5'

/**
 * One call → up to MAX_ANGLES angles. Throws on API errors (the caller decides
 * whether that's a log line or a crash). An empty week returns [] without a call.
 */
export async function draftAngles(anthropic: Anthropic, facts: string, research = ''): Promise<Angle[]> {
  if (!facts.trim() && !research.trim()) return []
  const input =
    `THIS WEEK'S FACTS:\n\n${facts.trim() || '(nothing this week)'}\n\n` +
    `RESEARCH BRIEF (sourced, with URLs):\n\n${research.trim() || '(research unavailable this week; use the facts only and leave evidence empty)'}`
  const params = {
    model: MODEL,
    max_tokens: 8000,
    // Server-side fallback on a policy decline (routes by category; no model list to maintain).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Reading a short list of facts and pitching a menu: low effort keeps it fast
    // enough for the daily cron's 60s budget.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: input }],
  }
  // `fallbacks` is newer than this SDK's types; the API accepts it on the beta endpoint.
  const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
  if (res.stop_reason === 'refusal') return []
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`LinkedIn ideas: model returned non-JSON (stop_reason ${res.stop_reason})`)
  }
  const angles: Angle[] = Array.isArray(parsed?.angles) ? parsed.angles : []
  return angles
    .filter((a) => a && typeof a.hook === 'string' && a.hook.trim() && typeof a.angle === 'string')
    .map((a) => ({
      ...a,
      hook: a.hook.trim(),
      angle: a.angle.trim(),
      // A URL the brief didn't contain is a made-up URL: drop it rather than send it to Leo.
      evidence_url: /^https?:\/\//.test(a.evidence_url ?? '') && research.includes(a.evidence_url ?? '') ? a.evidence_url : '',
      client_data: !!a.client_data,
    }))
    .slice(0, MAX_ANGLES)
}
