import 'server-only'
import { supabase } from './supabase'
import { PROJECTS, matchProject } from './ad-clients'
import { clip, whenShort, dateLong } from './format'

// Jarvis's HEADS tools (read-only). Each client has an AI head of marketing
// (the speakfunnels-heads repo) that checks Meta, GHL, the payment sheet, the
// landing pages and competitor data every morning, then files what it found in
// the pm_ tables of this same Supabase. These tools let the owner ask the bot
// about that work ("what's broken for FinLit?", "anything waiting for me?").
//
// They ride along in BOT_ADS_TOOLS (lib/bot-ads-tools.ts), the same way the AI
// Library tools do, so the 🔒 Telegram route's dispatch stays untouched. Firstin5
// AI only gets the tools on its own allowlist, so none of this reaches a client.
//
// Read-only: the heads write these tables; the bot never does.

/** What the owner calls each head. Same names as the head-report-telegram footer. */
const HEADS: Record<string, { label: string; aliases: string[] }> = {
  'mr-money-academy': { label: 'FinLit', aliases: ['finlit', 'fin lit', 'frankie', 'mr money', 'mrmoney', 'mmtv', 'faq show', 'hbps'] },
  'claude-malaysia': { label: 'Claude Malaysia', aliases: ['claude malaysia', 'cm', 'kingsley'] },
  'starcity-global': { label: 'Starcity', aliases: ['starcity', 'star city', 'florence'] },
  'nuggets-academy': { label: 'Nuggets', aliases: ['nuggets', 'sandra'] },
  'prominds-ai-speaker': { label: 'Nicsman', aliases: ['nicsman', 'prominds'] },
}
const label = (key: string) => HEADS[key]?.label ?? key

/** "finlit" / "Frankie" / "mr-money-academy" / "Mr Money Academy" → the project key. */
function resolveHead(q: unknown): string | null {
  const hay = String(q ?? '').toLowerCase().trim()
  if (!hay) return null
  if (HEADS[hay]) return hay
  for (const [key, h] of Object.entries(HEADS)) {
    // Whole words only, so "cm" doesn't match inside another word.
    if (h.aliases.some((a) => new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay))) return key
  }
  return matchProject(hay, PROJECTS).project?.id ?? null
}

const SEVERITY_ORDER: Record<string, number> = { urgent: 0, critical: 0, warn: 1, info: 2 }

const notFound = (q: unknown) =>
  JSON.stringify({ status: 'unknown_client', message: `No head of marketing found for "${String(q ?? '')}".`, heads: Object.values(HEADS).map((h) => h.label) })

export const BOT_HEADS_TOOLS = [
  {
    name: 'head_report',
    description:
      "The latest report from a client's AI head of marketing. Each head checks that client's Meta ads, GoHighLevel " +
      '(custom values, workflows, sends, inbox), payment sheet, landing pages and competitor data, then lists what to ' +
      'fix (exact fix and who does it), the numbers, and what it could not check. Use for "what\'s wrong with FinLit", ' +
      '"anything to fix", "what did the head say", "morning report", "how is <client> doing" beyond ad numbers. ' +
      "Omit project to get every head's latest headline.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Client or head name, e.g. "FinLit", "Frankie", "Mr Money", "Claude Malaysia". Omit for all heads.' },
        job: { type: 'string', description: 'Optional: only this kind of run, e.g. "watchdog", "weekly-review", "price-step".' },
      },
      required: [],
    },
  },
  {
    name: 'head_issues',
    description:
      "Known issues a client's head is tracking: severity, what's wrong, the exact fix, who owns it, and since when. " +
      'Use for "what\'s still open", "what\'s broken", "is X fixed yet", "what does Ariella / Leo need to fix".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Client or head name, e.g. "FinLit".' },
        status: { type: 'string', enum: ['open', 'fixed', 'all'], description: 'open (default: open + not yet verified), fixed, or all.' },
        owner: { type: 'string', description: 'Optional: only issues this person owns, e.g. "Leo".' },
      },
      required: ['project'],
    },
  },
  {
    name: 'head_backlog',
    description:
      "Suggestions a client's head has made and their state: waiting for the owner's yes, approved, done or rejected, " +
      'each with the number behind it. Use for "what\'s waiting for me", "what did the head suggest", "what should we improve".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Client or head name, e.g. "FinLit".' },
        status: { type: 'string', enum: ['suggested', 'approved', 'done', 'rejected', 'all'], description: 'Default suggested (waiting for the owner).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'head_decisions',
    description:
      "The owner's settled decisions on file for a client (plus agency-wide ones), which the heads follow. Use for " +
      '"why is the budget RM300", "what did I decide about X", "what are the rules for this client".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Client or head name, e.g. "FinLit".' },
        topic: { type: 'string', description: 'Optional word to search in the topic or decision, e.g. "budget".' },
      },
      required: ['project'],
    },
  },
]

export const HEADS_TOOL_NAMES = new Set(BOT_HEADS_TOOLS.map((t) => t.name))

export async function runBotHeadsTool(name: string, input: any): Promise<string> {
  try {
    if (name === 'head_report') {
      const key = resolveHead(input?.project)
      if (input?.project && !key) return notFound(input.project)
      let q = supabase
        .from('pm_runs')
        .select('project, job, started_at, finished_at, banner, report, not_checked')
        .order('started_at', { ascending: false })
        .limit(key ? 4 : 40)
      if (key) q = q.eq('project', key)
      if (input?.job) q = q.eq('job', String(input.job))
      const { data, error } = await q
      if (error) throw error
      const runs = data ?? []
      if (!key) {
        // Latest headline per head.
        const seen = new Set<string>()
        const heads = runs.filter((r) => !seen.has(r.project) && seen.add(r.project))
        return JSON.stringify({
          heads: heads.map((r) => ({ head: label(r.project), project: r.project, when: whenShort(r.finished_at ?? r.started_at), job: r.job, banner: r.banner })),
          note: heads.length ? 'Ask about one head for its full report.' : 'No head has filed a report yet.',
        })
      }
      const [latest, ...earlier] = runs
      if (!latest) return JSON.stringify({ head: label(key), project: key, status: 'no_reports', message: 'This head has not filed a report yet.' })
      const at = latest.finished_at ?? latest.started_at
      const hoursOld = (Date.now() - Date.parse(at)) / 3_600_000
      return JSON.stringify({
        head: label(key),
        project: key,
        latest: {
          when: whenShort(at),
          job: latest.job,
          banner: latest.banner,
          report: clip(latest.report, 6000),
          not_checked: latest.not_checked ?? [],
        },
        ...(hoursOld > 26 ? { stale: `The latest report is ${Math.round(hoursOld)} hours old: the daily run may not have finished. Say so.` } : {}),
        earlier: earlier.map((r) => ({ when: whenShort(r.finished_at ?? r.started_at), job: r.job, banner: r.banner })),
      })
    }

    const key = resolveHead(input?.project)
    if (!key) return input?.project ? notFound(input.project) : JSON.stringify({ status: 'ambiguous', message: 'Which client?', heads: Object.values(HEADS).map((h) => h.label) })

    if (name === 'head_issues') {
      const status = String(input?.status ?? 'open')
      let q = supabase
        .from('pm_issues')
        .select('key, severity, title, fix, owner, status, first_seen, last_seen, fixed_on')
        .eq('project', key)
        .order('last_seen', { ascending: false, nullsFirst: false })
        .limit(60)
      if (status === 'open') q = q.in('status', ['open', 'unverified'])
      else if (status === 'fixed') q = q.eq('status', 'fixed')
      const { data, error } = await q
      if (error) throw error
      const owner = String(input?.owner ?? '').toLowerCase().trim()
      const rows = (data ?? [])
        .filter((r) => !owner || String(r.owner ?? '').toLowerCase().includes(owner))
        .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
        .slice(0, 30)
      return JSON.stringify({
        head: label(key),
        project: key,
        status,
        count: rows.length,
        issues: rows.map((r) => ({
          severity: r.severity,
          status: r.status === 'unverified' ? 'not yet checked live' : r.status,
          title: r.title,
          fix: clip(r.fix, 500),
          owner: r.owner,
          since: dateLong(r.first_seen),
          last_seen: dateLong(r.last_seen),
          ...(r.fixed_on ? { fixed_on: dateLong(r.fixed_on) } : {}),
        })),
      })
    }

    if (name === 'head_backlog') {
      const status = String(input?.status ?? 'suggested')
      let q = supabase
        .from('pm_backlog')
        .select('kind, title, what, number_behind, expected_effect, effort, owner, needs_yes, status, leo_reason, rank, created_at')
        .eq('project', key)
        .order('rank', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(25)
      if (status !== 'all') q = q.eq('status', status)
      const { data, error } = await q
      if (error) throw error
      return JSON.stringify({
        head: label(key),
        project: key,
        status,
        count: data?.length ?? 0,
        items: (data ?? []).map((r) => ({
          kind: r.kind,
          title: r.title,
          what: clip(r.what, 400),
          number_behind: r.number_behind,
          expected_effect: r.expected_effect,
          effort: r.effort,
          owner: r.owner,
          needs_owner_yes: r.needs_yes,
          status: r.status,
          ...(r.leo_reason ? { owner_reason: r.leo_reason } : {}),
          since: dateLong(r.created_at),
        })),
      })
    }

    if (name === 'head_decisions') {
      const { data, error } = await supabase
        .from('pm_decisions')
        .select('project, decided_on, topic, decision, source')
        .in('project', [key, 'speakfunnels', '_shared'])
        .order('decided_on', { ascending: false, nullsFirst: false })
        .limit(60)
      if (error) throw error
      const topic = String(input?.topic ?? '').toLowerCase().trim()
      const rows = (data ?? [])
        .filter((r) => !topic || `${r.topic} ${r.decision}`.toLowerCase().includes(topic))
        .slice(0, 30)
      return JSON.stringify({
        head: label(key),
        project: key,
        count: rows.length,
        decisions: rows.map((r) => ({
          scope: r.project === key ? label(key) : 'all clients',
          decided: dateLong(r.decided_on),
          topic: r.topic,
          decision: clip(r.decision, 600),
        })),
      })
    }

    return JSON.stringify({ error: `Unknown heads tool: ${name}` })
  } catch (e) {
    console.error('[CFO] heads tool failed:', name, e)
    return JSON.stringify({ error: `Could not read the heads' records: ${clip((e as Error).message, 160)}` })
  }
}
