import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with the dry-run scripts (Node type stripping).
import { AVATAR_DATA_URI } from './avatar.ts'
import { listPhotos, photoData, type DrivePhoto } from './sources.ts'

// 👉 LEO'S PHOTOS ON POSTS (owner, 2026-11-08): "a folder where I will continuously
// upload new portraits ... you gauge which portrait photo is suitable to use, don't be
// afraid to use the old photos if it is more relevant." Earlier rule, still standing
// (2026-10-21): his photo only when it's appropriate and fits the topic, not every post.
//
// Two jobs:
//   catalogue  every new photo in his Drive folder is looked at once (Claude, with his
//              face as the reference) and described in linkedin_photos: is it him, is
//              it fit for a professional post, does it work behind a headline, where
//              his face is, what kind of post it suits. On quiet mornings, a few at a time.
//   pickCover  on Monday, for each post, Claude reads those descriptions and says
//              whether one of his photos fits better than the stock cover. At most
//              MAX_PER_WEEK of the week's posts get his photo; recently used ones rest.
//
// A photo problem never stops a post: the stock cover is always ready as the fallback.

export const PHOTO_MODEL = 'claude-opus-5-5'
/** Posts per Tue–Thu week that may carry Leo's own photo ("from time to time"). */
export const MAX_PER_WEEK = 1
/** A photo rests this long after it was used. */
const REST_DAYS = 56

export type CatalogueRow = {
  drive_id: string
  name: string
  folder: string
  usable: boolean
  cover_ok: boolean
  reject_reason: string | null
  scene: string | null
  mood: string | null
  fits: string | null
  focus_x: number | null
  focus_y: number | null
  added_at: string | null
  taken: string | null
  used_count: number
  last_used_slot: string | null
  width: number | null
  height: number | null
}

const DESCRIBE = `You sort photos for Leo Chai's LinkedIn posts. Leo is a growth marketing leader in Kuala Lumpur; his posts are read by hiring managers, marketing leaders and peers. The first image is Leo's face, for reference only. The second image is the photo to judge.

usable = true only if ALL hold:
- Leo (the man in the reference) is clearly in it and is the main subject.
- It suits a professional LinkedIn post: no drinks or party scenes, nothing unflattering (eyes closed, mid-bite, very blurry), no swimwear.
- No screenshots, documents, IDs or passports, and no screen or slide showing a client's data, dashboards or other people's names.
- Other people, if any, are in the background or not identifiable. A panel or audience is fine when Leo is clearly the focus.
Otherwise usable = false, with the reason in plain words.

cover_ok = true if it also works as a full-bleed 4:5 portrait cover with a two-line white headline over the bottom third: sharp enough at 1080 px wide, Leo's face in the upper two-thirds, not too busy.

scene: one sentence: where he is, what he is doing, what he wears. mood: 2–4 words.
fits: the kinds of post it suits, from what it shows: e.g. "teaching, workshops, his own opinions", "events, panels, speaking", "AI and his own builds", "travel lessons, China, reflection", "personal milestones", "leadership, hiring". Be concrete.
focus_x, focus_y: where Leo's face is in the photo, as fractions of width (from the left) and height (from the top).`

const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    usable: { type: 'boolean' },
    reject_reason: { type: 'string' },
    cover_ok: { type: 'boolean' },
    scene: { type: 'string' },
    mood: { type: 'string' },
    fits: { type: 'string' },
    focus_x: { type: 'number' },
    focus_y: { type: 'number' },
  },
  required: ['usable', 'reject_reason', 'cover_ok', 'scene', 'mood', 'fits', 'focus_x', 'focus_y'],
  additionalProperties: false,
} as const

function textOf(res: Anthropic.Beta.Messages.BetaMessage): string {
  return res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)

/** Look at one photo and say what it is good for. */
export async function describePhoto(anthropic: Anthropic, photo: DrivePhoto) {
  const img = await photoData(photo.id, 1024)
  const avatar = AVATAR_DATA_URI.split(',')[1]
  const params = {
    model: PHOTO_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DESCRIBE_SCHEMA } },
    system: DESCRIBE,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reference: Leo' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: avatar } },
          { type: 'text', text: `The photo: "${photo.name}" (${photo.width || '?'}×${photo.height || '?'} px original)` },
          { type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } },
        ],
      },
    ],
  }
  const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
  if (res.stop_reason === 'refusal') return { usable: false, reject_reason: 'the photo checker declined to describe it', cover_ok: false, scene: '', mood: '', fits: '', focus_x: 0.5, focus_y: 0.4 }
  const d = JSON.parse(textOf(res))
  // A small original can't fill a 1080 × 1350 cover without looking soft (the 810 px speaking photos are the floor).
  const short = Math.min(photo.width || 0, photo.height || 0)
  const coverOk = !!d.cover_ok && !!d.usable && (!short || short >= 800)
  return { ...d, cover_ok: coverOk, focus_x: clamp01(d.focus_x), focus_y: clamp01(d.focus_y) }
}

/**
 * Catalogue photos that are new (or changed) in Leo's folder, newest first, until the time or
 * count budget runs out. Photos he deleted are marked out of the pool.
 */
export async function cataloguePhotos(args: {
  db: SupabaseClient
  anthropic: Anthropic
  budgetMs: number
  max: number
  log?: (s: string) => void
}): Promise<{ added: number; waiting: number; notes: string[] }> {
  const started = Date.now()
  const notes: string[] = []
  const photos = await listPhotos()
  const { data: known, error } = await args.db.from('linkedin_photos').select('drive_id, md5, in_drive')
  if (error) throw new Error(`reading the photo catalogue: ${error.message}`)
  const byId = new Map((known ?? []).map((r: any) => [r.drive_id, r]))
  const inDrive = new Set(photos.map((p) => p.id))
  const gone = (known ?? []).filter((r: any) => r.in_drive && !inDrive.has(r.drive_id)).map((r: any) => r.drive_id)
  if (gone.length) await args.db.from('linkedin_photos').update({ in_drive: false }).in('drive_id', gone)
  const back = (known ?? []).filter((r: any) => !r.in_drive && inDrive.has(r.drive_id)).map((r: any) => r.drive_id)
  if (back.length) await args.db.from('linkedin_photos').update({ in_drive: true }).in('drive_id', back)
  const todo = photos
    .filter((p) => !byId.has(p.id) || (p.md5 && byId.get(p.id)?.md5 !== p.md5))
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  let added = 0
  for (const p of todo) {
    if (added >= args.max || Date.now() - started > args.budgetMs) break
    args.log?.(`photo: ${p.name}`)
    try {
      const d = await describePhoto(args.anthropic, p)
      const { error: e } = await args.db.from('linkedin_photos').upsert(
        {
          drive_id: p.id,
          name: p.name,
          folder: p.folder ?? '',
          md5: p.md5 ?? '',
          width: p.width || null,
          height: p.height || null,
          taken: p.taken || null,
          added_at: p.created || null,
          in_drive: true,
          usable: !!d.usable,
          cover_ok: !!d.cover_ok,
          reject_reason: d.usable ? null : d.reject_reason || 'not suitable',
          scene: d.scene,
          mood: d.mood,
          fits: d.fits,
          focus_x: d.focus_x,
          focus_y: d.focus_y,
          catalogued_at: new Date().toISOString(),
        },
        { onConflict: 'drive_id' },
      )
      if (e) notes.push(`saving ${p.name}: ${e.message}`)
      else added++
    } catch (e) {
      // "No preview yet" is normal for a photo uploaded minutes ago: it's tried again next time.
      notes.push(`${p.name}: ${(e as Error).message}`)
    }
  }
  return { added, waiting: Math.max(0, todo.length - added), notes }
}

const PICK = `You choose the cover photo for one of Leo Chai's LinkedIn carousel posts. Leo's rule: use his own photo only when it is appropriate and the photo fits the topic; otherwise the post keeps its stock photo. Not every post gets his photo.

His photo fits when the post is about his own work, his own systems, his opinion or a lesson he learned, teaching, speaking, events, leadership, or travel he draws a lesson from, AND the photo shows something that matches (him teaching for a post about teaching; on a panel or stage for a post about speaking up or industry views; a calm portrait for a personal opinion or milestone). A post mainly reporting someone else's study, company or numbers keeps the stock photo unless a photo clearly matches its point.

Among photos that fit equally well, prefer newer ones and ones used less. An older photo is fine when it fits better.

Answer use = false and photo_id = "" when nothing fits well.`

const PICK_SCHEMA = {
  type: 'object',
  properties: { use: { type: 'boolean' }, photo_id: { type: 'string' }, why: { type: 'string' } },
  required: ['use', 'photo_id', 'why'],
  additionalProperties: false,
} as const

/**
 * Decide whether this post gets one of Leo's photos as its cover. Returns null to keep the
 * stock cover (no fitting photo, the week's quota used, or any problem along the way).
 */
export async function pickCover(args: {
  db: SupabaseClient
  anthropic: Anthropic
  week: string
  slot: Date
  post: { topic: string; hook_type: string; body: string; leo_link?: string }
  log?: (s: string) => void
}): Promise<{ id: string; name: string; dataUri: string; focus: { x: number; y: number }; why: string } | null> {
  // The week's quota: covers already given to Leo's photos in this posting week.
  const { data: week } = await args.db.from('linkedin_autopilot').select('data').eq('kind', 'post').eq('week', args.week)
  const used = (week ?? []).filter((r: any) => r.data?.cover_photo).length
  if (used >= MAX_PER_WEEK) return null
  const rested = new Date(args.slot.getTime() - REST_DAYS * 86_400_000).toISOString()
  const { data: rows, error } = await args.db
    .from('linkedin_photos')
    .select('drive_id, name, scene, mood, fits, focus_x, focus_y, added_at, taken, used_count, last_used_slot')
    .eq('in_drive', true)
    .eq('usable', true)
    .eq('cover_ok', true)
    .or(`last_used_slot.is.null,last_used_slot.lt.${rested}`)
  if (error || !rows?.length) return null
  const list = (rows as CatalogueRow[])
    .sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''))
    .slice(0, 60)
    .map(
      (r) =>
        `[${r.drive_id}] ${r.scene} · mood: ${r.mood} · fits: ${r.fits} · added ${String(r.added_at ?? '').slice(0, 10) || '?'}` +
        `${r.taken ? ` · taken ${String(r.taken).slice(0, 10).replace(/:/g, '-')}` : ''} · used ${r.used_count}×`,
    )
  const lines = args.post.body.split('\n').map((l) => l.trim()).filter(Boolean)
  const input =
    `THE POST (topic ${args.post.topic}, hook type ${args.post.hook_type}):\n${lines.slice(0, 8).join('\n')}\n…\n${lines.slice(-2).join('\n')}\n` +
    `${args.post.leo_link ? `\nHow it connects to Leo: ${args.post.leo_link}\n` : ''}` +
    `\nLEO'S PHOTOS (newest first):\n${list.join('\n')}`
  const params = {
    model: PHOTO_MODEL,
    max_tokens: 1500,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PICK_SCHEMA } },
    system: PICK,
    messages: [{ role: 'user', content: input }],
  }
  const res = await args.anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
  if (res.stop_reason === 'refusal') return null
  const pick = JSON.parse(textOf(res)) as { use: boolean; photo_id: string; why: string }
  const row = (rows as CatalogueRow[]).find((r) => r.drive_id === pick.photo_id)
  args.log?.(`cover: ${pick.use && row ? `Leo's photo ${row.name}` : 'stock'} (${pick.why})`)
  if (!pick.use || !row) return null
  const img = await photoData(row.drive_id, 1600)
  return { id: row.drive_id, name: row.name, dataUri: img.dataUri, focus: { x: row.focus_x ?? 0.5, y: row.focus_y ?? 0.4 }, why: pick.why }
}

/** Record that a photo went out, so it rests before it's used again. */
export async function markPhotoUsed(db: SupabaseClient, id: string, slot: Date) {
  const { data } = await db.from('linkedin_photos').select('used_count').eq('drive_id', id).maybeSingle()
  await db
    .from('linkedin_photos')
    .update({ used_count: ((data as any)?.used_count ?? 0) + 1, last_used_slot: slot.toISOString() })
    .eq('drive_id', id)
}
