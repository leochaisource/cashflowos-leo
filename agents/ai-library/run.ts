import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/ai-library.ts (Node type stripping).
import { FOCUSES, focusForDay, researchCases, type Focus, type FoundCase } from './research.ts'
import { checkCase, urlKey } from './check.ts'
import { writeIdeas, type LibraryCase, type PastIdea } from './suggest.ts'

// 👉 THE AI LIBRARY (owner, 2026-11-10): "research the best use cases and real-life
// case studies of how people build AI agents or use AI in their business, put it all
// into Supabase as my library, and every Saturday suggest how I can improve".
//
//   Tue–Fri  research: up to 3 new cases a morning, one focus a day (research.ts),
//            each page opened and checked by plain code (check.ts) → ai_library
//   Saturday ideas: 3 for Leo's own setup (suggest.ts) → ai_library_suggestions,
//            sent as Telegram cards: ✅ = I want this (a task), ❌ = not for me
//   Sunday   catch-up only: the ideas, if Saturday's didn't go out
//
// It runs as its own request (/api/ai-library), started by the 9am cron's sweep
// (agents/registry.ts), so it never eats into the LinkedIn autopilot's 300 seconds.
// Every run claims a row in ai_library_runs first, so a doubled start does nothing.
// Weekday research sends nothing; how it went is the first line of Saturday's card.

const MYT = 8 * 3600_000
const DAY = 86_400_000
export type LibraryStep = 'research' | 'suggest'

export type Card =
  | { kind: 'idea'; suggestionId: number | null; week: string; position: number; title: string; firstStep: string; text: string }
  | { kind: 'note'; key: string; text: string }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cut = (s: string, n: number) => {
  const a = Array.from(String(s ?? '').trim())
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join('')
}
const klDate = (d: Date) => new Date(d.getTime() + MYT).toISOString().slice(0, 10)
const klWeekday = (d: Date) => new Date(d.getTime() + MYT).getUTCDay()
const duplicate = (e: { code?: string } | null) => e?.code === '23505'

export function isoWeek(now: Date): string {
  const d = new Date(now.getTime() + MYT)
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const wd = new Date(day).getUTCDay() || 7
  const thursday = new Date(day + (4 - wd) * DAY)
  const week = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** What this morning is for: research on Tue–Fri, ideas on Saturday, a catch-up on Sunday. */
export function stepFor(now: Date): { step: LibraryStep; focus?: Focus } | null {
  const wd = klWeekday(now)
  const focus = focusForDay(wd)
  if (focus) return { step: 'research', focus }
  if (wd === 6 || wd === 0) return { step: 'suggest' }
  return null
}

/** Claim this run's row. false = someone already ran it (or is running it right now). */
async function claim(db: SupabaseClient, key: string, step: LibraryStep, focus: string | null, force: boolean): Promise<boolean> {
  const { error } = await db.from('ai_library_runs').insert({ key, step, focus, status: 'running' })
  if (!error) return true
  if (!duplicate(error)) throw new Error(`couldn't record the run: ${error.message}`)
  const { data } = await db.from('ai_library_runs').select('status, started_at').eq('key', key).maybeSingle()
  const running = data?.status === 'running' && Date.now() - Date.parse(data.started_at) < 10 * 60_000
  // A finished run stays finished unless forced; a failed (or stuck) one may be retried.
  if (running || (data?.status === 'ok' && !force) || (step === 'research' && !force)) return false
  await db.from('ai_library_runs').update({ status: 'running', started_at: new Date().toISOString(), finished_at: null, notes: [] }).eq('key', key)
  return true
}

async function finish(db: SupabaseClient, key: string, status: 'ok' | 'partial' | 'failed', added: number, notes: string[]) {
  await db.from('ai_library_runs').update({ status, added, notes: notes.slice(0, 20), finished_at: new Date().toISOString() }).eq('key', key)
}

export async function libraryStep(args: {
  db: SupabaseClient
  anthropic: Anthropic
  now: Date
  /** Default: what today is for (stepFor). */
  step?: LibraryStep
  focus?: Focus
  /** Do everything except saving; nothing is sent either way (the caller sends the cards). */
  dryRun?: boolean
  /** Run again even though today's (or this week's) run already happened. */
  force?: boolean
  /** Facts read live by the caller (ad clients, AI Employees) for the ideas. */
  liveFacts?: string[]
  appUrl: string
  log?: (s: string) => void
}): Promise<{ step: LibraryStep | null; cards: Card[]; notes: string[]; preview?: unknown }> {
  const planned = args.step ? { step: args.step, focus: args.focus } : stepFor(args.now)
  if (!planned) return { step: null, cards: [], notes: ['nothing to do today (research runs Tue–Fri, ideas on Saturday)'] }
  if (planned.step === 'research') {
    const focus = planned.focus ?? focusForDay(klWeekday(args.now)) ?? 'marketing-sales'
    return { step: 'research', ...(await research({ ...args, focus })) }
  }
  return { step: 'suggest', ...(await suggest(args)) }
}

// ---------------------------------------------------------------- research
async function research(args: Parameters<typeof libraryStep>[0] & { focus: Focus }) {
  const { db, anthropic, now, focus } = args
  const log = args.log ?? (() => {})
  const notes: string[] = []
  const key = `research:${klDate(now)}`
  if (!args.dryRun && !(await claim(db, key, 'research', focus, !!args.force))) {
    return { cards: [], notes: [`today's research already ran (${key})`] }
  }
  try {
    // What's already in: the researcher is told, and code refuses a repeat page anyway.
    const { data: have, error } = await db.from('ai_library').select('who, title, url_key').order('created_at', { ascending: false }).limit(150)
    if (error) throw new Error(`reading the library: ${error.message}`)
    const keys = new Set((have ?? []).map((h: any) => h.url_key))
    const known = (have ?? []).map((h: any) => `${h.who ?? '?'}: ${cut(h.title, 90)} (${String(h.url_key).split('/')[0]})`)

    log(`researching: ${FOCUSES[focus].label}`)
    const found = await researchCases(anthropic, { focus, known, knownKeys: keys, now })
    notes.push(`wrote up ${found.cases.length} case(s) after ${found.searches} search(es)`, ...found.trace)

    const checked = found.cases.map((c) => {
      const k = urlKey(c.url)
      if (!k) return { c, drop: 'not a valid link' }
      if (keys.has(k)) return { c, drop: 'already in the library' }
      const v = checkCase(c.pageText, c)
      return v.status === 'dropped' ? { c, drop: v.note } : { c, k, v }
    })
    const rows = []
    for (const x of checked) {
      if ('drop' in x && x.drop) {
        notes.push(`left out "${cut(x.c.title, 70)}": ${x.drop}`)
        continue
      }
      const { c, k, v } = x as { c: FoundCase; k: string; v: ReturnType<typeof checkCase> }
      rows.push({
        url: c.url,
        url_key: k,
        title: cut(c.title, 300),
        publisher: cut(c.publisher, 120) || null,
        published_on: cut(c.published_on, 60) || null,
        who: cut(c.who, 120) || null,
        region: cut(c.region, 60) || null,
        company_size: c.company_size,
        topics: [focus],
        business_function: cut(c.business_function, 60) || null,
        pattern: cut(c.pattern, 120) || null,
        tools: c.tools.slice(0, 12).map((t) => cut(t, 60)),
        summary: cut(c.summary, 1200),
        how_it_works: c.how_it_works.slice(0, 8).map((s) => cut(s, 400)),
        results: v.results,
        lessons: c.lessons.slice(0, 4).map((s) => cut(s, 400)),
        apply_idea: cut(c.apply_idea, 600) || null,
        relevance: Math.min(5, Math.max(1, Math.round(c.relevance || 1))),
        source_kind: c.source_kind,
        excerpts: v.excerpts.slice(0, 6).map((s) => cut(s, 500)),
        check_status: v.status,
        check_note: v.note || null,
        found_by: `research:${focus}`,
        keywords: [...c.tags, ...c.tools].map((t) => t.toLowerCase()).join(' ').slice(0, 500),
      })
    }
    if (args.dryRun) return { cards: [], notes, preview: { kept: rows, left_out: checked.filter((x) => 'drop' in x && x.drop).map((x) => ({ title: x.c.title, url: x.c.url })) } }

    let added = 0
    if (rows.length) {
      const { data, error: e } = await db.from('ai_library').upsert(rows, { onConflict: 'url_key', ignoreDuplicates: true }).select('id')
      if (e) throw new Error(`saving the cases: ${e.message}`)
      added = data?.length ?? 0
    }
    notes.push(`added ${added}`)
    await finish(db, key, added ? 'ok' : 'partial', added, notes)
    return { cards: [], notes }
  } catch (e) {
    const msg = (e as Error).message
    notes.push(`failed: ${msg}`)
    if (!args.dryRun) await finish(db, key, 'failed', 0, notes)
    return { cards: [], notes }
  }
}

// ---------------------------------------------------------------- ideas
const KIND: Record<string, string> = { improve: 'Improve', build: 'Build', try: 'Try' }
const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** One line per research morning this week, for the top of Saturday's first card. */
async function weekResearch(db: SupabaseClient, now: Date) {
  const todayMyt = Date.parse(klDate(now))
  const monday = todayMyt - ((new Date(todayMyt).getUTCDay() + 6) % 7) * DAY
  const days = [1, 2, 3, 4].map((o) => new Date(monday + o * DAY).toISOString().slice(0, 10))
  const { data } = await db.from('ai_library_runs').select('key, status, added, notes').in('key', days.map((d) => `research:${d}`))
  const byKey = new Map((data ?? []).map((r: any) => [r.key, r]))
  let added = 0
  const parts: string[] = []
  const problems: string[] = []
  for (const d of days) {
    const r: any = byKey.get(`research:${d}`)
    const name = DAY_NAME[new Date(d).getUTCDay()]
    if (Date.parse(d) >= todayMyt) continue
    if (!r) {
      parts.push(`${name} 0`)
      problems.push(`${name}: the research didn't run`)
      continue
    }
    added += r.added ?? 0
    parts.push(`${name} ${r.added ?? 0}`)
    if (r.status === 'failed') problems.push(`${name}: ${cut(String((r.notes ?? []).find((n: string) => n.startsWith('failed:')) ?? 'failed').replace(/^failed:\s*/, ''), 140)}`)
    else if (r.status === 'running') problems.push(`${name}: the research never finished`)
  }
  return { added, parts, problems }
}

async function suggest(args: Parameters<typeof libraryStep>[0]) {
  const { db, anthropic, now, appUrl } = args
  const notes: string[] = []
  const week = isoWeek(now)
  const key = `suggest:${week}`
  const sunday = klWeekday(now) === 0
  if (!args.dryRun && !(await claim(db, key, 'suggest', null, !!args.force))) {
    return { cards: [], notes: [`this week's ideas already went out (${key})`] }
  }
  const failCard = (why: string): Card => ({
    kind: 'note',
    key: `ai-library:ideas-failed:${week}:${klDate(now)}`,
    text:
      `⚠️ <b>AI Library</b>: couldn't write this week's ideas (${esc(cut(why, 160))}).\n` +
      (sunday ? 'No ideas this week. ' : 'It tries again tomorrow morning. ') +
      `The cases are in <a href="${appUrl}/library">the library</a>.`,
  })
  try {
    const wk = await weekResearch(db, now)
    const since = new Date(now.getTime() - 7 * DAY).toISOString()
    const cols = 'id, who, title, pattern, summary, results, apply_idea, relevance, check_status, created_at'
    const { data: fresh, error: e1 } = await db.from('ai_library').select(cols).gte('created_at', since).order('created_at')
    if (e1) throw new Error(`reading the library: ${e1.message}`)

    // His answers to past ideas, read from the Telegram card each one became.
    const { data: pastRows } = await db
      .from('ai_library_suggestions')
      .select('week, kind, title, based_on, action_id, status')
      .gte('created_at', new Date(now.getTime() - 56 * DAY).toISOString())
      .neq('week', week)
    const actionIds = (pastRows ?? []).map((p: any) => p.action_id).filter(Boolean)
    const { data: acts } = actionIds.length ? await db.from('agent_actions').select('id, status').in('id', actionIds) : { data: [] as any[] }
    const actStatus = new Map((acts ?? []).map((a: any) => [a.id, a.status]))
    const past: PastIdea[] = (pastRows ?? []).map((p: any) => {
      const s = actStatus.get(p.action_id)
      const answer = p.status === 'wanted' || s === 'executed' || s === 'executing' ? 'wanted' : s === 'rejected' ? 'not for me' : s === 'proposed' ? 'waiting' : 'no answer'
      return { week: p.week, kind: p.kind, title: p.title, answer }
    })
    const cited = new Set((pastRows ?? []).flatMap((p: any) => p.based_on ?? []))
    const { data: olderRows } = await db
      .from('ai_library')
      .select(cols)
      .lt('created_at', since)
      .gte('relevance', 4)
      .order('relevance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(40)
    const older = (olderRows ?? []).filter((c: any) => !cited.has(c.id)).slice(0, 15) as LibraryCase[]

    const header =
      `📚 <b>AI Library · ${week.replace(/^\d+-W/, 'week ')}</b>: ${wk.added} new case${wk.added === 1 ? '' : 's'} this week` +
      (wk.parts.length ? ` (${wk.parts.join(' · ')})` : '') +
      `. <a href="${appUrl}/library">Open the library</a>` +
      (wk.problems.length ? `\n${wk.problems.map((p) => `⚠️ ${esc(p)}`).join('\n')}` : '')

    if (!(fresh ?? []).length && !older.length) {
      if (!args.dryRun) await finish(db, key, 'partial', 0, ['no cases to build ideas from'])
      return { cards: [{ kind: 'note' as const, key: `ai-library:empty:${week}`, text: `${header}\n\nNo cases to build ideas from yet, so no ideas this week.` }], notes: ['no cases'] }
    }

    const { ideas, dropped } = await writeIdeas(anthropic, { fresh: (fresh ?? []) as LibraryCase[], older, past, liveFacts: args.liveFacts ?? [] })
    notes.push(...dropped)
    if (!ideas.length) throw new Error(dropped[0] ?? 'the model returned no ideas')

    const byId = new Map([...(fresh ?? []), ...older].map((c: any) => [c.id, c]))
    const saved: { id: number | null; position: number }[] = []
    if (!args.dryRun) {
      const { data, error } = await db
        .from('ai_library_suggestions')
        .upsert(
          ideas.map((i, n) => ({
            week, position: n + 1, kind: i.kind, title: cut(i.title, 120), what: cut(i.what, 1200), why: cut(i.why, 800),
            first_step: cut(i.first_step, 600), effort: cut(i.effort, 80) || null, improves: cut(i.improves, 120) || null, based_on: i.based_on,
          })),
          { onConflict: 'week,position' },
        )
        .select('id, position')
      if (error) throw new Error(`saving the ideas: ${error.message}`)
      saved.push(...(data ?? []))
    }

    const cards: Card[] = ideas.map((i, n) => {
      const links = i.based_on
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((c: any) => `<a href="${appUrl}/library/${c.id}">${esc(cut(String(c.who ?? '').split(/[,(]/)[0].trim() || c.title, 40))}</a>`)
        .join(', ')
      const text = [
        n === 0 ? `${header}\n` : null,
        `💡 <b>Idea ${n + 1} of ${ideas.length} · ${KIND[i.kind] ?? i.kind}</b>: ${esc(cut(i.title, 120))}`,
        esc(cut(i.what, 500)),
        '',
        `<b>Why:</b> ${esc(cut(i.why, 350))}`,
        `<b>First step:</b> ${esc(cut(i.first_step, 300))}`,
        `<b>Effort:</b> ${esc(cut(i.effort, 80))}${i.improves ? ` · <b>Improves:</b> ${esc(cut(i.improves, 80))}` : ''}`,
        `📚 From: ${links}`,
        '',
        '✅ = I want this (goes on your Tasks) · ❌ = not for me. The buttons work for a day.',
      ]
        .filter((l) => l !== null)
        .join('\n')
      return { kind: 'idea' as const, suggestionId: saved.find((s) => s.position === n + 1)?.id ?? null, week, position: n + 1, title: cut(i.title, 120), firstStep: cut(i.first_step, 300), text }
    })
    if (args.dryRun) return { cards, notes, preview: { ideas, header } }
    await finish(db, key, 'ok', ideas.length, notes)
    return { cards, notes }
  } catch (e) {
    const msg = (e as Error).message
    notes.push(`failed: ${msg}`)
    if (!args.dryRun) await finish(db, key, 'failed', 0, notes)
    return { cards: [failCard(msg)], notes }
  }
}
