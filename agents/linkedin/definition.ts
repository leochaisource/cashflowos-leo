// 👉 THIS FILE IS YOURS TO READ — the LinkedIn Ideas agent's knobs.
//
// Every Sunday at 9am (Malaysia time) it reads what happened in the business this
// week and sends Leo 3–5 LinkedIn post ANGLES on Telegram, one ✅/❌ card each.
// ✅ only QUEUES the angle. The writing, the photo and the scheduling happen in
// the /linkedin-posts skill on Leo's laptop, where he approves every word. This
// agent never writes a finished post and has no code path to LinkedIn.
//
// It also watches for a scheduled post that FAILED to publish (GHL status
// "failed") and says so the same morning, any day of the week, so a missed post
// never fails silently.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE (type-only imports). The dry-run script
// runs this exact code under plain node, the same rule as agents/marketing.

export type WhenTrigger = 'on_photo' | 'on_new_record' | 'daily'

// ============================================================
// THE DIALS
// ============================================================

/** Day the angles arrive, in Malaysia time. 0 = Sunday. */
export const IDEAS_WEEKDAY = 0
/** Never more than this many cards in one go — it's a menu, not homework. */
export const MAX_ANGLES = 5
/** How far back "this week" reaches. */
export const LOOKBACK_DAYS = 7

const MYT_MS = 8 * 3600_000 // Malaysia is UTC+8 all year, no DST.

// ============================================================
// THE SHAPES
// ============================================================

/** One angle as the model returns it (validated by the JSON schema in prompt.ts). */
export type Angle = {
  hook: string // first line, must pass the hook gate (a number + a visual)
  angle: string // one line: what the post argues or tells
  hook_type: string // a type from linkedin/hooks.md
  topic: string // a topic from linkedin/profile.md §6
  source: string // which fact from the week it's built on
  client_data: boolean // true = built on a client's numbers → anonymise or get consent
}

/** A GHL post that failed to publish (from lib side: agents/linkedin/load.ts). */
export type FailedPost = { id: string; when: string; firstLine: string; error: string }

// ============================================================
// WHEN — Sunday in Malaysia, and which week it is
// ============================================================

export function mytWeekday(now: Date): number {
  return new Date(now.getTime() + MYT_MS).getUTCDay()
}

export function isIdeasDay(now: Date): boolean {
  return mytWeekday(now) === IDEAS_WEEKDAY
}

/** ISO-8601 week label in Malaysia time, e.g. "2026-W41". Keys the cards so a re-run never duplicates them. */
export function isoWeek(now: Date): string {
  const d = new Date(now.getTime() + MYT_MS)
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const wd = new Date(day).getUTCDay() || 7 // Mon=1 … Sun=7
  const thursday = new Date(day + (4 - wd) * 86_400_000)
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export const ideaKey = (week: string, n: number) => `linkedin-ideas:${week}:${n}`
export const failedKey = (postId: string) => `linkedin-failed:${postId}`

// ============================================================
// THE CARDS (Telegram HTML)
// ============================================================

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function ideaCard(a: Angle, n: number, total: number): string {
  return [
    `💼 <b>LinkedIn idea ${n}/${total}</b> · ${esc(a.hook_type)} · ${esc(a.topic)}`,
    '',
    `<b>${esc(a.hook)}</b>`,
    esc(a.angle),
    '',
    `<i>From: ${esc(a.source)}</i>`,
    ...(a.client_data ? ['⚠️ Built on client numbers: anonymise, or name them only with consent.'] : []),
    '',
    '✅ = queue it for your /linkedin-posts session. Nothing is posted from here.',
  ].join('\n')
}

export function failedCard(p: FailedPost): string {
  return [
    `⚠️ <b>A LinkedIn post FAILED to publish</b>`,
    `Scheduled: ${esc(p.when)}`,
    `“${esc(p.firstLine)}”`,
    p.error ? `GHL said: ${esc(p.error)}` : '',
    '',
    'Fix it in GHL → Social Planner (reconnect LinkedIn if it expired), or post it by hand.',
    '✅ = done / ❌ = dismiss.',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

// ============================================================
// The definition the rest of the app reads (same shape as agents/marketing).
// ============================================================
export const definition = {
  key: 'linkedin-ideas',
  when: 'daily' as WhenTrigger, // swept daily; angles only on IDEAS_WEEKDAY

  // ASK-BEFORE — ALWAYS 🟡. An idea is only ever queued on Leo's tap, and even a
  // queued idea is just a starting point for a chat where he approves the post.
  askBefore: () => true,
}
