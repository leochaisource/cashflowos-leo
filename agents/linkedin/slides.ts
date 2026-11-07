// 👉 THE CAROUSEL, drawn in the cloud. The same look as the laptop renderer
// (linkedin/tools/carousel.mjs: photo + scrim + bold caps + progress bar, Leo's
// face and name on every slide, his closing question last), drawn with Next's
// built-in image renderer instead of headless Chrome, so the weekly autopilot
// can make slides on Vercel with the laptop off.
//
// Sizes are the laptop renderer's CSS pixels × 2.5714 (420×525 → 1080×1350).
// The renderer reads flexbox only: every element with more than one child is a
// flex box, and images arrive as data URIs, fetched here first, so a dead image
// link fails loudly instead of drawing a blank slide.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE: next/og is imported only when slides are
// drawn, so scripts that merely import the LinkedIn agent still run under plain node.
import { AVATAR_DATA_URI } from './avatar.ts'

export type SlideSpec = { label: string; big?: string; h: string; b: string[] }
export type CarouselSpec = {
  cover: { tag: string; l1: string; l2: string; sub: string }
  slides: SlideSpec[]
  q: string
}
/** Background image URLs: one for the cover, and one per inner slide (cycled if fewer). */
export type CarouselImages = { cover: string; inner: string[] }

const W = 1080
const H = 1350
const BLUE = '#2563EB'
const LABEL = '#9DBBFF'
const NAME = 'Leo Chai'
const TITLE = 'Growth & Performance Marketing · Kuala Lumpur'
const FONT = 'Plus Jakarta Sans'

// A tiny element builder: the renderer takes React-shaped objects, so no JSX
// (and no build step) is needed.
type El = { type: string; props: Record<string, unknown> }
const h = (type: string, props: Record<string, unknown>, ...children: (El | string | null)[]): El => {
  const kids = children.filter((c) => c !== null && c !== '')
  return { type, props: { ...props, children: kids.length === 1 ? kids[0] : kids } }
}
const box = (style: Record<string, unknown>, ...children: (El | string | null)[]) => h('div', { style: { display: 'flex', ...style } }, ...children)
const text = (style: Record<string, unknown>, s: string) => h('div', { style: { display: 'flex', ...style } }, s)

// ---- fonts (Google Fonts serves .ttf to a client that sends no browser UA) ----
let fontCache: Promise<{ name: string; data: ArrayBuffer; weight: 400 | 700 | 800; style: 'normal' }[]> | null = null
function fonts() {
  fontCache ??= (async () => {
    const out: { name: string; data: ArrayBuffer; weight: 400 | 700 | 800; style: 'normal' }[] = []
    for (const weight of [400, 700, 800] as const) {
      const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@${weight}`, { signal: AbortSignal.timeout(15_000) })).text()
      const url = css.match(/src: url\((https:[^)]+\.ttf)\)/)?.[1]
      if (!url) throw new Error(`no .ttf for ${FONT} ${weight}`)
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`font ${weight}: HTTP ${res.status}`)
      out.push({ name: FONT, data: await res.arrayBuffer(), weight, style: 'normal' })
    }
    return out
  })().catch((e) => {
    fontCache = null // let the next call try again
    throw e
  })
  return fontCache
}

/** Fetch an image once and return it as a data URI. Throws on anything but an image. */
export async function imageData(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  const type = res.headers.get('content-type') || ''
  if (!res.ok || !type.startsWith('image/')) throw new Error(`image ${url.slice(0, 80)}: HTTP ${res.status} ${type}`)
  return `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
}

// ---- the parts every slide shares ----
const avatar = (size: number) =>
  h('img', { src: AVATAR_DATA_URI, width: size, height: size, style: { width: size, height: size, borderRadius: size, border: `${Math.round(size / 15)}px solid rgba(255,255,255,.9)` } })
const who = () => box({ alignItems: 'center', gap: 23 }, avatar(77), text({ fontSize: 31, fontWeight: 700, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,.5)' }, NAME))
const arrow = () =>
  box(
    { position: 'absolute', right: 46, bottom: 51, width: 103, height: 103, borderRadius: 103, background: BLUE, alignItems: 'center', justifyContent: 'center' },
    h('svg', { width: 44, height: 44, viewBox: '0 0 24 24' }, h('path', { d: 'M4 12h14M12 5l7 7-7 7', stroke: '#fff', strokeWidth: 2.6, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' })),
  )
const progress = (n: number, N: number, last = false) =>
  box(
    { position: 'absolute', bottom: 31, left: 67, right: last ? 67 : 180, alignItems: 'center', gap: 21 },
    box({ flex: 1, height: 8, borderRadius: 5, background: 'rgba(255,255,255,.35)' }, box({ width: `${Math.round((n / N) * 100)}%`, height: 8, borderRadius: 5, background: BLUE })),
    text({ fontSize: 28, fontWeight: 700, color: '#fff' }, `${n}/${N}`),
  )
const photo = (src: string, darken: number) => [
  h('img', { src, width: W, height: H, style: { position: 'absolute', left: 0, top: 0, width: W, height: H, objectFit: 'cover' } }),
  box({ position: 'absolute', left: 0, top: 0, width: W, height: H, background: `rgba(0,0,0,${darken})` }),
]
const upper = (s: string) => s.toUpperCase()
// Post lines can start with an arrow bullet; the slide shows the words only.
const clean = (s: string) => s.replace(/^\s*(→|->|•|-)\s*/, '').trim()

function coverSlide(c: CarouselSpec['cover'], bg: string, N: number): El {
  return box(
    { width: W, height: H, position: 'relative', fontFamily: FONT, background: '#000' },
    ...photo(bg, 0.15),
    box({ position: 'absolute', left: 0, top: 0, width: W, height: H, backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 16%)' }),
    box({ position: 'absolute', left: 0, top: 0, width: W, height: H, backgroundImage: 'linear-gradient(to top, rgba(0,0,0,.92) 0%, rgba(0,0,0,.45) 40%, rgba(0,0,0,0) 68%)' }),
    box(
      { position: 'absolute', left: 0, top: 0, width: W, height: H, flexDirection: 'column', padding: '57px 67px 118px' },
      who(),
      box({ flex: 1 }),
      box(
        { alignItems: 'center', gap: 15, marginBottom: 21 },
        box({ width: 13, height: 13, borderRadius: 13, background: BLUE }),
        text({ fontSize: 23, fontWeight: 800, letterSpacing: 5, color: LABEL }, upper(c.tag)),
      ),
      box(
        { flexDirection: 'column', marginBottom: 26 },
        text({ fontSize: 64, fontWeight: 800, color: '#fff', lineHeight: 1.1, letterSpacing: -1, textShadow: '0 4px 24px rgba(0,0,0,.45)' }, upper(c.l1)),
        text({ fontSize: 64, fontWeight: 800, color: '#fff', lineHeight: 1.1, letterSpacing: -1, textShadow: '0 4px 24px rgba(0,0,0,.45)' }, upper(c.l2)),
      ),
      text({ fontSize: 36, color: 'rgba(255,255,255,.92)', lineHeight: 1.5, paddingRight: 120, textShadow: '0 2px 14px rgba(0,0,0,.5)' }, c.sub),
    ),
    arrow(),
    progress(1, N),
  )
}

function innerSlide(s: SlideSpec, bg: string, n: number, N: number): El {
  return box(
    { width: W, height: H, position: 'relative', fontFamily: FONT, background: '#000' },
    ...photo(bg, 0.32),
    box({
      position: 'absolute', left: 0, top: 0, width: W, height: H,
      backgroundImage: 'linear-gradient(to bottom, rgba(6,10,20,.88) 0%, rgba(6,10,20,.72) 40%, rgba(6,10,20,.40) 72%, rgba(6,10,20,.28) 100%)',
    }),
    box(
      { position: 'absolute', left: 0, top: 0, width: W, height: H, flexDirection: 'column', padding: '57px 67px 118px' },
      who(),
      text({ fontSize: 23, fontWeight: 800, letterSpacing: 5, color: LABEL, margin: '46px 0 26px' }, upper(s.label)),
      s.big
        ? box(
            { alignItems: 'flex-end', marginBottom: 15 },
            text({ fontSize: 118, fontWeight: 800, color: '#fff', lineHeight: 1, letterSpacing: -2.6, textShadow: '0 4px 30px rgba(0,0,0,.45)' }, s.big),
            text({ fontSize: 118, fontWeight: 800, color: BLUE, lineHeight: 1 }, '.'),
          )
        : null,
      text({ fontSize: 54, fontWeight: 800, color: '#fff', lineHeight: 1.18, marginBottom: 31, textShadow: '0 4px 24px rgba(0,0,0,.45)' }, upper(s.h)),
      box({ width: 87, height: 8, borderRadius: 5, background: BLUE, marginBottom: 36 }),
      box(
        { flexDirection: 'column' },
        ...s.b.map((line) => text({ fontSize: 39, color: '#fff', lineHeight: 1.6, marginBottom: 26, textShadow: '0 2px 18px rgba(0,0,0,.65)' }, clean(line))),
      ),
    ),
    arrow(),
    progress(n, N),
  )
}

function endSlide(q: string, N: number): El {
  return box(
    { width: W, height: H, position: 'relative', fontFamily: FONT, backgroundImage: 'linear-gradient(to bottom, #14213F 0%, #0B0F19 60%)' },
    box(
      { position: 'absolute', left: 0, top: 0, width: W, height: H, flexDirection: 'column', justifyContent: 'center', padding: '93px 82px 154px' },
      text({ fontSize: 26, fontWeight: 800, letterSpacing: 6, color: LABEL, marginBottom: 41 }, 'YOUR TURN'),
      text({ fontSize: 69, fontWeight: 800, color: '#fff', lineHeight: 1.2, marginBottom: 41 }, q),
      text({ fontSize: 33, color: 'rgba(255,255,255,.6)', lineHeight: 1.6, marginBottom: 36 }, 'Tell me in the comments. I read every one.'),
      box(
        { alignItems: 'center', gap: 31 },
        avatar(118),
        box({ flexDirection: 'column' }, text({ fontSize: 36, fontWeight: 700, color: '#fff' }, NAME), text({ fontSize: 28, color: 'rgba(255,255,255,.6)' }, TITLE)),
      ),
    ),
    progress(N, N, true),
  )
}

/** Render a whole carousel to 1080×1350 PNGs (cover, inner slides, closing question). */
export async function renderCarousel(spec: CarouselSpec, images: CarouselImages): Promise<Buffer[]> {
  if (!spec.slides.length || !images.inner.length) throw new Error('a carousel needs at least one inner slide and one background')
  const { ImageResponse } = await import('next/og')
  const fontList = await fonts()
  const cover = await imageData(images.cover)
  const inner = await Promise.all(images.inner.map(imageData))
  const N = spec.slides.length + 2
  const els = [
    coverSlide(spec.cover, cover, N),
    ...spec.slides.map((s, i) => innerSlide(s, inner[i % inner.length], i + 2, N)),
    endSlide(spec.q, N),
  ]
  const out: Buffer[] = []
  for (const el of els) {
    const res = new ImageResponse(el as never, { width: W, height: H, fonts: fontList })
    out.push(Buffer.from(await res.arrayBuffer()))
  }
  return out
}
