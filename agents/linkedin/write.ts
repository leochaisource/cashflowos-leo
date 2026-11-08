import type Anthropic from '@anthropic-ai/sdk'
// Explicit .ts extensions: shared with scripts/linkedin-autopilot-dry-run.ts (Node type stripping).
import type { DraftPost } from './checks.ts'
import { BUILDS, EXAMPLES, FACTS, HOOK_TYPES, REJECTED_TAKE, STORIES, TAKES, TOPICS, VOICE, WHO } from './kit.ts'

// 👉 WRITE — the autopilot's writer. One Claude call turns the week's research
// brief into finished posts, each with its carousel and photo searches. It asks
// for two spare posts, because checks.ts and verify.ts drop any post that isn't
// perfect (in the first test, 2 of 3), and a dropped post leaves a slot empty
// rather than going out wrong.

export const WRITE_MODEL = 'claude-opus-5-5'

const SYSTEM = `You write LinkedIn posts for ${WHO}

These posts publish automatically, with no human review. Accuracy beats flair: one wrong number or invented story damages Leo's reputation.

${VOICE}

THE POST STYLE (Leo, 2026-10-20): research-backed.
- Each post stands on ONE item from the RESEARCH BRIEF: a study, a leader's statement or a company's documented AI workflow. Use its numbers exactly as the brief gives them. Copy its URL exactly from the brief into source_url (never construct one). Use a different item for each post.
- Connect to Leo only through the lists below, and only when it genuinely fits. Otherwise write a "3 things I learned from [leader / company / study]" post: the takeaways are the post.
- Lead with the thinking a marketing leader would respect: what the evidence means, what to do differently. Not news for its own sake.
- Never invent a story, client, number, result, quote or detail about Leo. If it isn't in the lists, it doesn't exist.
- Quotes: only words the brief marks as the source's own; at most 12 words each. List every such quote in source_quotes, exactly as written in the post.
- claims: list every statement the post makes about the source (each number, who said it, where and when, any quote), one per line, so a checker can verify each against the page.
- Last line of the body: "Source: <publisher or person>, <date>". Give the date exactly as the brief does; if the brief's date is approximate ("about", "week of") or missing, give only the month and year ("Oct 2026"). The link goes in the first comment, which the system adds.
- The source must be reputable and first-hand: a major news organisation, the company's or person's own page, or an established research firm, consultancy or university. Skip items from blogs, newsletters or aggregators retelling someone else's reporting.
- Prefer brief items whose page is openly readable (newsrooms, news sites, company or investor pages). A checker must open the page; pages behind logins or bot walls (gartner.com is one) can't be checked and the post is dropped.

WHAT YOU MAY SAY ABOUT LEO (nothing else):
Results, exact wording, peaks always paired with the programme-level figure:
${FACTS.map((f) => `- ${f}`).join('\n')}
His own systems:
${BUILDS.map((f) => `- ${f}`).join('\n')}
Approved stories:
${STORIES.map((f) => `- ${f}`).join('\n')}
His takes (opinions, use freely):
${TAKES.map((f) => `- ${f}`).join('\n')}
Never use this rejected take: "${REJECTED_TAKE}".
Leo's own notes (under LEO'S OWN NOTES in the input, from his "wins and stories" sheet) count as approved too: he wrote each one. Use only what a note says, keep its numbers exactly as written, and add no cause, outcome or detail it doesn't state. Anonymise any client, company or person a note names. When a note genuinely fits a research item, use it to connect that post to Leo, and prefer fresh notes over ones marked as used; if any unused note fits, make at least one post this week draw on it. List the ids of the notes a post uses in leo_notes_used (empty if none).
Never name a client, a competitor, a lead, an attendee or Leo's team; say "a healthcare client", "an AI-workshop business". Never mention job hunting, salaries, deal terms or his education. Brand, if one must be named: SpeakFunnels ("That's why I build…", never "at SpeakFunnels we…").

THE CAROUSEL (each post becomes a swipeable PDF on LinkedIn):
- cover: tag (2–4 words, e.g. "AI & the customer journey"), l1 + l2 (the hook as a 2-line headline, each ≤ 32 characters), sub (one line from the post, ≤ 110 characters).
- slides: 4–6 inner slides, one beat each, using ONLY lines already in the post. The first is the evidence slide: label "The evidence", big = the key number (≤ 8 characters, e.g. "51%", "US$75B+"), h = what the number is, b = one line plus "Source: …". Others: label (2–5 words), h (≤ 60 characters), b (1–3 lines, each ≤ 120 characters). Set big to "" when a slide has no number.
- q: the post's closing question, ≤ 100 characters.
- image_queries: Pexels stock-photo searches. cover: one search for a moody, uncluttered scene that shows the hook's idea (no people's faces, no brands). inner: exactly 3 searches for background scenes (objects, places, textures; no faces, no logos, no screens with text).

ROTATION: give each post a different hook_type and topic, avoid the hook types and topic listed under ROTATION in the input, and don't repeat a story, number or lesson from RECENT LINKEDIN POSTS. Order the posts as they should go out.`

const SLIDE = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    big: { type: 'string' },
    h: { type: 'string' },
    b: { type: 'array', items: { type: 'string' } },
  },
  required: ['label', 'big', 'h', 'b'],
  additionalProperties: false,
} as const

const SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', enum: [...TOPICS] },
          hook_type: { type: 'string', enum: [...HOOK_TYPES] },
          body: { type: 'string' },
          source_url: { type: 'string' },
          source_quotes: { type: 'array', items: { type: 'string' } },
          claims: { type: 'array', items: { type: 'string' } },
          leo_link: { type: 'string' },
          leo_notes_used: { type: 'array', items: { type: 'string' } },
          carousel: {
            type: 'object',
            properties: {
              cover: {
                type: 'object',
                properties: { tag: { type: 'string' }, l1: { type: 'string' }, l2: { type: 'string' }, sub: { type: 'string' } },
                required: ['tag', 'l1', 'l2', 'sub'],
                additionalProperties: false,
              },
              slides: { type: 'array', items: SLIDE },
              q: { type: 'string' },
            },
            required: ['cover', 'slides', 'q'],
            additionalProperties: false,
          },
          image_queries: {
            type: 'object',
            properties: { cover: { type: 'string' }, inner: { type: 'array', items: { type: 'string' } } },
            required: ['cover', 'inner'],
            additionalProperties: false,
          },
        },
        required: ['topic', 'hook_type', 'body', 'source_url', 'source_quotes', 'claims', 'leo_link', 'leo_notes_used', 'carousel', 'image_queries'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts'],
  additionalProperties: false,
} as const

export type WrittenPost = DraftPost & { leo_link: string; leo_notes_used?: string[]; image_queries: { cover: string; inner: string[] } }

/** One of Leo's own notes as the writer sees it (sources.ts, minus the private client name). */
export type WriterNote = { id: string; date: string; type: string; text: string; numbers: string; usedOn?: string }

/** Write `count` posts (the caller asks for one more than it needs). Throws on API errors. */
export async function writePosts(
  anthropic: Anthropic,
  args: { count: number; research: string; facts: string; avoidHookTypes: string[]; avoidTopic: string | null; days: string[]; notes?: WriterNote[] },
): Promise<WrittenPost[]> {
  const notes = (args.notes ?? []).map(
    (n) =>
      `[${n.id}] ${n.date || 'undated'}${n.type ? ` · ${n.type}` : ''}: ${n.text}${n.numbers ? ` (numbers: ${n.numbers})` : ''}` +
      `${n.usedOn ? ` [used in the post of ${n.usedOn}: reuse only with a new angle]` : ''}`,
  )
  const input =
    `Write ${args.count} posts, in posting order, each on a different brief item. They go out on: ${args.days.join(', ')} (the extra ones are spares).\n\n` +
    `ROTATION: avoid hook types ${args.avoidHookTypes.join(', ') || '(none)'}; the first post must not use topic ${args.avoidTopic ?? '(none)'}.\n\n` +
    `RESEARCH BRIEF (sourced, with URLs):\n\n${args.research.trim()}\n\n` +
    `LEO'S OWN NOTES (newest first; approved by him):\n\n${notes.join('\n') || '(none yet)'}\n\n` +
    `LEO'S WEEK AND RECENT POSTS:\n\n${args.facts.trim() || '(nothing this week)'}\n\n` +
    `Two posts Leo approved, as the bar for voice and shape:\n\n${EXAMPLES.map((e, i) => `--- Example ${i + 1} ---\n${e}`).join('\n\n')}`
  const params = {
    model: WRITE_MODEL,
    max_tokens: 16000,
    // Server-side fallback on a policy decline (routes by category; no model list to maintain).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: input }],
  }
  // `fallbacks` is newer than this SDK's types; the API accepts it on the beta endpoint.
  const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
  if (res.stop_reason === 'refusal') throw new Error('the writer declined this week\'s brief')
  if (res.stop_reason === 'max_tokens') throw new Error('the writer ran out of room (max_tokens)')
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const parsed = JSON.parse(text) as { posts?: WrittenPost[] }
  return (parsed.posts ?? [])
    .map((p) => ({
      ...p,
      body: p.body.trim(),
      leo_notes_used: (p.leo_notes_used ?? []).filter((id) => (args.notes ?? []).some((n) => n.id === id)),
      // A URL the brief didn't contain is a made-up URL.
      source_url: args.research.includes(p.source_url.trim()) ? p.source_url.trim() : '',
      carousel: { ...p.carousel, slides: p.carousel.slides.map((s) => ({ ...s, big: s.big?.trim() || undefined })) },
    }))
    .slice(0, args.count)
}
