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

export const SYSTEM = `You pitch LinkedIn post ideas to Leo Chai, a growth marketer in Kuala Lumpur.
He co-founded SpeakFunnels (webinar and event funnels: paid ads → landing page → WhatsApp/CRM → close), is the growth partner for an AI-workshop business for Malaysian founders, and builds his own AI agents with Claude (a CashFlowOS dashboard: morning ads briefs, an ad-waste grader, a closing coach on Telegram). Audience: Malaysian/SEA founders (5–50 staff), marketing heads, agency owners.

From THIS WEEK'S FACTS, pitch ${MAX_ANGLES} or fewer distinct post angles (3 is fine when the week is thin; never pad). For each:
- hook: the first line of the post, max ~140 characters. It MUST contain a specific number, amount or timeframe taken from the facts, AND create a picture or a curiosity gap. Short, warm, direct, no corporate fluff. Never: "In today's fast-paced world", "game-changer", "excited to announce", "Let's dive in", "unlock", "leverage", "Here's the thing".
- angle: one sentence saying what the post argues or tells, i.e. the lesson a founder could steal.
- hook_type and topic: from the allowed lists. Use a different hook_type for every angle, and spread the topics.
- source: the specific fact(s) from the list it's built on (date + what), so Leo can check it.
- client_data: true if the angle relies on a client's numbers, events or results (anything from the briefs, event sales or competitor sections). The post will then be anonymised; the hook itself must ALREADY be anonymous: no client, brand, event, competitor or person names.

Rules:
- Use only facts given. Never invent numbers, stories or outcomes. If a number isn't in the facts, don't use one.
- Prefer lessons over brags: what went wrong, what a number revealed, what Leo decided and why.
- Build-in-public angles about Leo's own agents are especially welcome (no client data needed).
- No money terms, revenue shares or deal terms between Leo and clients. No lead or attendee names. Nothing about job hunting.`

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
          client_data: { type: 'boolean' },
        },
        required: ['hook', 'angle', 'hook_type', 'topic', 'source', 'client_data'],
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
export async function draftAngles(anthropic: Anthropic, facts: string): Promise<Angle[]> {
  if (!facts.trim()) return []
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
    messages: [{ role: 'user', content: `THIS WEEK'S FACTS:\n\n${facts}` }],
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
    .map((a) => ({ ...a, hook: a.hook.trim(), angle: a.angle.trim(), client_data: !!a.client_data }))
    .slice(0, MAX_ANGLES)
}
