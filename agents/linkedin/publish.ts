// 🔒 PUBLISH — the autopilot's only path to LinkedIn, through GHL Social Planner
// in Leo's OWN sub-account (Speakfunnels). The same guard as the laptop publisher
// (scripts/linkedin.mjs), because a post here goes out under a real name:
//   • never the Claude Malaysia sub-account (its LinkedIn is Kingsley's);
//   • only the configured account, only if it is a LinkedIn PROFILE (never the
//     SpeakFunnels company page), only if its name matches, only if not expired.
// Any doubt → throw, and nothing is sent.
//
// GHL quirks (verified on the laptop, 2026-10-15/16): a carousel is uploaded as
// slide IMAGES with linkedinPostDetails.postAsPdf (GHL builds the document; a raw
// PDF shows no attachment); a scheduled post reads back with only 1 media item
// but publishes them all.
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE (the dry-run script runs it under plain node).

const API = 'https://services.leadconnectorhq.com'
const CLAUDE_MALAYSIA_LOCATION = 'CPj3hFQUoD6vi8H3KFET' // Kingsley's LinkedIn lives there: never post from it
const LEO_USER_ID = 'UKZmXzm0TXpeN2ZjFQsq' // agency owner, so GHL doesn't list him among the location's users

function env() {
  const loc = process.env.GHL_LEO_LOCATION_ID?.trim() ?? ''
  const token = process.env.GHL_LEO_TOKEN?.trim() ?? ''
  const account = process.env.GHL_LEO_LINKEDIN_ACCOUNT_ID?.trim() ?? ''
  if (!loc || !token || !account) throw new Error('GHL_LEO_LOCATION_ID / GHL_LEO_TOKEN / GHL_LEO_LINKEDIN_ACCOUNT_ID missing')
  const blocked = [CLAUDE_MALAYSIA_LOCATION, process.env.GHL_CLAUDE_MALAYSIA_LOCATION_ID?.trim()].filter(Boolean)
  if (blocked.includes(loc)) throw new Error('GHL_LEO_LOCATION_ID is the Claude Malaysia sub-account; refusing to post')
  return {
    loc,
    token,
    account,
    user: process.env.GHL_LEO_USER_ID?.trim() || LEO_USER_ID,
    name: (process.env.GHL_LEO_LINKEDIN_NAME?.trim() || 'Chai').toLowerCase(),
    version: process.env.GHL_SOCIAL_API_VERSION?.trim() || '2021-07-28',
  }
}

async function ghl(method: string, path: string, opts: { json?: unknown; form?: FormData } = {}): Promise<any> {
  const e = env()
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${e.token}`,
      Version: e.version,
      Accept: 'application/json',
      ...(opts.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.form,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text().catch(() => '')
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const why = data?.message || data?.error || text.slice(0, 200)
    throw new Error(`GHL ${method} ${path.split('?')[0].replace(e.loc, '<loc>')} → HTTP ${res.status}: ${Array.isArray(why) ? why.join('; ') : why}`)
  }
  return data
}

/** The guard. Returns Leo's LinkedIn profile account, or throws. */
export async function leoAccount(): Promise<{ name: string; expire: string | null }> {
  const e = env()
  const data = await ghl('GET', `/social-media-posting/${e.loc}/accounts`)
  const accounts: any[] = data?.results?.accounts ?? data?.accounts ?? []
  const a = accounts.find((x) => x.id === e.account)
  if (!a) throw new Error('the configured LinkedIn account is not connected in GHL')
  if (a.platform !== 'linkedin') throw new Error(`the configured account is ${a.platform}, not LinkedIn`)
  if (a.type !== 'profile') throw new Error(`the configured account is a LinkedIn ${a.type}, not Leo's personal profile`)
  if (!String(a.name ?? '').toLowerCase().includes(e.name)) throw new Error(`the configured account is "${a.name}", not Leo`)
  if (a.isExpired) throw new Error('the LinkedIn connection in GHL has EXPIRED; reconnect it in GHL → Social Planner')
  return { name: String(a.name), expire: a.expire ? String(a.expire) : null }
}

/** Times (ms) of Leo's posts already scheduled in GHL between two dates. */
export async function scheduledTimes(from: Date, to: Date): Promise<number[]> {
  const e = env()
  const data = await ghl('POST', `/social-media-posting/${e.loc}/posts/list`, {
    json: { type: 'scheduled', accounts: e.account, skip: '0', limit: '50', fromDate: from.toISOString(), toDate: to.toISOString(), includeUsers: 'false' },
  })
  const posts: any[] = data?.results?.posts ?? data?.posts ?? []
  return posts.map((p) => Date.parse(p.scheduleDate ?? '')).filter((t) => !Number.isNaN(t))
}

/** Upload one slide image; returns its GHL media URL. */
async function upload(png: Buffer, name: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), name)
  form.append('hosted', 'false')
  form.append('name', name)
  const up = await ghl('POST', '/medias/upload-file', { form })
  const url = up?.url || up?.fileUrl
  if (!url) throw new Error(`GHL upload returned no URL for ${name}`)
  return url
}

/** Schedule a carousel post on Leo's LinkedIn. Returns the GHL post id. */
export async function scheduleCarousel(args: { body: string; slides: Buffer[]; slug: string; firstComment: string; slot: Date }): Promise<string> {
  const e = env()
  await leoAccount() // the guard, right before sending
  if (args.slot.getTime() < Date.now() + 60 * 60_000) throw new Error('slot is less than an hour away')
  const media: { url: string; type: string }[] = []
  for (let i = 0; i < args.slides.length; i++) {
    media.push({ url: await upload(args.slides[i], `${args.slug}-slide-${String(i + 1).padStart(2, '0')}.png`), type: 'image/png' })
  }
  const res = await ghl('POST', `/social-media-posting/${e.loc}/posts`, {
    json: {
      accountIds: [e.account],
      summary: args.body,
      media,
      // The document title LinkedIn shows on the carousel: the post's first line.
      linkedinPostDetails: { postAsPdf: true, pdfTitle: args.body.split('\n')[0].trim().slice(0, 100) },
      type: 'post',
      status: 'scheduled',
      scheduleDate: args.slot.toISOString(),
      userId: e.user,
      followUpComment: args.firstComment,
    },
  })
  const id = res?.results?.post?._id || res?.post?._id || res?.results?._id || res?._id
  if (!id) throw new Error('GHL accepted the post but returned no id')
  return String(id)
}
