import type Anthropic from '@anthropic-ai/sdk'
// Explicit .ts extensions: shared with scripts/linkedin-autopilot-dry-run.ts (Node type stripping).
import type { DraftPost } from './checks.ts'

// 🔒 VERIFY — a second, separate Claude call opens the post's source page and
// checks every statement the post makes about it, the way Leo's rule says
// ("open the URL and use its numbers exactly"). It reads the WHOLE post, not just
// the writer's own list of claims, so a claim the writer forgot to list is still
// caught. Any statement the page doesn't support drops the post. Fetching is
// limited to the source's own site.

export const VERIFY_MODEL = 'claude-opus-5-5'

const SYSTEM = `You fact-check a LinkedIn post against its one cited source before it publishes automatically, with no human review.

1. Fetch the source URL with web_fetch. Only that page (or a page it redirects to on the same site).
2. Read the post. Find EVERY statement it makes about the source or the people and companies in it: each number, who said or did what, where and when, job titles, quoted words, and the "Source:" line's publisher and date. Statements about Leo himself (his results, his agents, his opinions) are not yours to check; skip them.
3. For each statement decide: does the page support it exactly? Same number, same unit, same meaning, same person. "Up to", "about", "average", "per person" matter. A quote must appear word for word. If the page says something weaker or different, it is NOT supported.
4. For each statement, copy the excerpt from the page that supports it (or comes closest), word for word, at most 40 words.
5. Judge the source itself. reputable = true only for: a major news organisation (Reuters, Bloomberg, FT, WSJ, CNBC, Fortune, The Economist, BBC, major national papers), the company's or person's own page (newsroom, blog, investor documents, transcript), or an established research firm, consultancy, analyst or university. A blog, newsletter or aggregator retelling someone else's reporting is NOT reputable, even if what it says is true. A page that republishes a reputable outlet's full article under that outlet's byline (e.g. a Reuters story on Yahoo Finance or Investing.com) counts as that outlet.

Be strict. When in doubt, mark it unsupported: an unsupported statement only means the post isn't published.`

const SCHEMA = {
  type: 'object',
  properties: {
    fetched: { type: 'boolean' },
    page: { type: 'string' }, // publisher, title and date as the page shows them
    reputable: { type: 'boolean' },
    reputable_why: { type: 'string' },
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          supported: { type: 'boolean' },
          excerpt: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['statement', 'supported', 'excerpt', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['fetched', 'page', 'reputable', 'reputable_why', 'statements'],
  additionalProperties: false,
} as const

export type Verification = { ok: boolean; problems: string[]; excerpts: string[]; page: string }

/** Check one post against its source page. Never throws for a content problem; returns ok=false with reasons. */
export async function verifyPost(anthropic: Anthropic, post: DraftPost): Promise<Verification> {
  let host = ''
  try {
    host = new URL(post.source_url).hostname.replace(/^www\./, '')
  } catch {
    return { ok: false, problems: ['source URL is not a valid link'], excerpts: [], page: '' }
  }
  const messages: any[] = [
    {
      role: 'user',
      content:
        `SOURCE URL: ${post.source_url}\n\n` +
        `THE POST:\n${post.body}\n\n` +
        `THE WRITER'S OWN LIST OF CLAIMS (check these too, but don't trust it to be complete):\n${post.claims.map((c) => `- ${c}`).join('\n')}`,
    },
  ]
  let text = ''
  // A server tool can pause a long turn (stop_reason "pause_turn"): send it back to continue.
  for (let round = 0; round < 3; round++) {
    const params = {
      model: VERIFY_MODEL,
      max_tokens: 12000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, allowed_domains: [host] }],
      system: SYSTEM,
      messages,
    }
    // Same cast as prompt.ts: `fallbacks` and this tool version are newer than this SDK's types.
    const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
    if (res.stop_reason === 'refusal') return { ok: false, problems: ['the checker declined to read this source'], excerpts: [], page: '' }
    text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (res.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: res.content })
  }
  let v: { fetched?: boolean; page?: string; reputable?: boolean; reputable_why?: string; statements?: { statement: string; supported: boolean; excerpt: string; why: string }[] }
  try {
    v = JSON.parse(text)
  } catch {
    return { ok: false, problems: ['the checker gave no readable answer'], excerpts: [], page: '' }
  }
  const statements = v.statements ?? []
  const problems: string[] = []
  if (!v.fetched) problems.push(`couldn't open the source page (${host})`)
  else if (!v.reputable) problems.push(`source isn't reputable enough (${host}: ${(v.reputable_why ?? '').slice(0, 140)})`)
  if (!statements.length) problems.push('the checker found no statement to check')
  for (const s of statements) if (!s.supported) problems.push(`not supported by the source: "${s.statement.slice(0, 120)}" (${s.why.slice(0, 160)})`)
  return { ok: problems.length === 0, problems, excerpts: statements.map((s) => s.excerpt).filter(Boolean), page: v.page ?? '' }
}
