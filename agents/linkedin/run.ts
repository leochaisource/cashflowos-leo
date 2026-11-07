import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/linkedin-ideas-dry-run.ts (Node type stripping).
import { AUTOPILOT, failedCard, failedKey, ideaCard, ideaKey, isIdeasDay, isoWeek } from './definition.ts'
import { loadFailedPosts, loadWeekFacts } from './load.ts'
import { draftAngles } from './prompt.ts'
import { researchBrief } from './research.ts'
import { autopilotStep } from './autopilot.ts'

// The whole LinkedIn check, shared by the daily cron (via agents/registry.ts)
// and the dry-run scripts. It RETURNS cards to send (failed posts, autopilot
// problems, or the Sunday idea menu). With AUTOPILOT on, this morning's autopilot
// step also runs from here, and that step is the only one that schedules posts.

export type LinkedInDraft = { idempotencyKey: string; payload: any; text: string }

export async function linkedinDrafts(args: {
  db: SupabaseClient | null
  anthropic: Anthropic | null
  now: Date
  /** Dry-run only: pretend it's Sunday. */
  forceIdeasDay?: boolean
  /** Autopilot: the Pexels key for stock photos, and names that must never appear in a post. */
  pexelsKey?: string | null
  neverName?: string[]
  /** Scripts: run the autopilot step without saving or scheduling anything. */
  autopilotDryRun?: boolean
}): Promise<{ drafts: LinkedInDraft[]; notes: string[] }> {
  const { db, anthropic, now } = args
  const drafts: LinkedInDraft[] = []
  const notes: string[] = []

  // ① Any day: a post that failed to publish.
  try {
    for (const p of await loadFailedPosts(now)) {
      drafts.push({
        idempotencyKey: failedKey(p.id),
        payload: { kind: 'failed_post', ghl_post_id: p.id, when: p.when, text: `LinkedIn post failed: ${p.firstLine}` },
        text: failedCard(p),
      })
    }
  } catch (e) {
    notes.push(`failed-post check skipped: ${(e as Error).message}`)
  }

  // ② AUTOPILOT: this morning's step of the weekly run (research / write / schedule).
  if (AUTOPILOT) {
    if (!db) return { drafts, notes: [...notes, 'no database — autopilot skipped'] }
    if (!anthropic) return { drafts, notes: [...notes, 'ANTHROPIC_API_KEY not set — autopilot skipped'] }
    try {
      const r = await autopilotStep({ db, anthropic, now, pexelsKey: args.pexelsKey ?? null, neverName: args.neverName ?? [], dryRun: args.autopilotDryRun })
      drafts.push(...r.cards)
      notes.push(...r.notes)
    } catch (e) {
      const msg = (e as Error).message
      notes.push(`autopilot step failed: ${msg}`)
      const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
      drafts.push({
        idempotencyKey: `linkedin-auto:error:${day}`,
        payload: { kind: 'auto_note', text: `LinkedIn autopilot error: ${msg}` },
        text: `⚠️ <b>LinkedIn autopilot</b>: this morning's step failed.\n${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\nIt tries again tomorrow morning.\n\n✅ or ❌ = seen.`,
      })
    }
    return { drafts, notes }
  }

  // ② (autopilot off) Sundays: this week's angles.
  if (!(args.forceIdeasDay || isIdeasDay(now))) return { drafts, notes }
  if (!db) return { drafts, notes: [...notes, 'no database — no angles'] }
  if (!anthropic) return { drafts, notes: [...notes, 'ANTHROPIC_API_KEY not set — no angles'] }

  const week = isoWeek(now)
  // Already pitched this week (a re-run, or the dry run sent them)? Don't pay for a second call.
  const { data: existing } = await db
    .from('agent_actions')
    .select('id')
    .like('idempotency_key', `linkedin-ideas:${week}:%`)
    .limit(1)
  if (existing?.length) return { drafts, notes: [...notes, `angles for ${week} already sent`] }

  const facts = await loadWeekFacts(db, now)
  if (facts.unavailable.length) notes.push(`could not read: ${facts.unavailable.join('; ')}`)

  // The outside world: leaders, AI-forward companies, research, creator topics. A
  // failed search costs the evidence, not the menu: the angles still go out.
  let research = ''
  try {
    research = await researchBrief(anthropic, now)
    if (!research) notes.push('research brief came back empty')
  } catch (e) {
    notes.push(`research skipped: ${(e as Error).message}`)
  }
  if (!facts.sections && !research) return { drafts, notes: [...notes, 'a quiet week and no research — nothing to pitch'] }

  const angles = await draftAngles(anthropic, facts.text, research)
  angles.forEach((a, i) => {
    drafts.push({
      idempotencyKey: ideaKey(week, i + 1),
      payload: { kind: 'idea', week, n: i + 1, ...a, text: a.hook },
      text: ideaCard(a, i + 1, angles.length),
    })
  })
  if (!angles.length) notes.push('model returned no angles')
  return { drafts, notes }
}
