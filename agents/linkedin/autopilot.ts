import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/linkedin-autopilot-dry-run.ts (Node type stripping).
import { isoWeek } from './definition.ts'
import { loadWeekFacts } from './load.ts'
import { MIN_USABLE, UNREADABLE_HOSTS, gradeBrief, hostOf, researchBrief, type BriefGrade } from './research.ts'
import { writePosts, type RejectedDraft, type WrittenPost } from './write.ts'
import { verifyPost } from './verify.ts'
import { lintPost, numbersIn, quoteProblems } from './checks.ts'
import { pickImages } from './images.ts'
import { renderCarousel } from './slides.ts'
import { leoAccount, scheduleCarousel, scheduledTimes } from './publish.ts'
import { fetchWins, sourcesConfigured } from './sources.ts'
import { cataloguePhotos, markPhotoUsed, pickCover } from './photos.ts'
import type { WriterNote } from './write.ts'

// 👉 THE LINKEDIN AUTOPILOT (owner's call, 2026-11-07): every week it researches,
// writes, checks, illustrates and schedules Leo's Tue/Wed/Thu 09:00 posts with
// nobody approving them. Leo hears from it only when a slot ends up empty or a
// post can't be scheduled (a Telegram card), never when things go right.
//
// It rides the 9am daily cron (Vercel Hobby allows only two crons, each run has
// 300s), so the week is split into one heavy step per morning, each saved in
// linkedin_autopilot (supabase/linkedin-autopilot.sql) so the next one picks up:
//   Saturday   research brief (web search)                 → research row
//              fewer than 5 usable first-hand items: one more search, aimed at the gap
//   Sunday     write posts + two spares, fact-check each   → post rows 'drafted' / 'rewrite'
//              a slot nothing passed in gets ONE second writing pass (it may fix a failed
//              draft), in the same run if there's time, else the next morning → 'drafted' / 'dropped'
//   Monday     pick photos, draw slides, schedule in GHL   → 'scheduled' / retried tomorrow / 'failed'
//              (or 'dropped' when a manual post has taken the slot in GHL since Sunday)
// A missed step is retried the next morning while the slot is still far enough
// ahead. A doubled cron delivery is harmless: rows are unique per week and per slot.
// W47 (2026-11-15) is why the second search and the second pass exist: a thin brief
// left the writer 2 drafts instead of 5, both failed the checks, and all 3 slots stayed empty.
//
// What may be said about Leo is a closed list (kit.ts) plus what he adds himself to
// his wins sheet (sources.ts, 2026-11-08); every post passes plain-code checks
// (checks.ts) and a source check that opens the page (verify.ts), on both passes.
// His photos folder is sorted on quiet mornings (Tue-Fri, a few photos at a time;
// photos.ts), and on Monday one of his photos replaces the stock cover when it fits
// the post, at most once a week.

const MYT = 8 * 3600_000
const DAY = 86_400_000
const HOUR = 3600_000
// The 9am run has 300s, and the jobs before this step take about 25s. Every call this
// step makes is cut off so the step ends by STEP_BUDGET; a second writing pass (a writer
// call plus its source checks, about 70s) only starts this early, or waits for tomorrow.
const STEP_BUDGET = 230_000
const SECOND_PASS_BY = 90_000
/** A slot can still be written this morning only this far ahead (scheduled tomorrow morning). */
const WRITE_AHEAD = 25 * HOUR

export type AutopilotCard = { idempotencyKey: string; payload: any; text: string }
export type Slot = { at: Date; label: string }
type PostRow = { id: number; slot: string; status: string; data: any; attempts: number | null; note?: string | null }
type Checked = { post: WrittenPost; problems: string[]; excerpts: string[]; page: string; pass?: 1 | 2 }

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// By characters, not storage units: a cut emoji or "fancy" letter makes Telegram reject the card.
const clip = (s: string, n: number) => {
  const a = Array.from(s)
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : s
}
const dayLabel = (d: Date) =>
  new Date(d.getTime() + MYT).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })

/**
 * The posting block this morning works on: the Tue/Wed/Thu whose Thursday slot is still ahead.
 * `opens` is the Saturday before it (00:00 MYT): nothing starts earlier.
 */
export function postingBlock(now: Date): { week: string; slots: Slot[]; opens: Date } {
  const t = now.getTime() + MYT
  const todayMyt = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()) // 00:00 MYT, as if UTC
  const wd = new Date(todayMyt).getUTCDay()
  let tue = todayMyt - ((wd - 2 + 7) % 7) * DAY // this week's Tuesday (on or before today)
  if (tue + 2 * DAY + 9 * HOUR - MYT < now.getTime() + 2 * HOUR) tue += 7 * DAY
  const at = (offset: number) => new Date(tue + offset * DAY + 9 * HOUR - MYT) // 09:00 MYT
  const slots = [0, 1, 2].map((o) => ({ at: at(o), label: dayLabel(at(o)) }))
  return { week: isoWeek(slots[0].at), slots, opens: new Date(tue - 3 * DAY - MYT) }
}

function card(key: string, title: string, lines: string[]): AutopilotCard {
  return {
    idempotencyKey: `linkedin-auto:${key}`,
    payload: { kind: 'auto_note', text: `${title} ${lines.join(' ')}` },
    text: [`⚠️ <b>LinkedIn autopilot</b>: ${esc(title)}`, ...lines.map(esc), '', '✅ or ❌ = seen. Nothing else needs you.'].join('\n'),
  }
}

/** A post already scheduled in GHL within 30 minutes of a slot takes it. The same rule on Sunday (②) and Monday (③). */
const slotTaken = (taken: number[], at: number) => taken.some((t) => Math.abs(t - at) < 30 * 60_000)

/** Was this Postgres error "that row already exists" (a doubled cron run)? */
const duplicate = (e: { code?: string } | null) => e?.code === '23505'

// Words in the wins sheet's client column that describe rather than name (never blocked in posts).
const GENERIC = /\b(client|clients|company|business|brand|agency|project|internal|own|personal|myself|speakfunnels|n\/a|none)\b/i
/** The names in the sheet's private client column: these must never appear in a post. */
const clientNames = (s: string) =>
  s
    .split(/[,/;&]|\band\b/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4 && !GENERIC.test(x))

const CANT_OPEN = /couldn't open the source page \(([^)]+)\)/
/** A failed draft worth fixing: its page opened and is reputable, so only its wording was wrong. */
const fixable = (problems: string[]) =>
  !problems.some((p) => CANT_OPEN.test(p) || /isn't reputable|wasn't in the research brief|not a valid link|declined|can't open/.test(p))

/**
 * What past weeks taught (8 weeks back): the sites the source checker couldn't open, and the
 * sources already posted. Both make a brief item unusable (research.ts, gradeBrief).
 */
async function sourceHistory(db: SupabaseClient, now: Date): Promise<{ unreadable: string[]; usedUrls: string[] }> {
  const unreadable = new Set(UNREADABLE_HOSTS)
  const used = new Set<string>()
  const { data, error } = await db.from('linkedin_autopilot').select('kind, status, data').gte('created_at', new Date(now.getTime() - 56 * DAY).toISOString())
  if (error) throw new Error(`reading past weeks: ${error.message}`)
  for (const r of (data ?? []) as { kind: string; status: string; data: any }[]) {
    const d = r.data ?? {}
    if (r.kind === 'post' && r.status === 'scheduled' && d.post?.source_url) used.add(d.post.source_url)
    for (const h of d.unreadable ?? []) unreadable.add(h)
    for (const x of d.rejected ?? []) for (const p of x.problems ?? []) {
      const m = CANT_OPEN.exec(p)
      if (m) unreadable.add(m[1])
    }
  }
  return { unreadable: [...unreadable], usedUrls: [...used] }
}

/** The brief items the writer must not stand a post on, as "url: why" lines. */
const skipList = (g: BriefGrade) => g.unusable.filter((u) => u.item.url).map((u) => `${u.item.url}: ${u.why}`)

/**
 * Rotation (linkedin skill, Step 0): no topic twice in a row, no hook type from the last 3 posts.
 * Prefer a post that keeps both; settle for a new topic; take what's left only as a last resort.
 */
function rotation(prevTopic: string | null, hooks: string[]) {
  return (pool: Checked[]) => {
    const fresh = (c: Checked) => c.post.topic !== prevTopic
    let i = pool.findIndex((c) => fresh(c) && !hooks.slice(0, 3).includes(c.post.hook_type))
    if (i < 0) i = pool.findIndex(fresh)
    if (i < 0 && pool.length) i = 0
    if (i < 0) return undefined
    const [c] = pool.splice(i, 1)
    prevTopic = c.post.topic
    hooks.unshift(c.post.hook_type)
    return c
  }
}

export async function autopilotStep(args: {
  db: SupabaseClient
  anthropic: Anthropic
  now: Date
  pexelsKey: string | null
  /** Run-time names to keep out of posts (projects, competitors). */
  neverName: string[]
  /** Dry run: do everything except GHL scheduling and database writes. */
  dryRun?: boolean
  /**
   * Dry runs only (ignored otherwise): a known research brief, to replay a thin week. 'search'
   * uses it in place of Saturday's first web search; 'saved' uses it as the week's saved brief.
   */
  test?: { brief: string; as: 'search' | 'saved' }
  log?: (s: string) => void
}): Promise<{ cards: AutopilotCard[]; notes: string[]; preview?: unknown }> {
  const { db, anthropic, now } = args
  const cards: AutopilotCard[] = []
  const notes: string[] = []
  const log = args.log ?? (() => {})
  const test = args.dryRun ? args.test : undefined
  const block = postingBlock(now)
  const started = Date.now()
  const left = () => STEP_BUDGET - (Date.now() - started)
  // Sort new photos in Leo's folder with whatever time this run has left. Never on a dry
  // run, never fatal: a photo problem only means the stock cover.
  const catalogue = async (budgetMs: number, max: number) => {
    if (args.dryRun || !sourcesConfigured() || budgetMs < 15_000) return
    try {
      const r = await cataloguePhotos({ db, anthropic, budgetMs, max, log })
      if (r.added || r.waiting) notes.push(`photos: ${r.added} newly sorted${r.waiting ? `, ${r.waiting} still waiting` : ''}`)
      notes.push(...r.notes.slice(0, 5).map((n) => `photos: ${n}`))
    } catch (e) {
      notes.push(`photos: ${(e as Error).message}`)
    }
  }
  if (now < block.opens) {
    notes.push(`autopilot idle until ${block.opens.toISOString().slice(0, 10)} (week ${block.week})`)
    await catalogue(100_000, 15)
    return { cards, notes }
  }
  const today = new Date(now.getTime() + MYT).toISOString().slice(0, 10)

  // Monday: warn two weeks before the LinkedIn connection in GHL expires (only Leo can reconnect it).
  if (new Date(now.getTime() + MYT).getUTCDay() === 1) {
    try {
      const acct = await leoAccount()
      const days = acct.expire ? Math.floor((Date.parse(acct.expire) - now.getTime()) / DAY) : null
      if (days !== null && days <= 14) {
        cards.push(card(`expiry:${block.week}`, `your LinkedIn connection in GHL expires in ${days} day(s).`, [
          'Reconnect it in GHL → Social Planner (Speakfunnels sub-account), or the posts stop.',
        ]))
      }
    } catch (e) {
      cards.push(card(`account:${today}`, "can't use your LinkedIn in GHL.", [`${(e as Error).message}.`, 'Nothing can be scheduled until this is fixed.']))
      return { cards, notes }
    }
  }

  // ① RESEARCH (normally Saturday), with a quality gate: the brief must hold enough items
  // the writer can actually use (research.ts, gradeBrief). A thin one gets ONE more search,
  // aimed at what's missing. The first brief is saved before that search, so a slow or
  // failed second search can never cost the week its research.
  const saved = await db.from('linkedin_autopilot').select('data').eq('kind', 'research').eq('week', block.week).maybeSingle()
  const research = test?.as === 'saved' ? { data: { text: test.brief } } : saved.data
  if (!research) {
    log('step: research')
    try {
      const history = await sourceHistory(db, now)
      let text = test?.as === 'search' ? test.brief : await researchBrief(anthropic, now, { avoidHosts: history.unreadable })
      if (!text) throw new Error('the web search came back with no sourced items')
      const first = gradeBrief(text, history)
      let grade = first
      if (!args.dryRun) {
        const { error } = await db
          .from('linkedin_autopilot')
          .insert({ week: block.week, kind: 'research', status: 'ready', data: { text, usable: first.usable.length } })
        if (duplicate(error)) return { cards, notes: [...notes, `research for ${block.week} was already saved by another run`] }
        if (error) throw new Error(`saving the brief: ${error.message}`)
      }
      let more = ''
      if (first.usable.length < MIN_USABLE) {
        const gap = `${first.usable.length} usable of ${first.items.length} item(s)`
        if (left() < 60_000) notes.push(`research: ${gap}, and no time left to search again; the writer works with these`)
        else {
          log(`step: research again (${gap})`)
          try {
            more = await researchBrief(anthropic, now, {
              avoidHosts: history.unreadable,
              topUp: { brief: text, usable: first.usable.length, unusable: first.unusable, usedUrls: history.usedUrls },
              timeoutMs: left() - 10_000,
            })
          } catch (e) {
            notes.push(`research: the second search failed (${(e as Error).message}); the writer works with the first brief`)
          }
          if (more) {
            text = `${text}\n\nMORE ITEMS (a second search, aimed at what the first one missed):\n\n${more}`
            grade = gradeBrief(text, history)
            if (!args.dryRun) {
              const { error } = await db
                .from('linkedin_autopilot')
                .update({ data: { text, usable: grade.usable.length, first_usable: first.usable.length }, updated_at: new Date().toISOString() })
                .eq('kind', 'research')
                .eq('week', block.week)
              if (error) notes.push(`research: saving the second search: ${error.message}`)
            }
          }
        }
      }
      notes.push(
        `research brief ${args.dryRun ? 'ready (not saved: dry run)' : 'saved'} for ${block.week}: ${grade.usable.length} usable item(s)` +
          `${more ? ` (${first.usable.length} before the second search)` : ''}`,
      )
      return { cards, notes, preview: args.dryRun ? { kind: 'research', first, more, final: grade, brief: text } : undefined }
    } catch (e) {
      notes.push(`research failed: ${(e as Error).message}`)
      // One card a day, and only once it starts to matter (Sunday on).
      if (now.getTime() > block.opens.getTime() + DAY) {
        cards.push(card(`research:${block.week}:${today}`, `couldn't research this week's posts (${block.week}).`, [
          `${(e as Error).message}.`, 'It tries again tomorrow morning; slots too close by then stay empty.',
        ]))
      }
      return { cards, notes }
    }
  }
  const briefText = String((research as any).data?.text ?? '')
  // How many usable items the brief had (saved since 2026-11-15; graded again below for older rows).
  let briefUsable: number | undefined = (research as any).data?.usable
  const thinLine = () => (briefUsable !== undefined && briefUsable < MIN_USABLE ? [`This week's research found only ${briefUsable} usable source(s).`] : [])

  // Which slots are still open: far enough ahead to write today and schedule tomorrow,
  // not already taken by a post scheduled in GHL (a manual one), not already handled.
  const taken = await scheduledTimes(new Date(block.slots[0].at.getTime() - HOUR), new Date(block.slots[2].at.getTime() + HOUR))
  const { data: rowData } = await db
    .from('linkedin_autopilot')
    .select('id, slot, status, data, attempts, note')
    .eq('kind', 'post')
    .eq('week', block.week)
    .order('slot')
  const rows = (rowData ?? []) as PostRow[]
  // This week's posts so far (oldest first): the second try avoids their sources and continues their rotation.
  const weekPosts: WrittenPost[] = rows.filter((r) => ['drafted', 'scheduled'].includes(r.status) && r.data?.post).map((r) => r.data.post as WrittenPost)
  const handled = new Set(rows.map((r) => Date.parse(r.slot)))
  const open = block.slots.filter(
    (s) => s.at.getTime() >= now.getTime() + WRITE_AHEAD && !handled.has(s.at.getTime()) && !slotTaken(taken, s.at.getTime()),
  )

  // What the writer and the checks need, read once per run (both writing passes share it).
  let writerCtx: Promise<{ facts: string; leoNotes: WriterNote[]; noteNumbers: string[]; noteNames: string[]; recent: any[]; history: { unreadable: string[]; usedUrls: string[] } }> | null = null
  const context = (before: Date) =>
    (writerCtx ??= (async () => {
      const facts = await loadWeekFacts(db, now)
      // Leo's own notes (his wins sheet): approved facts he adds himself. If the sheet can't be
      // read, the week goes ahead on the facts already on file, and he's told once.
      let leoNotes: WriterNote[] = []
      let noteNumbers: string[] = []
      let noteNames: string[] = []
      if (sourcesConfigured()) {
        try {
          const wins = await fetchWins()
          const { data: past } = await db
            .from('linkedin_autopilot')
            .select('slot, data')
            .eq('kind', 'post')
            .eq('status', 'scheduled')
            .gte('slot', new Date(now.getTime() - 84 * DAY).toISOString())
          const usedOn = new Map<string, string>()
          for (const r of past ?? []) for (const id of (r as any).data?.post?.leo_notes_used ?? []) usedOn.set(id, dayLabel(new Date((r as any).slot)))
          leoNotes = wins.slice(0, 40).map((w) => ({ id: w.id, date: w.date, type: w.type, text: w.text, numbers: w.numbers, usedOn: usedOn.get(w.id) }))
          noteNumbers = wins.flatMap((w) => numbersIn(`${w.text} ${w.numbers}`))
          noteNames = wins.flatMap((w) => clientNames(w.client))
          notes.push(`wins sheet: ${wins.length} note(s), ${leoNotes.filter((n) => !n.usedOn).length} not used yet`)
        } catch (e) {
          const msg = (e as Error).message
          notes.push(`wins sheet: ${msg}`)
          cards.push(card(`wins:${block.week}`, "couldn't read your wins sheet.", [`${msg}.`, "This week's posts use only the facts already on file."]))
        }
      }
      const { data: recent } = await db
        .from('linkedin_posts')
        .select('slot, topic, hook_type')
        .neq('status', 'skipped')
        .lt('slot', before.toISOString())
        .order('slot', { ascending: false })
        .limit(3)
      return { facts: facts.text, leoNotes, noteNumbers, noteNames, recent: recent ?? [], history: await sourceHistory(db, now) }
    })())

  // One candidate: the source page first (a paid call, so not for a site the checker can't
  // open), then the plain-code rules. The same checks on both writing passes.
  const checkAll = async (posts: WrittenPost[], pass: 1 | 2): Promise<Checked[]> => {
    const ctx = await context(block.slots[0].at)
    return Promise.all(
      posts.map(async (p) => {
        const problems: string[] = []
        let excerpts: string[] = []
        let page = ''
        const host = hostOf(p.source_url)
        if (!p.source_url) problems.push("its source link wasn't in the research brief")
        else if (ctx.history.unreadable.some((h) => host === h || host.endsWith(`.${h}`))) problems.push(`the checker can't open ${host}, so it wasn't checked`)
        else {
          const v = await verifyPost(anthropic, p, { timeoutMs: Math.max(10_000, left() - 5_000) }).catch((e) => ({
            ok: false, problems: [`source check failed: ${(e as Error).message}`], excerpts: [], page: '',
          }))
          problems.push(...v.problems)
          excerpts = v.excerpts
          page = v.page
        }
        problems.push(...lintPost(p, { sourceNumbers: excerpts.flatMap(numbersIn), neverName: [...args.neverName, ...ctx.noteNames], factNumbers: ctx.noteNumbers }))
        problems.push(...quoteProblems(p.body, p.source_quotes, excerpts))
        return { post: p, problems, excerpts, page, pass }
      }),
    )
  }
  // Sites that wouldn't open this run: kept on the research row, so next week's brief skips them.
  const remember = async (checked: Checked[]) => {
    const hosts = [...new Set(checked.flatMap((c) => c.problems.map((p) => CANT_OPEN.exec(p)?.[1]).filter((h): h is string => !!h)))]
    const known: string[] = (research as any).data?.unreadable ?? []
    const add = hosts.filter((h) => !known.includes(h))
    if (!add.length || args.dryRun || test) return
    const data = { ...(research as any).data, unreadable: [...known, ...add] }
    ;(research as any).data = data
    await db.from('linkedin_autopilot').update({ data }).eq('kind', 'research').eq('week', block.week)
  }
  const preview: { checked: Checked[]; decisions: { slot: string; pass: 1 | 2; status: string; hook?: string; why?: string }[]; scheduled?: unknown } = {
    checked: [],
    decisions: [],
  }
  /** Why the drafts failed, in a few words: each distinct first problem once. */
  const reasons = (bad: Checked[], n: number) => [...new Set(bad.map((b) => b.problems[0]).filter(Boolean))].slice(0, n).join('; ') || 'the writer returned too few posts'
  const rejectedOf = (bad: Checked[]): RejectedDraft[] => bad.map((b) => ({ post: b.post, problems: b.problems, excerpts: b.excerpts }))
  const dropCard = (slot: string, why: string) =>
    cards.push(card(`dropped:${slot}`, `no post for ${dayLabel(new Date(slot))}.`, [why, ...thinLine(), 'Nothing was posted; the slot stays empty.']))

  // ②b THE SECOND WRITING PASS: once, for slots nothing passed in. It may fix a failed draft (its
  // page opened; only its wording was wrong) or use another brief item, and every post goes through
  // the same checks. Runs in the same morning when there's time, otherwise on the next one while
  // the slot is still far enough ahead; after that the slot is dropped and Leo gets the card.
  const secondTry = async (pending: PostRow[]) => {
    const due: PostRow[] = []
    for (const r of pending) {
      const at = Date.parse(r.slot)
      const why = slotTaken(taken, at)
        ? 'taken'
        : at < now.getTime() + WRITE_AHEAD
          ? 'too close'
          : (r.attempts ?? 0) >= 2
            ? 'tried'
            : ''
      if (!why) {
        due.push(r)
        continue
      }
      const first = (r.note ?? '').replace(/^no draft passed the checks:\s*/, '')
      const late = why === 'tried' ? "the second try didn't finish in time" : 'there was no time left for a second try'
      const note = why === 'taken' ? 'slot taken by a manual post' : `no draft passed the checks: ${first}; ${late}`
      preview.decisions.push({ slot: dayLabel(new Date(at)), pass: 2, status: 'dropped', why: note })
      if (why !== 'taken') dropCard(r.slot, `None of the drafts passed the safety checks (${clip(first || 'too few drafts', 200)}), and ${late}.`)
      if (!args.dryRun) {
        await db.from('linkedin_autopilot').update({ status: 'dropped', note, updated_at: new Date().toISOString() }).eq('id', r.id).eq('status', 'rewrite')
      }
    }
    if (!due.length) return
    const labels = due.map((r) => dayLabel(new Date(r.slot))).join(', ')
    if (Date.now() - started > SECOND_PASS_BY) {
      notes.push(`second try for ${labels} waits for tomorrow's run (not enough time left in this one)`)
      return
    }
    log(`step: second try for ${labels}`)
    // Counted before the calls: a run cut off mid-try gets one more morning, never a loop.
    if (!args.dryRun) for (const r of due) await db.from('linkedin_autopilot').update({ attempts: (r.attempts ?? 0) + 1 }).eq('id', r.id).eq('status', 'rewrite')
    const ctx = await context(new Date(due[0].slot))
    const grade = gradeBrief(briefText, ctx.history)
    briefUsable ??= grade.usable.length
    const failed = new Map<string, RejectedDraft>()
    for (const r of due) for (const d of (r.data?.rejected ?? []) as RejectedDraft[]) if (d.post?.body) failed.set(d.post.body, d)
    const repairable = [...failed.values()].filter((d) => fixable(d.problems))
    const skip = skipList(grade)
    for (const d of failed.values())
      if (!fixable(d.problems) && d.post.source_url && !skip.some((s) => s.startsWith(`${d.post.source_url}:`)))
        skip.push(`${d.post.source_url}: its draft failed the checks (${clip(d.problems[0] ?? '', 120)})`)
    const others = [...weekPosts]
    const lastHooks = [...others.map((p) => p.hook_type).reverse(), ...ctx.recent.map((r: any) => r.hook_type)].filter(Boolean) // newest first
    let written: WrittenPost[] = []
    try {
      written = await writePosts(anthropic, {
        count: due.length + 1, // one spare
        research: briefText,
        facts: ctx.facts,
        avoidHookTypes: lastHooks.slice(0, 3),
        avoidTopic: others[others.length - 1]?.topic ?? ctx.recent[0]?.topic ?? null,
        days: due.map((r) => dayLabel(new Date(r.slot))),
        notes: ctx.leoNotes,
        skip,
        retry: { taken: others.map((p) => p.source_url).filter(Boolean), rejected: repairable },
        timeoutMs: Math.max(20_000, left() - 45_000),
      })
    } catch (e) {
      notes.push(`second try for ${labels}: the writer failed (${(e as Error).message}); tomorrow's run tries again if there's still time`)
      return
    }
    const checked = await checkAll(written, 2)
    preview.checked.push(...checked)
    await remember(checked)
    const good = checked.filter((c) => !c.problems.length)
    const bad = checked.filter((c) => c.problems.length)
    for (const b of bad) notes.push(`second try dropped "${clip(b.post.body.split('\n')[0], 70)}": ${b.problems.join('; ')}`)
    const take = rotation(others[others.length - 1]?.topic ?? ctx.recent[0]?.topic ?? null, lastHooks)
    const pool = [...good]
    for (const r of due) {
      const c = take(pool)
      const label = dayLabel(new Date(r.slot))
      if (c) {
        preview.decisions.push({ slot: label, pass: 2, status: 'drafted', hook: c.post.body.split('\n')[0] })
        weekPosts.push(c.post)
        if (!args.dryRun) {
          await db
            .from('linkedin_autopilot')
            .update({ status: 'drafted', note: null, data: { post: c.post, page: c.page, excerpts: c.excerpts, second_try: true }, updated_at: new Date().toISOString() })
            .eq('id', r.id)
            .eq('status', 'rewrite')
        }
        continue
      }
      const why = reasons(bad, 2)
      preview.decisions.push({ slot: label, pass: 2, status: 'dropped', why })
      if (!args.dryRun) {
        await db
          .from('linkedin_autopilot')
          .update({ status: 'dropped', note: `no draft passed the checks, even on a second try: ${why}`, updated_at: new Date().toISOString() })
          .eq('id', r.id)
          .eq('status', 'rewrite')
      }
      dropCard(r.slot, `None of the drafts passed the safety checks, even on a second try (${clip(why, 200)}).`)
    }
    notes.push(`second try: ${good.length} of ${written.length} drafts passed; ${Math.min(good.length, due.length)} of ${due.length} slot(s) filled`)
  }

  // ② WRITE + CHECK (normally Sunday).
  if (open.length) {
    log(`step: write ${open.length} post(s) for ${open.map((s) => s.label).join(', ')}`)
    const ctx = await context(open[0].at)
    const grade = gradeBrief(briefText, ctx.history)
    briefUsable ??= grade.usable.length
    const written = await writePosts(anthropic, {
      count: open.length + 2, // two spares: the checks drop anything not exactly right
      research: briefText,
      facts: ctx.facts,
      avoidHookTypes: ctx.recent.map((r: any) => r.hook_type).filter(Boolean),
      avoidTopic: ctx.recent[0]?.topic ?? null,
      days: open.map((s) => s.label),
      notes: ctx.leoNotes,
      skip: skipList(grade),
      timeoutMs: Math.min(180_000, Math.max(30_000, left() - 60_000)),
    })
    // Check the posts the slots need first, and the spares only if one of those fails: each
    // source check is a paid call (this keeps the week near US$2 with the second passes added).
    const checked = await checkAll(written.slice(0, open.length), 1)
    const spares = written.slice(open.length)
    if (spares.length && checked.filter((c) => !c.problems.length).length < open.length) {
      if (left() > 45_000) checked.push(...(await checkAll(spares, 1)))
      else notes.push(`no time left to check the ${spares.length} spare(s)`)
    }
    preview.checked.push(...checked)
    await remember(checked)
    const good = checked.filter((c) => !c.problems.length)
    const bad = checked.filter((c) => c.problems.length)
    for (const b of bad) notes.push(`dropped "${clip(b.post.body.split('\n')[0], 70)}": ${b.problems.join('; ')}`)
    const take = rotation(ctx.recent[0]?.topic ?? null, ctx.recent.map((r: any) => r.hook_type))
    const pool = [...good]
    const pending: PostRow[] = []
    for (const slot of open) {
      const c = take(pool)
      const why = reasons(bad, 3)
      const row: { week: string; kind: string; slot: string; status: string; data: unknown; note?: string } = c
        ? { week: block.week, kind: 'post', slot: slot.at.toISOString(), status: 'drafted', data: { post: c.post, page: c.page, excerpts: c.excerpts } }
        : { week: block.week, kind: 'post', slot: slot.at.toISOString(), status: 'rewrite', note: `no draft passed the checks: ${why}`, data: { rejected: rejectedOf(bad) } }
      preview.decisions.push({ slot: slot.label, pass: 1, status: row.status, ...(c ? { hook: c.post.body.split('\n')[0] } : { why }) })
      if (c) weekPosts.push(c.post)
      if (args.dryRun) {
        if (!c) pending.push({ id: -pending.length - 1, slot: row.slot, status: row.status, data: row.data, attempts: 0, note: row.note })
        continue
      }
      const { data: ins, error } = await db.from('linkedin_autopilot').insert(row).select('id, slot, status, data, attempts, note').single()
      if (error && !duplicate(error)) notes.push(`saving ${slot.label}: ${error.message}`)
      if (!c && ins) pending.push(ins as PostRow)
    }
    notes.push(`${good.length} of ${written.length} drafts passed (${checked.length} checked); ${Math.min(good.length, open.length)} of ${open.length} slot(s) filled`)
    if (pending.length) await secondTry(pending)
    return { cards, notes, preview: args.dryRun ? preview : undefined }
  }

  // ③ PHOTOS + SLIDES + SCHEDULE (normally Monday). One post at a time, within the run's budget.
  const drafted = rows.filter((x) => x.status === 'drafted')
  const rewrites = rows.filter((x) => x.status === 'rewrite')
  // A quiet morning (Tue-Fri): nothing to schedule or rewrite, so sort Leo's new photos instead.
  if (!drafted.length && !rewrites.length) {
    await catalogue(100_000, 15)
    return { cards, notes }
  }
  // Photos he added over the weekend still count for this week's covers.
  if (drafted.length) await catalogue(25_000, 3)
  /** Schedule one drafted post. 'stop' = out of time this run (the rest go tomorrow). */
  const schedule = async (r: PostRow): Promise<'stop' | void> => {
    const slot = new Date(r.slot)
    const label = dayLabel(slot)
    if (slot.getTime() < now.getTime() + 2 * HOUR) {
      if (!args.dryRun) {
        await db.from('linkedin_autopilot').update({ status: 'failed', note: 'missed: the slot came before it could be scheduled', updated_at: now.toISOString() }).eq('id', r.id)
      }
      cards.push(card(`failed:${r.slot}`, `no post for ${label}.`, ['It was written but never scheduled in time.', 'Nothing was posted.']))
      return
    }
    if (Date.now() - started > 150_000) {
      notes.push(`out of time this run; ${label} is scheduled tomorrow`)
      return 'stop'
    }
    // A dry run draws the first post only; the rest are just listed.
    if (args.dryRun && preview.scheduled) {
      notes.push(`${label}: would be scheduled next (not drawn in a dry run)`)
      return
    }
    const post = r.data?.post as WrittenPost
    log(`step: schedule ${label}`)
    try {
      // Ask GHL again before drawing and sending: a manual post (/linkedin-posts) may have taken
      // this slot since Sunday's check in ②. The manual post wins; this one is dropped, with no
      // card (the slot isn't empty). A failed check lands in the catch below, so nothing is sent.
      if (slotTaken(await scheduledTimes(new Date(slot.getTime() - HOUR), new Date(slot.getTime() + HOUR)), slot.getTime())) {
        notes.push(`${label}: slot taken by a manual post in GHL, so this one ${args.dryRun ? 'would be' : 'was'} dropped`)
        if (!args.dryRun) await db.from('linkedin_autopilot').update({ status: 'dropped', note: 'slot taken by a manual post', updated_at: new Date().toISOString() }).eq('id', r.id)
        return
      }
      if (!args.pexelsKey) throw new Error('PEXELS_API_KEY is not set on Vercel')
      const images = await pickImages(anthropic, args.pexelsKey, post.body.split('\n')[0], post.image_queries)
      // One of Leo's own photos as the cover, when it fits this post (photos.ts). The stock cover stays the fallback.
      let cover: Awaited<ReturnType<typeof pickCover>> = null
      if (sourcesConfigured()) {
        try {
          cover = await pickCover({ db, anthropic, week: block.week, slot, post, log })
        } catch (e) {
          notes.push(`${label}: kept the stock cover (${(e as Error).message})`)
        }
      }
      const slides = await renderCarousel(post.carousel, cover ? { ...images, cover: cover.dataUri, coverFocus: cover.focus } : images)
      const slug = slugOf(post.body)
      const firstComment = `Source: ${post.body.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/^Source:\s*/, '') ?? ''}: ${post.source_url}`
      if (args.dryRun) {
        preview.scheduled = { slot: r.slot, images, cover: cover && { id: cover.id, name: cover.name, why: cover.why }, slides, firstComment, body: post.body }
        return
      }
      const id = await scheduleCarousel({ body: post.body, slides, slug, firstComment, slot })
      const coverPhoto = cover ? { id: cover.id, name: cover.name, why: cover.why } : null
      await db.from('linkedin_autopilot').update({ status: 'scheduled', ghl_post_id: id, note: null, data: { ...r.data, images: images.ids, cover_photo: coverPhoto, first_comment: firstComment }, updated_at: new Date().toISOString() }).eq('id', r.id)
      if (cover) await markPhotoUsed(db, cover.id, slot)
      // The calendar copy the Sunday checks (and the laptop) read, so nothing repeats.
      await db.from('linkedin_posts').upsert(
        {
          file: `auto/${new Date(slot.getTime() + MYT).toISOString().slice(0, 10)}-${slug}.md`,
          status: 'scheduled',
          slot: slot.toISOString(),
          topic: post.topic,
          hook_type: post.hook_type,
          photo: cover ? `drive:${cover.name}` : `pexels-${images.ids[0]}`,
          hook: post.body.split('\n')[0].trim(),
          source: `autopilot: ${post.source_url}`,
          ghl_post_id: id,
          created_at: now.toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'file' },
      )
      notes.push(`scheduled ${label} (GHL ${id})`)
    } catch (e) {
      const msg = (e as Error).message
      const last = slot.getTime() < now.getTime() + 26 * HOUR // no morning run left before the slot
      if (!args.dryRun) {
        await db
          .from('linkedin_autopilot')
          .update({ status: last ? 'failed' : 'drafted', attempts: (r.attempts ?? 0) + 1, note: msg, updated_at: new Date().toISOString() })
          .eq('id', r.id)
      }
      notes.push(`${label}: ${msg}${last ? ' (gave up)' : ' (retry tomorrow)'}`)
      if (last) cards.push(card(`failed:${r.slot}`, `no post for ${label}.`, [`Scheduling failed: ${clip(msg, 220)}.`, 'Nothing was posted.']))
    }
  }
  // Order: the post that must go out before tomorrow's run first, then a second writing pass
  // (while it can still reach its slot), then the rest, which tomorrow's run picks up if time runs out.
  const urgent = drafted.filter((r) => Date.parse(r.slot) < now.getTime() + 26 * HOUR)
  let stopped = false
  for (const r of urgent) if ((await schedule(r)) === 'stop') { stopped = true; break }
  if (rewrites.length) await secondTry(rewrites)
  if (!stopped) for (const r of drafted.filter((x) => !urgent.includes(x))) if ((await schedule(r)) === 'stop') break
  return { cards, notes, preview: args.dryRun ? preview : undefined }
}

const slugOf = (body: string) =>
  body.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'post'
