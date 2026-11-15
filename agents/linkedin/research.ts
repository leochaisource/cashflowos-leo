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

/** Sites the source checker (verify.ts) can't open: bot walls. Past weeks add more (autopilot.ts). */
export const UNREADABLE_HOSTS = ['gartner.com']

const system = (avoidHosts: string[]) => `You are a research assistant for Leo Chai, a senior growth and performance marketing leader in Kuala Lumpur who builds AI agents for marketing. You find source material for his LinkedIn posts.

Search the web and return 6–8 items, newest first, published in the last 30 days where possible (older only for a landmark study). Mix three kinds:
1. LEADERS & COMPANIES: a concrete statement, memo, interview or move by a world AI leader, or a documented change in how a large company uses AI in its workflows, ideally with a number (people, time, cost, output). Watch especially: ${LEADERS.join('; ')}; companies: ${COMPANIES.join(', ')}.
2. RESEARCH: a study or survey with a specific statistic, from a reputable party such as ${RESEARCH_SOURCES}. Prefer marketing, sales, customer experience, B2B buying and AI adoption at work.
3. CREATOR TOPICS: what top LinkedIn creators in growth marketing and AI-in-business are writing about this month (topic and format only, as a trend signal; never their wording).
A post can only stand on kinds 1 and 2, so spend your searches on those first; creator topics only if searches are left over.

For every item output exactly this block:
- kind: leader | company | research | creator-topic
- what: one or two sentences, paraphrased (no quotes longer than 12 words)
- number: the key number with its unit, or "none"
- source: publisher / person, and the date
- firsthand: yes | no. "yes" only when the url is the original: the company's or person's own page, the research firm's own report or press release, or a major news organisation's own reporting (or its full article republished under its byline). "no" when the page retells someone else's work (a blog, newsletter, trade site or aggregator); then say who published the original.
- url: the exact URL you read it on

A post can only use a first-hand page: when you find a retelling, look for the original and give that instead. Prefer pages anyone can open without a login, paywall or bot wall (newsrooms, news sites, company and investor pages): every item is checked against its page by an automated reader, and an unreadable page can't be used. The reader can't open these sites, so never use them: ${avoidHosts.join(', ') || '(none known)'}. Give the page's publication date exactly; if you can't see one, say "date not shown".

Rules: only report what a source you opened actually says. Never invent a number, a quote, a role or a date. If you can't verify something, leave it out. Plain text only, no preamble.`

export const RESEARCH_MODEL = 'claude-opus-5-5'

// ---------------------------------------------------------------- the quality gate
// The writer may only stand a post on a first-hand, openly readable page (write.ts), so
// a brief is only as good as its items that pass those rules. Plain code, no AI: W47's
// brief had 7 items but only 3 the writer could use (two gartner.com, a salesforce.com
// page the checker couldn't open, two retellings), and all three posts were dropped.

/** Items the writer needs: a post for each of the 3 slots plus its 2 spares. */
export const MIN_USABLE = 5

export type BriefItem = { kind: string; what: string; source: string; firsthand: string; url: string; host: string }
export type BriefGrade = { items: BriefItem[]; usable: BriefItem[]; unusable: { item: BriefItem; why: string }[] }

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}
const onHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`))

// Sites that only ever retell: a post can't stand on them, whatever the item says.
const RETELLING_HOSTS = ['substack.com', 'medium.com', 'beehiiv.com', 'linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'reddit.com', 'youtube.com']
// Major news organisations: their reporting on someone else's study still counts as first-hand.
// Only consulted for a brief written before the "firsthand" line existed.
const MAJOR_NEWS = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'fortune.com', 'economist.com', 'bbc.com', 'bbc.co.uk',
  'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'apnews.com', 'axios.com', 'techcrunch.com', 'theverge.com',
  'wired.com', 'businessinsider.com', 'cnn.com', 'nikkei.com', 'scmp.com', 'straitstimes.com', 'channelnewsasia.com',
  'thestar.com.my', 'nst.com.my', 'theedgemalaysia.com', 'thenationalnews.com', 'investing.com', 'finance.yahoo.com',
]

/** Split a brief into its "- kind: …" blocks. Anything else (preamble, notes) is ignored. */
export function parseBrief(text: string): BriefItem[] {
  const items: BriefItem[] = []
  let cur: Record<string, string> | null = null
  const flush = () => {
    if (cur) {
      const url = (cur.url ?? '').match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,;]+$/, '') ?? ''
      items.push({ kind: (cur.kind ?? '').toLowerCase(), what: cur.what ?? '', source: cur.source ?? '', firsthand: cur.firsthand ?? '', url, host: hostOf(url) })
    }
  }
  for (const line of text.split('\n')) {
    // An item's first line can arrive glued to the model's preamble ("…Now research.- kind: company").
    const m = line.match(/^\s*-\s*(kind|what|number|source|firsthand|url)\s*:\s*(.*)$/i) ?? line.match(/-\s*(kind)\s*:\s*(\S.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'kind') {
      flush()
      cur = {}
    }
    if (cur) cur[key] = m[2].trim()
  }
  flush()
  return items
}

/**
 * Which brief items the writer can use, by its own source rules: a leader, company or research
 * item (not a creator trend), on a first-hand page, on a site the checker can open, not already
 * the source of a recent post. `unreadable` and `usedUrls` come from past weeks (autopilot.ts).
 */
export function gradeBrief(text: string, opts: { unreadable: string[]; usedUrls: string[] }): BriefGrade {
  const items = parseBrief(text)
  const usable: BriefItem[] = []
  const unusable: { item: BriefItem; why: string }[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const fh = item.firsthand.toLowerCase()
    const why = !['leader', 'company', 'research'].includes(item.kind)
      ? 'a creator trend, not a source a post can stand on'
      : !/^https:\/\//.test(item.url) || !item.host
        ? 'no usable link'
        : seen.has(item.url)
          ? 'listed twice'
          : onHost(item.host, opts.unreadable)
            ? `the checker can't open ${item.host}`
            : opts.usedUrls.includes(item.url)
              ? 'already the source of a recent post'
              : onHost(item.host, RETELLING_HOSTS) || fh.startsWith('no')
                ? `second-hand (${item.firsthand.replace(/^no[.:,;\s-]*/i, '') || item.host})`
                : !fh && /\((citing|reporting|via|summari[sz]ing|according to)\b|\b(roundup|newsletter)\b/i.test(item.source) && !onHost(item.host, MAJOR_NEWS)
                  ? `second-hand (${item.source})`
                  : ''
    if (item.url) seen.add(item.url)
    if (why) unusable.push({ item, why })
    else usable.push(item)
  }
  return { items, usable, unusable }
}

/** A second search, aimed at what the first brief is missing. `usedUrls`: sources of recent posts. */
export type TopUp = { brief: string; usable: number; unusable: { item: BriefItem; why: string }[]; usedUrls?: string[] }

/**
 * One web-searching call → a sourced research brief (plain text), or '' if nothing usable came back.
 * With `topUp`, it searches again for the first-hand items the given brief lacks and returns only the
 * new items (fewer searches: it knows what to look for). `timeoutMs` bounds the whole call.
 */
export async function researchBrief(
  anthropic: Anthropic,
  now: Date,
  opts: { avoidHosts?: string[]; topUp?: TopUp; timeoutMs?: number } = {},
): Promise<string> {
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  const t = opts.topUp
  const ask = t
    ? `Today is ${today} (Malaysia). This week's brief (below) has only ${t.usable} item(s) a post can stand on; the writer needs ${MIN_USABLE}. ` +
      // Two extra: some new finds turn out second-hand or already used (W47 replay, 2026-11-15).
      `Search again and return ${MIN_USABLE - t.usable + 2} NEW items of kinds leader, company or research, each on a first-hand page the checker can open. No creator topics this time.\n\n` +
      (t.unusable.some((u) => u.why.startsWith('second-hand'))
        ? `These items are retellings. Find each one's original page instead (the company's or research firm's own page, or a major news organisation's own report), unless its site is on the can't-open list:\n` +
          `${t.unusable.filter((u) => u.why.startsWith('second-hand')).map((u) => `- ${u.item.what} (${u.item.source})`).join('\n')}\n\n`
        : '') +
      `Don't repeat any url already in the brief${t.usedUrls?.length ? `, or these pages recent posts already used: ${t.usedUrls.join(', ')}` : ''}. ` +
      `Return only the new items, in the same block format.\n\nTHE BRIEF SO FAR:\n\n${t.brief.trim()}`
    : `Today is ${today} (Malaysia). Find this week's items for Leo's LinkedIn research brief.`
  const messages: any[] = [{ role: 'user', content: ask }]
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : 0
  let text = ''
  // Server tools can pause a long turn (stop_reason "pause_turn"): send it back to continue.
  for (let round = 0; round < 3; round++) {
    const left = deadline ? deadline - Date.now() : 0
    if (deadline && left < 5_000) break
    const params = {
      model: RESEARCH_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      // The top-up knows what it's looking for: fewer searches (each one's results are paid as input).
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: t ? 5 : 8 }],
      system: system([...new Set([...UNREADABLE_HOSTS, ...(opts.avoidHosts ?? [])])]),
      messages,
    }
    // Same cast as prompt.ts: `fallbacks` and this tool version are newer than this SDK's types.
    const res = await anthropic.beta.messages.create(
      params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      deadline ? { timeout: left, maxRetries: 0 } : undefined,
    )
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
