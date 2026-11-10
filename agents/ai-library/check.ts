// 🔒 THE PLAIN-CODE CHECK — no model, no cost. Plain code opens every page itself
// (openPage), the write-up is made from that text, and then every word-for-word
// line the write-up quotes is looked for in the same text (checkCase), so a case
// can't rest on a line the page never said.
//
//   verified   every quoted line was found on the page
//   partly     some were (the case is kept, with a note)
//   dropped    none were, or the link is already in the library
//
// A result line (a number) stays only when its number appears in its own quote and
// that quote was found on the page.

export type ResultLine = { claim: string; number: string; claimed_by: string; excerpt: string }

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si|source|_hsenc|_hsmi)$/i

/** The same page always gets the same key: no scheme, www, #hash, tracking params or trailing slash. */
export function urlKey(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  // YouTube: the video id is the page, whatever form the link takes.
  if (host === 'youtu.be') return `youtube.com/watch?v=${u.pathname.slice(1)}`
  if (host === 'youtube.com' && u.searchParams.get('v')) return `youtube.com/watch?v=${u.searchParams.get('v')}`
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b))
  const path = u.pathname.replace(/\/+$/, '')
  const q = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
  return `${host}${path}${q}`
}

/** Lowercase, straight quotes, plain dashes, single spaces — so a copied line matches the page text. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[    ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' }

/** The page's main text: its <article> (the longest), else <main>, else <body>. */
function htmlToText(html: string): string {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|form)[\s\S]*?<\/\1>/gi, ' ')
  const pick = (tag: string) => {
    const blocks = clean.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi')) ?? []
    return blocks.sort((a, b) => b.length - a.length)[0] ?? ''
  }
  let main = pick('article')
  if (main.length < 3_000) main = pick('main') || main
  if (main.length < 3_000) main = clean.match(/<body[\s\S]*<\/body>/i)?.[0] ?? clean
  return main
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** text = the page as a person would read it; normText = the same, normalised for matching. */
export type Page = { status: number | null; text: string; normText: string; readable: boolean; why: string }

/** Open a page the way a plain browser request would. Never throws. */
export async function openPage(url: string, timeoutMs = 12_000): Promise<Page> {
  const none = (status: number | null, why: string): Page => ({ status, text: '', normText: '', readable: false, why })
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'en',
      },
    })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok) return none(res.status, `the page answered ${res.status}`)
    if (!/text\/html|text\/plain|xhtml/i.test(type)) return none(res.status, `not a web page (${type.split(';')[0] || 'unknown type'})`)
    const body = (await res.text()).slice(0, 3_000_000)
    const text = type.includes('html') ? htmlToText(body) : body.replace(/\s+/g, ' ').trim()
    // A page built by JavaScript, or a bot wall, leaves little readable text.
    if (text.length < 2_000) return { ...none(res.status, 'little readable text (a bot wall, a login, or a page built by JavaScript)'), text }
    return { status: res.status, text, normText: norm(text), readable: true, why: '' }
  } catch (e) {
    return none(null, `couldn't open it (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.slice(0, 80)})`)
  }
}

/** Is this copied line in the page text? The whole line, or its start and end (pages split lines with markup). */
export function onPage(normText: string, excerpt: string): boolean {
  const e = norm(excerpt).replace(/^["']|["']$/g, '')
  if (e.length < 12) return false
  if (normText.includes(e)) return true
  if (e.length < 60) return false
  return normText.includes(e.slice(0, 45)) && normText.includes(e.slice(-30))
}

/** The numbers in a string, as plain digits ("1,200" → "1200", "15.0" → "15"). */
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, ''))
}

export type Checked = {
  status: 'verified' | 'partly' | 'dropped'
  note: string
  excerpts: string[]
  results: ResultLine[]
}

/** Check one case's quotes and numbers against the page text it was written from. */
export function checkCase(normText: string, c: { excerpts: string[]; results: ResultLine[] }): Checked {
  const notes: string[] = []
  const excerpts = c.excerpts.map((x) => x.trim()).filter((x) => x.length >= 12)
  const found = excerpts.filter((x) => onPage(normText, x))
  if (!found.length) return { status: 'dropped', note: 'none of its quoted lines are on the page', excerpts, results: [] }
  const status = found.length === excerpts.length ? 'verified' : 'partly'
  if (status === 'partly') notes.push(`${excerpts.length - found.length} of ${excerpts.length} quoted lines weren't found on the page and were removed`)

  const results: ResultLine[] = []
  for (const r of c.results) {
    const nums = numbersIn(r.number)
    const inQuote = nums.length > 0 && nums.every((n) => numbersIn(r.excerpt).includes(n))
    if (inQuote && onPage(normText, r.excerpt)) results.push(r)
    else notes.push(`removed the result "${r.claim.slice(0, 60)}" (${!inQuote ? 'its number is not in its quote' : 'its quote is not on the page'})`)
  }
  return { status, note: notes.join('; '), excerpts: found, results }
}
