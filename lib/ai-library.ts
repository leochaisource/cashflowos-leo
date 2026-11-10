import 'server-only'
import { supabase, supabaseConfigured } from './supabase'
import { FOCUSES, type Focus } from '@/agents/ai-library/research'

// The AI Library's READ side, shared by /library, /library/[id] and Jarvis
// (library tools in lib/bot-ads-tools.ts). The researcher that writes it lives in
// agents/ai-library/. Tables: supabase/ai-library.sql.

export type LibraryCase = {
  id: number
  url: string
  title: string
  publisher: string | null
  published_on: string | null
  who: string | null
  region: string | null
  company_size: string | null
  topics: string[]
  business_function: string | null
  pattern: string | null
  tools: string[]
  summary: string
  how_it_works: string[]
  results: { claim: string; number: string; claimed_by: string; excerpt: string }[]
  lessons: string[]
  apply_idea: string | null
  relevance: number | null
  source_kind: string | null
  excerpts: string[]
  check_status: 'verified' | 'partly' | 'unchecked'
  check_note: string | null
  found_by: string
  created_at: string
}

export type Idea = {
  id: number
  week: string
  position: number
  kind: 'improve' | 'build' | 'try'
  title: string
  what: string
  why: string
  first_step: string
  effort: string | null
  improves: string | null
  based_on: number[]
  answer: 'wanted' | 'not for me' | 'waiting' | 'no answer'
  created_at: string
}

export const TOPICS = Object.entries(FOCUSES).map(([id, f]) => ({ id: id as Focus, label: f.label }))
export const SIZES = ['solo', 'small', 'mid', 'enterprise'] as const
export const PAGE_SIZE = 24
export const CHECK_LABEL: Record<string, string> = { verified: 'checked on the page', partly: 'partly checked', unchecked: 'not machine-checked' }
export const CHECK_CLASS: Record<string, string> = { verified: 'done', partly: 'pending', unchecked: 'nurture' }

const COLS =
  'id, url, title, publisher, published_on, who, region, company_size, topics, business_function, pattern, tools, summary, how_it_works, results, lessons, apply_idea, relevance, source_kind, excerpts, check_status, check_note, found_by, created_at'

/** A short name for a case: the company or person, before any comma or bracket. */
export function caseName(c: Pick<LibraryCase, 'who' | 'title'>): string {
  const who = (c.who ?? '').split(/[,(]/)[0].trim()
  return who || c.title
}

export type CaseFilters = { q?: string; topic?: string; size?: string; sort?: 'new' | 'relevant'; page?: number }

export async function listCases(f: CaseFilters): Promise<{ rows: LibraryCase[]; total: number; error: string | null }> {
  if (!supabaseConfigured) return { rows: [], total: 0, error: 'Supabase is not configured' }
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('ai_library').select(COLS, { count: 'exact' })
  if (f.q?.trim()) q = q.textSearch('fts', f.q.trim().slice(0, 120), { type: 'websearch', config: 'english' })
  if (f.topic && f.topic in FOCUSES) q = q.contains('topics', [f.topic])
  if (f.size && (SIZES as readonly string[]).includes(f.size)) q = q.eq('company_size', f.size)
  q = f.sort === 'relevant' ? q.order('relevance', { ascending: false }).order('created_at', { ascending: false }) : q.order('created_at', { ascending: false })
  const { data, count, error } = await q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  return { rows: (data ?? []) as LibraryCase[], total: count ?? 0, error: error?.message ?? null }
}

export async function getCase(id: number): Promise<LibraryCase | null> {
  if (!supabaseConfigured || !Number.isFinite(id)) return null
  const { data, error } = await supabase.from('ai_library').select(COLS).eq('id', id).maybeSingle()
  if (error) console.error(`[CFO] ai-library case ${id}:`, error.message)
  return (data as LibraryCase | null) ?? null
}

export async function casesByIds(ids: number[]): Promise<Map<number, LibraryCase>> {
  if (!supabaseConfigured || !ids.length) return new Map()
  const { data } = await supabase.from('ai_library').select(COLS).in('id', [...new Set(ids)])
  return new Map(((data ?? []) as LibraryCase[]).map((c) => [c.id, c]))
}

/** Leo's answer lives on the Telegram card each idea became (agent_actions). */
async function withAnswers(rows: any[]): Promise<Idea[]> {
  const ids = rows.map((r) => r.action_id).filter(Boolean)
  const { data } = ids.length ? await supabase.from('agent_actions').select('id, status').in('id', ids) : { data: [] as any[] }
  const st = new Map((data ?? []).map((a: any) => [a.id, a.status]))
  return rows.map((r) => {
    const s = st.get(r.action_id)
    const answer: Idea['answer'] =
      r.status === 'wanted' || s === 'executed' || s === 'executing' ? 'wanted' : s === 'rejected' ? 'not for me' : s === 'proposed' ? 'waiting' : 'no answer'
    return { ...r, based_on: r.based_on ?? [], answer } as Idea
  })
}

const IDEA_COLS = 'id, week, position, kind, title, what, why, first_step, effort, improves, based_on, action_id, status, created_at'

/** The newest week's ideas. */
export async function latestIdeas(): Promise<Idea[]> {
  if (!supabaseConfigured) return []
  const { data: last } = await supabase.from('ai_library_suggestions').select('week').order('created_at', { ascending: false }).limit(1)
  const week = last?.[0]?.week
  if (!week) return []
  const { data } = await supabase.from('ai_library_suggestions').select(IDEA_COLS).eq('week', week).order('position')
  return withAnswers(data ?? [])
}

/** Ideas that cited this case. */
export async function ideasFromCase(id: number): Promise<Idea[]> {
  if (!supabaseConfigured) return []
  const { data } = await supabase.from('ai_library_suggestions').select(IDEA_COLS).contains('based_on', [id]).order('created_at', { ascending: false }).limit(10)
  return withAnswers(data ?? [])
}

export type LibraryStats = { total: number; thisWeek: number; lastRun: { key: string; status: string; added: number; finished_at: string | null } | null }

export async function libraryStats(): Promise<LibraryStats> {
  if (!supabaseConfigured) return { total: 0, thisWeek: 0, lastRun: null }
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [all, week, run] = await Promise.all([
    supabase.from('ai_library').select('id', { count: 'exact', head: true }),
    supabase.from('ai_library').select('id', { count: 'exact', head: true }).gte('created_at', since),
    supabase.from('ai_library_runs').select('key, status, added, finished_at').eq('step', 'research').order('started_at', { ascending: false }).limit(1),
  ])
  return { total: all.count ?? 0, thisWeek: week.count ?? 0, lastRun: (run.data?.[0] as LibraryStats['lastRun']) ?? null }
}
