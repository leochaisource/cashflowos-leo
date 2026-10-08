import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/linkedin-ideas-dry-run.ts (Node type stripping).
import { failedCard, failedKey, ideaCard, ideaKey, isIdeasDay, isoWeek } from './definition.ts'
import { loadFailedPosts, loadWeekFacts } from './load.ts'
import { draftAngles } from './prompt.ts'

// The whole LinkedIn Ideas check, shared by the daily cron (via agents/registry.ts)
// and scripts/linkedin-ideas-dry-run.ts. It only RETURNS proposals to create —
// the cron (or the script) creates them; nothing here posts anything anywhere.

export type LinkedInDraft = { idempotencyKey: string; payload: any; text: string }

export async function linkedinDrafts(args: {
  db: SupabaseClient | null
  anthropic: Anthropic | null
  now: Date
  /** Dry-run only: pretend it's Sunday. */
  forceIdeasDay?: boolean
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

  // ② Sundays: this week's angles.
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
  if (!facts.sections) return { drafts, notes: [...notes, 'a quiet week — nothing to pitch'] }

  const angles = await draftAngles(anthropic, facts.text)
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
