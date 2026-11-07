import type Anthropic from '@anthropic-ai/sdk'
// Explicit .ts extensions: shared with scripts/linkedin-autopilot-dry-run.ts (Node type stripping).
import type { CarouselImages } from './slides.ts'

// 👉 PHOTOS — stock backgrounds from Pexels, picked by Claude looking at the
// actual pictures (one contact sheet per post), not by their alt text. The rules
// are Leo's (linkedin skill, Step 5): show the hook's idea; no brand logos, no
// readable text, no identifiable people who'd seem to endorse the post. Covers
// are always stock in autopilot; Leo's own photos stay a laptop-session choice.

export const PICK_MODEL = 'claude-opus-5-5'

type Candidate = { id: number; alt: string; group: 'cover' | number }

const thumb = (id: number) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=320&h=400`
/** The full-size background, cropped to the slide's 1080×1350. */
export const pexelsUrl = (id: number) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=1080&h=1350`

async function search(key: string, query: string, n: number): Promise<{ id: number; alt: string }[]> {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${n}&orientation=portrait`
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) })
    if (res.ok) {
      const body: any = await res.json()
      return (body?.photos ?? []).map((p: any) => ({ id: Number(p.id), alt: String(p.alt ?? '').slice(0, 80) }))
    }
    if (res.status < 500) throw new Error(`Pexels search HTTP ${res.status}`)
  }
  throw new Error('Pexels search failed twice')
}

async function asBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null
    return Buffer.from(await res.arrayBuffer()).toString('base64')
  } catch {
    return null
  }
}

const SYSTEM = `You pick stock photos for a LinkedIn carousel by Leo Chai, a growth marketing leader. The slides put white text over a darkened photo, so calm, uncluttered pictures work best.

Reject any photo with: a visible brand logo or brand name (including on products, signs, screens, dials); readable text of any kind; a person whose face is identifiable (they would seem to endorse the post); anything sexual, violent, political or religious. Hands, backs, silhouettes and blurred crowds are fine.

Pick:
- cover: ONE photo from the COVER group that shows the hook's idea and has a darker or emptier lower third for the headline.
- inner: ONE photo from each INNER group (3 in total, all different), fitting that group's search.
If a group has nothing acceptable, use -1 for it.`

const SCHEMA = {
  type: 'object',
  properties: {
    cover: { type: 'integer' },
    inner: { type: 'array', items: { type: 'integer' } },
    rejected: { type: 'array', items: { type: 'string' } },
  },
  required: ['cover', 'inner', 'rejected'],
  additionalProperties: false,
} as const

/**
 * Search Pexels for the writer's queries, show Claude the candidates, and return the picks as
 * full-size URLs plus their ids. Throws if no acceptable cover or no inner background is found.
 */
export async function pickImages(
  anthropic: Anthropic,
  key: string,
  hook: string,
  queries: { cover: string; inner: string[] },
): Promise<CarouselImages & { ids: number[] }> {
  const inner = queries.inner.slice(0, 3)
  const groups = await Promise.all([search(key, queries.cover, 8), ...inner.map((q) => search(key, q, 5))])
  const seen = new Set<number>()
  const candidates: Candidate[] = []
  groups.forEach((list, gi) => {
    for (const p of list) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      candidates.push({ id: p.id, alt: p.alt, group: gi === 0 ? 'cover' : gi })
    }
  })
  const images = await Promise.all(candidates.map((c) => asBase64(thumb(c.id))))
  const content: any[] = [{ type: 'text', text: `The post's hook: "${hook}"\nCOVER search: "${queries.cover}"\n${inner.map((q, i) => `INNER group ${i + 1} search: "${q}"`).join('\n')}` }]
  candidates.forEach((c, i) => {
    if (!images[i]) return
    content.push({ type: 'text', text: `[${c.id}] ${c.group === 'cover' ? 'COVER' : `INNER group ${c.group}`}` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[i] } })
  })
  const params = {
    model: PICK_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  }
  const res = await anthropic.beta.messages.create(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
  if (res.stop_reason === 'refusal') throw new Error('the photo picker declined')
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const pick = JSON.parse(text) as { cover: number; inner: number[] }
  const valid = new Map(candidates.filter((_, i) => images[i]).map((c) => [c.id, c]))
  if (!valid.has(pick.cover) || valid.get(pick.cover)?.group !== 'cover') throw new Error('no acceptable cover photo')
  const innerIds = [...new Set(pick.inner.filter((id) => valid.has(id) && id !== pick.cover))]
  if (!innerIds.length) throw new Error('no acceptable background photos')
  return { cover: pexelsUrl(pick.cover), inner: innerIds.map(pexelsUrl), ids: [pick.cover, ...innerIds] }
}
