import type Anthropic from '@anthropic-ai/sdk'

// 👉 RESEARCH — the outside world. Before the angles are pitched, one Claude call
// with web search gathers 6–8 recent, sourced items, so every Sunday idea can
// stand on something bigger than Leo's own week (owner's call, 2026-10-20):
//   • what the world's AI leaders are saying, and how AI-forward companies are
//     changing real workflows;
//   • research from reputable parties (consultancies, analysts, universities,
//     platform research arms);
//   • what top LinkedIn creators in growth marketing and AI-in-business are
//     talking about — as topic reference only, never to copy.
// The output is a plain-text brief with a URL on every item; prompt.ts turns it
// plus the week's facts into angles. If this step fails, the angles still go out
// from the week's facts alone (run.ts notes it).

// Who and what to watch. Edit freely; the search is not limited to these.
export const LEADERS = [
  'Dario Amodei (Anthropic)',
  'Sam Altman (OpenAI)',
  'Jensen Huang (NVIDIA)',
  'Satya Nadella (Microsoft)',
  'Sundar Pichai (Google)',
  'Demis Hassabis (Google DeepMind)',
  'Alexandr Wang (Scale AI founder; Meta)',
  'Mustafa Suleyman (Microsoft AI)',
  'Andrew Ng',
  'Andrej Karpathy',
  'Fei-Fei Li',
  'Ethan Mollick (Wharton)',
]
export const COMPANIES = [
  'Shopify',
  'Klarna',
  'Duolingo',
  'JPMorgan Chase',
  'Walmart',
  'Amazon',
  'Microsoft',
  'Salesforce',
  'Unilever',
  'Coca-Cola',
  "L'Oréal",
  'Morgan Stanley',
  'DBS Bank',
  'Grab',
]
export const RESEARCH_SOURCES =
  'McKinsey, BCG, Bain, Deloitte, Gartner, Forrester, IDC, Stanford HAI (AI Index), MIT Sloan, Harvard Business Review, ' +
  "the LinkedIn B2B Institute, Nielsen, Google/Think with Google, Meta, HubSpot and Salesforce research reports, Microsoft's Work Trend Index"

const SYSTEM = `You are a research assistant for Leo Chai, a senior growth and performance marketing leader in Kuala Lumpur who builds AI agents for marketing. You find source material for his LinkedIn posts.

Search the web and return 6–8 items, newest first, published in the last 30 days where possible (older only for a landmark study). Mix three kinds:
1. LEADERS & COMPANIES: a concrete statement, memo, interview or move by a world AI leader, or a documented change in how a large company uses AI in its workflows, ideally with a number (people, time, cost, output). Watch especially: ${LEADERS.join('; ')}; companies: ${COMPANIES.join(', ')}.
2. RESEARCH: a study or survey with a specific statistic, from a reputable party such as ${RESEARCH_SOURCES}. Prefer marketing, sales, customer experience, B2B buying and AI adoption at work.
3. CREATOR TOPICS: what top LinkedIn creators in growth marketing and AI-in-business are writing about this month (topic and format only, as a trend signal; never their wording).

For every item output exactly this block:
- kind: leader | company | research | creator-topic
- what: one or two sentences, paraphrased (no quotes longer than 12 words)
- number: the key number with its unit, or "none"
- source: publisher / person, and the date
- url: the exact URL you read it on

Rules: only report what a source you opened actually says. Never invent a number, a quote, a role or a date. If you can't verify something, leave it out. Plain text only, no preamble.`

export const RESEARCH_MODEL = 'claude-opus-5-5'

/** One web-searching call → a sourced research brief (plain text), or '' if nothing usable came back. */
export async function researchBrief(anthropic: Anthropic, now: Date): Promise<string> {
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  const messages: any[] = [
    { role: 'user', content: `Today is ${today} (Malaysia). Find this week's items for Leo's LinkedIn research brief.` },
  ]
  let text = ''
  // Server tools can pause a long turn (stop_reason "pause_turn"): send it back to continue.
  for (let round = 0; round < 3; round++) {
    const params = {
      model: RESEARCH_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      system: SYSTEM,
      messages,
    }
    // Same cast as prompt.ts: `fallbacks` and this tool version are newer than this SDK's types.
    const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
    if (res.stop_reason === 'refusal') return ''
    text += res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (res.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: res.content })
  }
  // A brief without a single URL can't back an angle; treat it as no research.
  return /https?:\/\//.test(text) ? text.trim() : ''
}
