// 🔒 THE SAFETY NET — plain code, no AI. Every autopilot post passes these checks
// before it can be scheduled; a post that fails one is dropped (and Leo is told
// why), never "fixed" by guessing. Rules come from linkedin/profile.md (§5 voice,
// §9 never-post) and linkedin/hooks.md (the hook gate), as copied into kit.ts.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE (the dry-run script runs it under plain node).
import { FACT_NUMBERS, NEVER_NAME, NEVER_SAY, NEVER_TOPICS, REJECTED_TAKE } from './kit.ts'
import type { CarouselSpec } from './slides.ts'

export type DraftPost = {
  topic: string
  hook_type: string
  body: string // exactly as it will be posted, ending with "Source: …"
  source_url: string
  source_quotes: string[] // exact words quoted from the source, if any
  claims: string[] // each statement the post makes about the source (the verifier checks them)
  carousel: CarouselSpec
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const lower = (s: string) => s.toLowerCase()

/** Every number written with digits, normalised: "RM2,300" → "2300", "4–6x" → "4","6", "16.87" stays. */
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, ''))
}

const SMALL = (n: string) => /^\d+$/.test(n) && Number(n) <= 10 // "3 things", "2 to-dos", "#1"
const YEAR = (n: string) => /^\d{4}$/.test(n) && Number(n) >= 2015 && Number(n) <= 2027

/**
 * Lint one post. `sourceNumbers` are the numbers in the verified excerpts of its
 * source page; `neverName` adds run-time names (projects, competitors, the clients in
 * Leo's wins sheet); `factNumbers` adds the numbers Leo wrote in that sheet.
 */
export function lintPost(p: DraftPost, opts: { sourceNumbers: string[]; neverName: string[]; factNumbers?: string[] }): string[] {
  const problems: string[] = []
  const body = p.body.trim()
  const ls = lines(body)
  const all = [body, p.carousel.cover.l1, p.carousel.cover.l2, p.carousel.cover.sub, p.carousel.q, ...p.carousel.slides.flatMap((s) => [s.label, s.big ?? '', s.h, ...s.b])].join('\n')

  // Shape (profile §5, hooks.md).
  const n = words(body)
  if (n < 110 || n > 270) problems.push(`length ${n} words (120–250 wanted)`)
  const hook = `${ls[0] ?? ''} ${ls[1] ?? ''}`
  if (hook.length > 150) problems.push(`hook is ${hook.length} characters (about 140 max)`)
  if (!/\d/.test(hook)) problems.push('hook has no number')
  if (!/^Source:\s*\S/.test(ls[ls.length - 1] ?? '')) problems.push('no "Source:" line at the end')
  if (!ls.slice(-4, -1).some((l) => l.endsWith('?'))) problems.push('no closing question before the source line')
  if (/https?:\/\/|www\./i.test(all)) problems.push('a link in the post or slides (links go in the first comment)')
  if ((body.match(/—/g) ?? []).length > 1) problems.push('em dashes')
  const emoji = body.match(/\p{Extended_Pictographic}/gu) ?? []
  if (emoji.length > 2) problems.push(`${emoji.length} emoji (max 2)`)
  if ((body.match(/(^|\s)#\w/g) ?? []).length > 3) problems.push('more than 3 hashtags')

  // Words and names Leo never uses (profile §5, §9).
  const text = lower(all)
  for (const w of [...NEVER_SAY, ...NEVER_TOPICS]) if (text.includes(w)) problems.push(`uses "${w}"`)
  if (text.includes('wasted money') || text.includes(lower(REJECTED_TAKE))) problems.push('uses the rejected "wasted money" take')
  for (const name of [...NEVER_NAME, ...opts.neverName]) {
    const nm = lower(name).trim()
    if (nm.length >= 4 && text.includes(nm)) problems.push(`names "${name}" (clients and competitors stay anonymous)`)
  }

  // Every number must come from Leo's approved facts or the verified source page.
  const allowed = new Set([...FACT_NUMBERS, ...(opts.factNumbers ?? []), ...opts.sourceNumbers])
  const unknown = [...new Set(numbersIn(all))].filter((x) => !allowed.has(x) && !SMALL(x) && !YEAR(x))
  if (unknown.length) problems.push(`number(s) not in the source or Leo's facts: ${unknown.join(', ')}`)

  // Carousel shape: fits the slide design (see slides.ts).
  const c = p.carousel
  if (c.slides.length < 4 || c.slides.length > 6) problems.push(`${c.slides.length} inner slides (4–6 wanted)`)
  if (c.cover.l1.length > 40 || c.cover.l2.length > 40) problems.push('cover headline line over 40 characters')
  if (c.cover.sub.length > 120) problems.push('cover subline over 120 characters')
  for (const s of c.slides) {
    if (s.h.length > 70) problems.push(`slide heading too long: "${s.h.slice(0, 40)}…"`)
    if (s.b.length > 3 || s.b.some((b) => b.length > 140)) problems.push(`slide "${s.label}" has too much text`)
    if (s.big && s.big.length > 9) problems.push(`slide big number "${s.big}" too long`)
  }
  if (c.q.length > 110) problems.push('closing question too long for the last slide')

  if (!/^https:\/\/\S+$/.test(p.source_url)) problems.push('no source URL')
  return problems
}

/**
 * The words the writer says it quoted from the source must be in the post, appear word for word in
 * the verified excerpts, and stay under 15 words. (Leo's own quoted phrases, like "unknown", aren't
 * listed; the verifier reads the whole post and flags anything attributed to the source that isn't.)
 */
export function quoteProblems(body: string, sourceQuotes: string[], excerpts: string[]): string[] {
  const norm = (s: string) => lower(s).replace(/[“”"‘’']/g, '').replace(/[.,;:!?]+$/, '').replace(/\s+/g, ' ').trim()
  const hay = norm(excerpts.join(' \n '))
  const post = norm(body)
  const out: string[] = []
  for (const q of sourceQuotes.filter((x) => x.trim())) {
    if (words(q) > 15) out.push(`quote over 15 words: "${q.slice(0, 40)}…"`)
    if (!post.includes(norm(q))) out.push(`listed quote isn't in the post: "${q.slice(0, 60)}"`)
    if (!hay.includes(norm(q))) out.push(`quote not found on the source page: "${q.slice(0, 60)}"`)
  }
  return out
}
