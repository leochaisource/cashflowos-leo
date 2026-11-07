import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/linkedin-autopilot-dry-run.ts (Node type stripping).
import { isoWeek } from './definition.ts'
import { loadWeekFacts } from './load.ts'
import { researchBrief } from './research.ts'
import { writePosts, type WrittenPost } from './write.ts'
import { verifyPost } from './verify.ts'
import { lintPost, numbersIn, quoteProblems } from './checks.ts'
import { pickImages } from './images.ts'
import { renderCarousel } from './slides.ts'
import { leoAccount, scheduleCarousel, scheduledTimes } from './publish.ts'

// 👉 THE LINKEDIN AUTOPILOT (owner's call, 2026-11-07): every week it researches,
// writes, checks, illustrates and schedules Leo's Tue/Wed/Thu 09:00 posts with
// nobody approving them. Leo hears from it only when a slot ends up empty or a
// post can't be scheduled (a Telegram card), never when things go right.
//
// It rides the 9am daily cron (Vercel Hobby allows only two crons, each run has
// 300s), so the week is split into one heavy step per morning, each saved in
// linkedin_autopilot (supabase/linkedin-autopilot.sql) so the next one picks up:
//   Saturday   research brief (web search)                 → research row
//   Sunday     write posts + one spare, fact-check each    → post rows 'drafted' / 'dropped'
//   Monday     pick photos, draw slides, schedule in GHL   → 'scheduled' / retried tomorrow / 'failed'
// A missed step is retried the next morning while the slot is still far enough
// ahead. A doubled cron delivery is harmless: rows are unique per week and per slot.
//
// What may be said about Leo is a closed list (kit.ts); every post passes plain-
// code checks (checks.ts) and a source check that opens the page (verify.ts).

const MYT = 8 * 3600_000
const DAY = 86_400_000
const HOUR = 3600_000

export type AutopilotCard = { idempotencyKey: string; payload: any; text: string }
export type Slot = { at: Date; label: string }

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
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

/** Was this Postgres error "that row already exists" (a doubled cron run)? */
const duplicate = (e: { code?: string } | null) => e?.code === '23505'

export async function autopilotStep(args: {
  db: SupabaseClient
  anthropic: Anthropic
  now: Date
  pexelsKey: string | null
  /** Run-time names to keep out of posts (projects, competitors). */
  neverName: string[]
  /** Dry run: do everything except GHL scheduling and database writes. */
  dryRun?: boolean
  log?: (s: string) => void
}): Promise<{ cards: AutopilotCard[]; notes: string[]; preview?: unknown }> {
  const { db, anthropic, now } = args
  const cards: AutopilotCard[] = []
  const notes: string[] = []
  const log = args.log ?? (() => {})
  const block = postingBlock(now)
  if (now < block.opens) return { cards, notes: [`autopilot idle until ${block.opens.toISOString().slice(0, 10)} (week ${block.week})`] }
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

  // ① RESEARCH (normally Saturday).
  const { data: research } = await db.from('linkedin_autopilot').select('data').eq('kind', 'research').eq('week', block.week).maybeSingle()
  if (!research) {
    log('step: research')
    try {
      const text = await researchBrief(anthropic, now)
      if (!text) throw new Error('the web search came back with no sourced items')
      if (!args.dryRun) {
        const { error } = await db.from('linkedin_autopilot').insert({ week: block.week, kind: 'research', status: 'ready', data: { text } })
        if (error && !duplicate(error)) throw new Error(`saving the brief: ${error.message}`)
      }
      notes.push(`research brief saved for ${block.week}`)
      return { cards, notes, preview: args.dryRun ? text : undefined }
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

  // Which slots are still open: far enough ahead to write today and schedule tomorrow,
  // not already taken by a post scheduled in GHL (a manual one), not already handled.
  const taken = await scheduledTimes(new Date(block.slots[0].at.getTime() - HOUR), new Date(block.slots[2].at.getTime() + HOUR))
  const { data: rows } = await db.from('linkedin_autopilot').select('id, slot, status, data, attempts').eq('kind', 'post').eq('week', block.week).order('slot')
  const handled = new Set((rows ?? []).map((r: any) => Date.parse(r.slot)))
  const open = block.slots.filter(
    (s) => s.at.getTime() >= now.getTime() + 25 * HOUR && !handled.has(s.at.getTime()) && !taken.some((t) => Math.abs(t - s.at.getTime()) < 30 * 60_000),
  )

  // ② WRITE + CHECK (normally Sunday).
  if (open.length) {
    log(`step: write ${open.length} post(s) for ${open.map((s) => s.label).join(', ')}`)
    const facts = await loadWeekFacts(db, now)
    const { data: recent } = await db
      .from('linkedin_posts')
      .select('slot, topic, hook_type')
      .neq('status', 'skipped')
      .lt('slot', open[0].at.toISOString())
      .order('slot', { ascending: false })
      .limit(3)
    const written = await writePosts(anthropic, {
      count: open.length + 2, // two spares: the checks drop anything not exactly right
      research: String((research as any).data?.text ?? ''),
      facts: facts.text,
      avoidHookTypes: (recent ?? []).map((r: any) => r.hook_type).filter(Boolean),
      avoidTopic: (recent ?? [])[0]?.topic ?? null,
      days: open.map((s) => s.label),
    })
    // Check every candidate (in parallel): the source page first, then the plain-code rules.
    const checked = await Promise.all(
      written.map(async (p) => {
        const problems: string[] = []
        let excerpts: string[] = []
        let page = ''
        if (!p.source_url) problems.push("its source link wasn't in the research brief")
        else {
          const v = await verifyPost(anthropic, p).catch((e) => ({ ok: false, problems: [`source check failed: ${(e as Error).message}`], excerpts: [], page: '' }))
          problems.push(...v.problems)
          excerpts = v.excerpts
          page = v.page
        }
        problems.push(...lintPost(p, { sourceNumbers: excerpts.flatMap(numbersIn), neverName: args.neverName }))
        problems.push(...quoteProblems(p.body, p.source_quotes, excerpts))
        return { post: p, problems, excerpts, page }
      }),
    )
    const good = checked.filter((c) => !c.problems.length)
    const bad = checked.filter((c) => c.problems.length)
    for (const b of bad) notes.push(`dropped "${clip(b.post.body.split('\n')[0], 70)}": ${b.problems.join('; ')}`)
    if (args.dryRun) return { cards, notes, preview: checked }
    // Rotation (linkedin skill, Step 0): no topic twice in a row, no hook type from the last 3 posts.
    // Prefer a post that keeps both; settle for a new topic; take what's left only as a last resort.
    const pool = [...good]
    let prevTopic: string | null = (recent ?? [])[0]?.topic ?? null
    const hooks: string[] = (recent ?? []).map((r: any) => r.hook_type)
    const take = () => {
      const fresh = (c: (typeof pool)[number]) => c.post.topic !== prevTopic
      let i = pool.findIndex((c) => fresh(c) && !hooks.slice(0, 3).includes(c.post.hook_type))
      if (i < 0) i = pool.findIndex(fresh)
      if (i < 0 && pool.length) i = 0
      if (i < 0) return undefined
      const [c] = pool.splice(i, 1)
      prevTopic = c.post.topic
      hooks.unshift(c.post.hook_type)
      return c
    }
    for (const slot of open) {
      const c = take()
      const row: { week: string; kind: string; slot: string; status: string; data: unknown; note?: string } = c
        ? { week: block.week, kind: 'post', slot: slot.at.toISOString(), status: 'drafted', data: { post: c.post, page: c.page, excerpts: c.excerpts } }
        : {
            week: block.week, kind: 'post', slot: slot.at.toISOString(), status: 'dropped',
            note: `no draft passed the checks: ${bad.map((b) => b.problems[0]).filter(Boolean).slice(0, 3).join('; ') || 'the writer returned too few posts'}`,
            data: { rejected: bad.map((b) => ({ hook: b.post.body.split('\n')[0], problems: b.problems })) },
          }
      const { error } = await db.from('linkedin_autopilot').insert(row)
      if (error && !duplicate(error)) notes.push(`saving ${slot.label}: ${error.message}`)
      if (!c && !error) {
        cards.push(card(`dropped:${slot.at.toISOString()}`, `no post for ${slot.label}.`, [
          `None of the drafts passed the safety checks (${clip(row.note ?? '', 220)}).`, 'Nothing was posted; the slot stays empty.',
        ]))
      }
    }
    notes.push(`${good.length} of ${written.length} drafts passed; ${Math.min(good.length, open.length)} slot(s) filled`)
    return { cards, notes }
  }

  // ③ PHOTOS + SLIDES + SCHEDULE (normally Monday). One post at a time, within the run's budget.
  const started = Date.now()
  for (const r of (rows ?? []).filter((x: any) => x.status === 'drafted')) {
    const slot = new Date(r.slot)
    const label = dayLabel(slot)
    if (slot.getTime() < now.getTime() + 2 * HOUR) {
      await db.from('linkedin_autopilot').update({ status: 'failed', note: 'missed: the slot came before it could be scheduled', updated_at: now.toISOString() }).eq('id', r.id)
      cards.push(card(`failed:${r.slot}`, `no post for ${label}.`, ['It was written but never scheduled in time.', 'Nothing was posted.']))
      continue
    }
    if (Date.now() - started > 150_000) {
      notes.push(`out of time this run; ${label} is scheduled tomorrow`)
      break
    }
    const post = r.data?.post as WrittenPost
    log(`step: schedule ${label}`)
    try {
      if (!args.pexelsKey) throw new Error('PEXELS_API_KEY is not set on Vercel')
      const images = await pickImages(anthropic, args.pexelsKey, post.body.split('\n')[0], post.image_queries)
      const slides = await renderCarousel(post.carousel, images)
      const slug = slugOf(post.body)
      const firstComment = `Source: ${post.body.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/^Source:\s*/, '') ?? ''}: ${post.source_url}`
      if (args.dryRun) return { cards, notes, preview: { slot: r.slot, images, slides, firstComment, body: post.body } }
      const id = await scheduleCarousel({ body: post.body, slides, slug, firstComment, slot })
      await db.from('linkedin_autopilot').update({ status: 'scheduled', ghl_post_id: id, note: null, data: { ...r.data, images: images.ids, first_comment: firstComment }, updated_at: new Date().toISOString() }).eq('id', r.id)
      // The calendar copy the Sunday checks (and the laptop) read, so nothing repeats.
      await db.from('linkedin_posts').upsert(
        {
          file: `auto/${new Date(slot.getTime() + MYT).toISOString().slice(0, 10)}-${slug}.md`,
          status: 'scheduled',
          slot: slot.toISOString(),
          topic: post.topic,
          hook_type: post.hook_type,
          photo: `pexels-${images.ids[0]}`,
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
      await db
        .from('linkedin_autopilot')
        .update({ status: last ? 'failed' : 'drafted', attempts: (r.attempts ?? 0) + 1, note: msg, updated_at: new Date().toISOString() })
        .eq('id', r.id)
      notes.push(`${label}: ${msg}${last ? ' (gave up)' : ' (retry tomorrow)'}`)
      if (last) cards.push(card(`failed:${r.slot}`, `no post for ${label}.`, [`Scheduling failed: ${clip(msg, 220)}.`, 'Nothing was posted.']))
    }
  }
  return { cards, notes }
}

const slugOf = (body: string) =>
  body.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'post'
