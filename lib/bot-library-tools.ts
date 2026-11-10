import 'server-only'
import { APP_URL } from './brief-digest'
import { clip } from './format'
import { caseName, casesByIds, latestIdeas, listCases } from './ai-library'

// Jarvis's two AI Library tools (read-only). They ride along in BOT_ADS_TOOLS
// (lib/bot-ads-tools.ts) because that list is already async and reads its own
// tables, which keeps the 🔒 Telegram route untouched.

export const BOT_LIBRARY_TOOLS = [
  {
    name: 'ai_library_search',
    description:
      "Search the owner's AI LIBRARY: real-life case studies of how businesses build AI agents or use AI at work, collected and " +
      'checked by his researcher. Use for "show me cases about post-call notes", "how do small teams use AI for invoices", ' +
      '"any Malaysian examples of AI in sales", "what did we learn this week". Returns each case with its pattern, summary, ' +
      'numbers (their own figures unless measured independently), how it fits his setup, and links.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Words to search for, e.g. "lead follow-up whatsapp". Leave empty for the newest cases.' },
        topic: {
          type: 'string',
          enum: ['marketing-sales', 'ops-finance-admin', 'solo-small-team', 'malaysia-sea'],
          description: 'Optional: only one research topic.',
        },
        limit: { type: 'number', description: 'How many cases, 1-8. Default 5.' },
      },
      required: [],
    },
  },
  {
    name: 'ai_library_ideas',
    description:
      "This week's 3 AI ideas for the owner's own setup (sent on Saturday), with what to do, the first step, effort, the case " +
      "each came from, and his answer so far (wanted / not for me / waiting / no answer). Use for \"what were Saturday's ideas\", " +
      '"what should I build next with AI".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
]

export const LIBRARY_TOOL_NAMES = new Set(BOT_LIBRARY_TOOLS.map((t) => t.name))

export async function runBotLibraryTool(name: string, input: any): Promise<string> {
  if (name === 'ai_library_search') {
    const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 8)
    const r = await listCases({ q: String(input?.query ?? ''), topic: input?.topic ? String(input.topic) : undefined, sort: input?.query ? 'relevant' : 'new' })
    if (r.error) return JSON.stringify({ error: `couldn't read the library: ${r.error}` })
    return JSON.stringify({
      total_matching: r.total,
      library_page: `${APP_URL}/library${input?.query ? `?q=${encodeURIComponent(String(input.query))}` : ''}`,
      cases: r.rows.slice(0, limit).map((c) => ({
        name: caseName(c),
        pattern: c.pattern,
        summary: clip(c.summary, 400),
        results: c.results.map((x) => `${x.number}: ${x.claim} (${x.claimed_by === 'independent' ? 'measured independently' : 'their own figure'})`),
        fit_for_you: c.apply_idea ? clip(c.apply_idea, 300) : null,
        checked: c.check_status,
        added: c.created_at.slice(0, 10),
        link: `${APP_URL}/library/${c.id}`,
        source: c.url,
      })),
    })
  }
  if (name === 'ai_library_ideas') {
    const ideas = await latestIdeas()
    if (!ideas.length) return JSON.stringify({ ideas: [], note: 'No ideas yet: they are written every Saturday morning.' })
    const cases = await casesByIds(ideas.flatMap((i) => i.based_on))
    return JSON.stringify({
      week: ideas[0].week,
      ideas: ideas.map((i) => ({
        kind: i.kind,
        title: i.title,
        what: i.what,
        first_step: i.first_step,
        effort: i.effort,
        improves: i.improves,
        your_answer: i.answer,
        from_cases: i.based_on.map((id) => ({ name: cases.get(id) ? caseName(cases.get(id)!) : `case #${id}`, link: `${APP_URL}/library/${id}` })),
      })),
    })
  }
  return JSON.stringify({ error: `unknown library tool ${name}` })
}
