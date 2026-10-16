// 💼 LinkedIn publisher: runs on YOUR laptop. Pure Node, no extra installs.
//
// Schedules approved posts from linkedin/posts/*.md to Leo's OWN LinkedIn profile
// through GoHighLevel's Social Planner API, using Leo's own GHL sub-account. No
// browser clicking (the YouTube version's weak spot: it clicked someone else's
// post, choked on a big image and fumbled the scheduler).
//
//   npm run linkedin -- check                         is everything connected? (read-only)
//   npm run linkedin -- accounts                      connected accounts + users (read-only)
//   npm run linkedin -- schedule <post.md> --dry-run  print exactly what would be sent
//   npm run linkedin -- schedule <post.md> --draft    create a GHL DRAFT only (test)
//   npm run linkedin -- schedule <post.md>            upload photo + schedule at the post's slot
//   npm run linkedin -- update <post.md>              replace an already-scheduled post (deletes it, re-creates it)
//   npm run linkedin -- list                          scheduled / failed / recent posts
//   npm run linkedin -- delete <ghlPostId>            delete a DRAFT (cleans up a test)
//   npm run linkedin -- ideas                         ideas you ✅'d on Telegram, not used yet
//   npm run linkedin -- ideas used <actionId>         mark one used once it became a post
//   npm run linkedin -- sync                          mirror linkedin/posts/*.md into the database
//                                                     (runs after every schedule; the Sunday agent reads it)
//
// Called by the /linkedin-posts skill. Never prints a secret.
//
// THE GUARD: Leo's GHL is NOT the Claude Malaysia sub-account. That one has
// Kingsley's LinkedIn connected, and a post scheduled there goes out under his
// name. So: refuse if the location IS the Claude Malaysia one, refuse unless the
// target account is a LinkedIn account whose name matches GHL_LEO_LINKEDIN_NAME.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://services.leadconnectorhq.com'
const VERSION = (process.env.GHL_SOCIAL_API_VERSION ?? '2021-07-28').trim()
const LOC = (process.env.GHL_LEO_LOCATION_ID ?? '').trim()
const TOKEN = (process.env.GHL_LEO_TOKEN ?? '').trim()
const ACCOUNT = (process.env.GHL_LEO_LINKEDIN_ACCOUNT_ID ?? '').trim()
const USER = (process.env.GHL_LEO_USER_ID ?? '').trim()
const NAME = (process.env.GHL_LEO_LINKEDIN_NAME ?? 'Chai').trim()
const CLIENT_LOC = (process.env.GHL_CLAUDE_MALAYSIA_LOCATION_ID ?? '').trim()

const SB_URL = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, '')
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

// linkedin/ lives next to cashflowos-leo/. npm runs scripts from the package dir,
// so paths the skill passes ("linkedin/posts/x.md") resolve against where npm was
// CALLED (INIT_CWD), then against the workspace root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BODY = 3000 // LinkedIn's post limit
const MAX_PHOTO = 5 * 1024 * 1024
const MAX_UPLOAD = 25 * 1024 * 1024 // GHL media upload limit for non-video files
const MAX_SLIDES = 300 // LinkedIn document carousel page limit
const HEADROOM_MS = 60 * 60_000

function fail(msg) {
  console.error(`\n⚠️  ${msg}\n`)
  process.exit(1)
}

const WHERE = {
  GHL_LEO_LOCATION_ID: 'GHL (your OWN sub-account) → Settings → Business Profile → Location ID',
  GHL_LEO_TOKEN:
    'GHL (your OWN sub-account) → Settings → Private Integrations → Create → scopes: Social Planner (accounts read, posts read + write), Medias (write), Users (read)',
  GHL_LEO_LINKEDIN_ACCOUNT_ID: 'run `npm run linkedin -- accounts` and copy the id of YOUR LinkedIn profile',
  GHL_LEO_USER_ID: 'run `npm run linkedin -- accounts`, it lists the users; copy your own id',
}
function need(keys) {
  const val = { GHL_LEO_LOCATION_ID: LOC, GHL_LEO_TOKEN: TOKEN, GHL_LEO_LINKEDIN_ACCOUNT_ID: ACCOUNT, GHL_LEO_USER_ID: USER }
  const missing = keys.filter((k) => !val[k])
  if (missing.length) {
    fail(
      `Missing in your .env: ${missing.join(', ')}\n` +
        missing.map((k) => `   • ${k}: ${WHERE[k]}`).join('\n') +
        '\n   Add them, save the file, and run this again. Nothing was sent.',
    )
  }
  if (CLIENT_LOC && LOC === CLIENT_LOC) {
    fail(
      'GHL_LEO_LOCATION_ID is the Claude Malaysia sub-account. Its LinkedIn is Kingsley\'s, not yours.\n' +
        '   Use your OWN GHL sub-account. Nothing was sent.',
    )
  }
}

// ---- GHL -----------------------------------------------------------------
async function ghl(method, path, { json, form, version } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Version: version || VERSION,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const why = data?.message || data?.error || text.slice(0, 300)
    throw new Error(`GHL ${method} ${path.split('?')[0]} → HTTP ${res.status}: ${Array.isArray(why) ? why.join('; ') : why}`)
  }
  return data
}

async function getAccounts() {
  const data = await ghl('GET', `/social-media-posting/${LOC}/accounts`)
  return data?.results?.accounts ?? data?.accounts ?? []
}

// The guard. Returns the account or exits.
async function leoLinkedIn() {
  const accounts = await getAccounts()
  const acct = accounts.find((a) => a.id === ACCOUNT)
  if (!acct) fail(`Account ${ACCOUNT} is not connected in this sub-account. Run \`npm run linkedin -- accounts\`.`)
  if (acct.platform !== 'linkedin') fail(`Account ${ACCOUNT} is ${acct.platform}, not LinkedIn. Nothing was sent.`)
  if (!String(acct.name || '').toLowerCase().includes(NAME.toLowerCase())) {
    fail(
      `Account ${ACCOUNT} is "${acct.name}", which doesn't match GHL_LEO_LINKEDIN_NAME="${NAME}".\n` +
        '   Refusing to post as someone else. Nothing was sent.',
    )
  }
  // Personal profile only (owner's call, 2026-10-08): the SpeakFunnels company page
  // is connected in the same sub-account, and posts must never land there.
  if (acct.type !== 'profile') fail(`Account "${acct.name}" is a LinkedIn ${acct.type}, not your personal profile. Nothing was sent.`)
  if (acct.isExpired) fail(`LinkedIn connection for "${acct.name}" has EXPIRED. Reconnect it in GHL → Social Planner.`)
  return acct
}

// ---- post files ----------------------------------------------------------
function resolvePath(p) {
  const tries = [resolve(process.env.INIT_CWD || process.cwd(), p), resolve(ROOT, p)]
  return tries.find((t) => existsSync(t)) ?? tries[0]
}

// null = no frontmatter block.
function parsePost(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { fm, body: m[2].replace(/\s+$/, ''), raw }
}

function readPost(path) {
  const post = parsePost(readFileSync(path, 'utf8'))
  if (!post) fail(`${basename(path)} has no frontmatter block (--- … ---).`)
  return post
}

// Rewrites ONLY the named frontmatter keys, leaving every other byte alone.
function writeFrontmatter(path, raw, updates) {
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  let block = m[2]
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}:.*$`, 'm')
    block = re.test(block) ? block.replace(re, `${k}: ${v}`) : `${block}\n${k}: ${v}`
  }
  writeFileSync(path, raw.replace(m[0], `${m[1]}${block}${m[3]}`), 'utf8')
}

// ==========================================================================
async function check() {
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN', 'GHL_LEO_LINKEDIN_ACCOUNT_ID', 'GHL_LEO_USER_ID'])
  const acct = await leoLinkedIn()
  console.log(`✅ Connected. Posts go to: ${acct.name} (LinkedIn ${acct.type}), connection expires ${String(acct.expire || '?').slice(0, 10)}.`)
  const days = acct.expire ? (Date.parse(acct.expire) - Date.now()) / 86_400_000 : null
  if (days !== null && days < 14) console.log(`⚠️  That's in ${Math.floor(days)} days. Reconnect LinkedIn in GHL → Social Planner before then.`)
}

async function accounts() {
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN'])
  const list = await getAccounts()
  console.log(`Connected accounts in sub-account ${LOC}:`)
  if (!list.length) console.log('  (none: connect LinkedIn in GHL → Marketing → Social Planner)')
  for (const a of list) {
    console.log(`  ${a.platform.padEnd(9)} ${String(a.type || '').padEnd(8)} ${a.name}${a.isExpired ? '  (EXPIRED)' : ''}\n      id: ${a.id}`)
  }
  try {
    const data = await ghl('GET', `/users/?locationId=${encodeURIComponent(LOC)}`)
    const users = data?.users ?? []
    console.log('\nUsers (GHL_LEO_USER_ID = your own id):')
    for (const u of users) console.log(`  ${u.name || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()}  <${u.email}>\n      id: ${u.id}`)
  } catch (e) {
    console.log(`\n(couldn't list users: ${e.message}).\n   Add the "Users: read" scope, or copy your user id from GHL → Settings → My Staff → your name (the id in the URL).`)
  }
}

async function schedule(file, ...flags) {
  if (!file) fail('Usage: npm run linkedin -- schedule linkedin/posts/<file>.md [--draft | --dry-run]')
  const dry = flags.includes('--dry-run')
  const update = flags.includes('--update') // replace an already-scheduled GHL post in place
  const draft = !update && flags.includes('--draft')
  const path = resolvePath(file)
  if (!existsSync(path)) fail(`No such post file: ${path}`)
  const { fm, body, raw } = readPost(path)

  // ---- refuse anything that isn't ready (before touching the network) ----
  if (update) {
    if (!fm.ghl_post_id) fail(`${basename(path)} has no ghl_post_id, so there's nothing to update. Use schedule instead.`)
    if (!['approved', 'scheduled'].includes(fm.status)) fail(`${basename(path)} is status "${fm.status || '?'}". Only approved/scheduled posts can be updated.`)
  } else {
    if (fm.ghl_post_id) fail(`${basename(path)} is already in GHL (ghl_post_id ${fm.ghl_post_id}). Not sending it twice; use update to change it.`)
    if (fm.status !== 'approved') fail(`${basename(path)} is status "${fm.status || '?'}". Only "approved" posts are scheduled.`)
  }
  if (!body) fail(`${basename(path)} has an empty body.`)
  if (body.length > MAX_BODY) fail(`${basename(path)} is ${body.length} characters; LinkedIn's limit is ${MAX_BODY}.`)
  const when = Date.parse(fm.slot || '')
  if (!draft) {
    if (!fm.slot || Number.isNaN(when)) fail(`${basename(path)} has no valid slot (e.g. 2026-10-13T09:00:00+08:00).`)
    if (!/[+-]\d\d:\d\d$|Z$/.test(fm.slot)) fail(`slot "${fm.slot}" has no timezone. Write it as …T09:00:00+08:00.`)
    if (when < Date.now() + HEADROOM_MS) fail(`slot ${fm.slot} is less than an hour away (or past). Pick a later slot.`)
  }
  // Attachments. A carousel wins over the photo (LinkedIn can't mix a document with images).
  // GHL publishes a LinkedIn PDF carousel from IMAGES plus linkedinPostDetails.postAsPdf — it
  // builds the document itself. Sending a raw PDF is accepted but shows up with no attachment
  // (tested 2026-10-15), so `carousel:` points at a folder of slide-NN.png files (a path to
  // carousel.pdf inside that folder works too).
  let files = []
  let carousel = false
  if (fm.carousel && !/^none$/i.test(fm.carousel)) {
    let dir = resolvePath(fm.carousel)
    if (/\.pdf$/i.test(dir)) dir = dirname(dir)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`Carousel folder not found: ${dir}`)
    files = readdirSync(dir)
      .filter((f) => /^slide-\d+\.(png|jpe?g)$/i.test(f))
      .sort()
      .map((f) => ({ path: join(dir, f), mime: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg' }))
    if (files.length < 2) fail(`Carousel folder has ${files.length} slide image(s); need at least 2: ${dir}`)
    if (files.length > MAX_SLIDES) fail(`Carousel has ${files.length} slides; LinkedIn's limit is ${MAX_SLIDES}.`)
    for (const f of files) if (statSync(f.path).size > MAX_UPLOAD) fail(`Slide over 25 MB: ${f.path}`)
    carousel = true
  } else if (fm.photo && !/^none$/i.test(fm.photo)) {
    const p = resolvePath(fm.photo)
    if (!existsSync(p)) fail(`Photo not found: ${p}`)
    if (!/\.jpe?g$/i.test(p)) fail(`Photo must be a .jpg prepared by linkedin/tools/photo-prep.mjs: ${p}`)
    if (statSync(p).size > MAX_PHOTO) fail(`Photo is over 5 MB. Re-run photo-prep on it: ${p}`)
    files = [{ path: p, mime: 'image/jpeg' }]
  }
  // The document title LinkedIn shows on the carousel: the post's first line, max 100 chars.
  const pdfTitle = body.split('\n')[0].trim().slice(0, 100)

  const payload = {
    accountIds: [ACCOUNT || '<GHL_LEO_LINKEDIN_ACCOUNT_ID>'],
    summary: body,
    media: files.map((f) => ({ url: '<uploaded file url>', type: f.mime })),
    ...(carousel ? { linkedinPostDetails: { postAsPdf: true, pdfTitle } } : {}),
    type: 'post',
    status: draft ? 'draft' : 'scheduled',
    ...(draft ? {} : { scheduleDate: new Date(when).toISOString() }),
    userId: USER || '<GHL_LEO_USER_ID>',
    ...(fm.first_comment ? { followUpComment: fm.first_comment } : {}),
  }

  if (dry) {
    console.log(`DRY RUN, nothing sent. ${basename(path)} would be sent as:\n`)
    console.log(JSON.stringify({ ...payload, summary: `${body.slice(0, 120)}… (${body.length} chars)` }, null, 2))
    console.log('')
    for (const f of files) console.log(`${carousel ? '📑 slide' : '📷 photo'}: ${f.path} (${(statSync(f.path).size / 1024).toFixed(0)} KB)`)
    if (!draft) console.log(`goes live: ${fm.slot} = ${new Date(when).toISOString()} UTC`)
    return
  }

  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN', 'GHL_LEO_LINKEDIN_ACCOUNT_ID', 'GHL_LEO_USER_ID'])
  const acct = await leoLinkedIn()

  payload.media = []
  for (const f of files) {
    // Slides are all named slide-NN.png, so prefix the post slug to keep the media library readable.
    const name = carousel ? `${basename(dirname(f.path))}-${basename(f.path)}` : basename(f.path)
    const form = new FormData()
    form.append('file', new Blob([readFileSync(f.path)], { type: f.mime }), name)
    form.append('hosted', 'false')
    form.append('name', name)
    const up = await ghl('POST', '/medias/upload-file', { form })
    const url = up?.url || up?.fileUrl
    if (!url) fail(`Upload returned no url for ${name}: ${JSON.stringify(up).slice(0, 300)}`)
    payload.media.push({ url, type: f.mime })
  }
  if (files.length) console.log(carousel ? `📑 ${files.length} carousel slides uploaded` : `📷 photo uploaded: ${basename(files[0].path)}`)

  // UPDATE = replace, not edit. GHL's edit-post (PUT) dropped a DRAFT's 8 slides to 1, under both
  // Version 2021-07-28 and v3 (tested 2026-10-16; a draft's read-back is reliable, unlike a
  // scheduled one's, see show()). So the old post is deleted and a fresh one created. Delete FIRST: a missing post can be re-sent
  // with `schedule`; two posts would publish twice. The file is reset to approved in between, so a
  // failure after the delete leaves it ready for a plain `schedule`.
  if (update) {
    // Only a post that hasn't gone out yet can be replaced; a published one is already on LinkedIn.
    const cur = await ghl('GET', `/social-media-posting/${LOC}/posts/${fm.ghl_post_id}`)
    const curStatus = (cur?.results?.post ?? cur?.post ?? cur)?.status
    if (!['scheduled', 'draft', 'failed'].includes(curStatus)) {
      fail(`GHL post ${fm.ghl_post_id} is "${curStatus}", not scheduled. Nothing was changed.`)
    }
    await ghl('DELETE', `/social-media-posting/${LOC}/posts/${fm.ghl_post_id}`)
    writeFrontmatter(path, raw, { status: 'approved', ghl_post_id: '' })
    console.log(`🗑️  old GHL post ${fm.ghl_post_id} removed; creating the replacement…`)
  }
  const res = await ghl('POST', `/social-media-posting/${LOC}/posts`, { json: payload })
  const id = res?.results?.post?._id || res?.post?._id || res?.results?._id || res?._id
  if (!id) {
    fail(
      `GHL accepted the call but returned no post id: ${JSON.stringify(res).slice(0, 400)}` +
        (update ? `\n   The old post was already removed. Check GHL, then run: npm run linkedin -- schedule ${file}` : ''),
    )
  }

  if (draft) {
    console.log(`📝 DRAFT created in GHL for ${acct.name}: ${id}\n   Check it in GHL → Social Planner, then remove it with: npm run linkedin -- delete ${id}`)
    return // a test draft does not mark the post file
  }
  writeFrontmatter(path, raw, { status: 'scheduled', ghl_post_id: id })
  console.log(`✅ ${basename(path)} ${update ? 'REPLACED (new GHL post)' : 'scheduled'} for ${fm.slot} on ${acct.name}'s LinkedIn (GHL post ${id}).`)

  // The post is in GHL either way; a stale mirror only means Sunday's ideas can't see it yet.
  try {
    await sync()
  } catch (e) {
    console.log(`(The post IS scheduled, but the database copy didn't update: ${e.message}\n   Run \`npm run linkedin -- sync\` later.)`)
  }
}

async function list() {
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN', 'GHL_LEO_LINKEDIN_ACCOUNT_ID'])
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString()
  for (const type of ['scheduled', 'failed', 'published']) {
    const data = await ghl('POST', `/social-media-posting/${LOC}/posts/list`, {
      json: { type, accounts: ACCOUNT, skip: '0', limit: '20', fromDate: from, toDate: to, includeUsers: 'false' },
    })
    const posts = data?.results?.posts ?? data?.posts ?? []
    console.log(`\n${type.toUpperCase()} (${posts.length})`)
    for (const p of posts) {
      const when = p.scheduleDate || p.publishedAt || p.updatedAt || ''
      console.log(`  ${String(when).slice(0, 16)}  ${p._id}  [${(p.media || []).length} media]  ${String(p.summary || '').split('\n')[0].slice(0, 60)}`)
    }
  }
}

async function del(id) {
  if (!id) fail('Usage: npm run linkedin -- delete <ghlPostId>')
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN'])
  const data = await ghl('GET', `/social-media-posting/${LOC}/posts/${id}`)
  const post = data?.results?.post ?? data?.post ?? data
  const isTest = /^TEST\b/.test(String(post?.summary ?? '').trim())
  if (post?.status !== 'draft' && !isTest) fail(`Post ${id} is "${post?.status}", not a draft. Only drafts, or posts whose first line starts with TEST, can be deleted from here.`)
  await ghl('DELETE', `/social-media-posting/${LOC}/posts/${id}`)
  console.log(`🗑️  ${post?.status === 'draft' ? 'Draft' : 'Test post'} ${id} deleted.`)
}

// ---- Telegram-approved ideas (agent_actions, same queue shape as job_apply) ----
async function sb(method, table, { query, body, prefer } = {}) {
  if (!SB_URL || !SB_KEY) fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.')
  const qs = query ? `?${new URLSearchParams(query)}` : ''
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new Error(`database said HTTP ${res.status}: ${data?.message || text.slice(0, 200)}`)
  return data
}

async function ideas(sub, idArg) {
  const queued = { agent_key: 'eq.linkedin-ideas', status: 'eq.executed', 'result->>kind': 'eq.linkedin_idea_queued' }
  if (sub === 'used') {
    const id = Number(idArg)
    if (!Number.isInteger(id)) fail('Usage: npm run linkedin -- ideas used <actionId>')
    const rows = await sb('GET', 'agent_actions', { query: { select: 'result', id: `eq.${id}`, ...queued } })
    if (!rows?.length) fail(`Idea #${id} isn't in the queue (already used, or not approved).`)
    await sb('PATCH', 'agent_actions', {
      query: { id: `eq.${id}`, ...queued },
      body: { result: { ...(rows[0].result || {}), kind: 'linkedin_idea_used', used_at: new Date().toISOString() } },
      prefer: 'return=minimal',
    })
    console.log(`✅ Idea #${id} marked used.`)
    return
  }
  const rows = await sb('GET', 'agent_actions', {
    query: { select: 'id,payload,decided_at', ...queued, order: 'decided_at.asc', limit: '20' },
  })
  const list = (rows || []).map((r) => ({ action_id: r.id, approved_at: r.decided_at, ...r.payload }))
  console.log(JSON.stringify({ ideas: list }, null, 2))
}

// ---- the calendar mirror (supabase/linkedin-posts.sql) ----
// Copies every post file's frontmatter + first line into linkedin_posts, keyed by
// file name. The Sunday agent runs on Vercel and can't read this folder; it reads
// the copy. The files stay the source of truth; this never writes back to them.
async function sync() {
  // Throw (not fail()) so a schedule that already succeeded isn't turned into an exit 1.
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.')
  const dir = resolve(ROOT, 'linkedin', 'posts')
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()
  const now = new Date().toISOString()
  const orNull = (v) => (v && !/^none$/i.test(v) ? v : null)
  const rows = []
  for (const file of files) {
    const path = join(dir, file)
    const post = parsePost(readFileSync(path, 'utf8'))
    if (!post) {
      console.log(`  skipped ${file}: no frontmatter block`)
      continue
    }
    const { fm, body } = post
    const slot = Date.parse(fm.slot || '')
    rows.push({
      file,
      status: fm.status || null,
      slot: Number.isNaN(slot) ? null : new Date(slot).toISOString(),
      topic: fm.topic || null,
      hook_type: fm.hook_type || null,
      photo: orNull(fm.photo),
      hook: body.split(/\r?\n/).find((l) => l.trim())?.trim() || null,
      source: fm.source || null,
      ghl_post_id: fm.ghl_post_id || null,
      // the day it was written, so an unslotted draft still dates correctly
      created_at: /^\d{4}-\d{2}-\d{2}$/.test(fm.created || '') ? `${fm.created}T00:00:00+08:00` : statSync(path).mtime.toISOString(),
      updated_at: now,
    })
  }
  if (!rows.length) {
    console.log('No post files to sync.')
    return
  }
  try {
    await sb('POST', 'linkedin_posts', {
      query: { on_conflict: 'file' },
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    })
  } catch (e) {
    if (/linkedin_posts|HTTP 404/.test(e.message)) {
      throw new Error(`${e.message}\n   Run supabase/linkedin-posts.sql once in the Supabase SQL editor, then sync again.`)
    }
    throw e
  }
  console.log(`🔁 ${rows.length} post(s) mirrored to the database: ${rows.map((r) => `${r.file} (${r.status ?? '?'})`).join(', ')}`)
}

// ==========================================================================
const [cmd, ...args] = process.argv.slice(2)
const update = (file, ...flags) => schedule(file, '--update', ...flags)

// show <ghlPostId>: what GHL actually holds for a post (status, time, attachments). Read-only.
async function show(id, flag) {
  if (!id) fail('Usage: npm run linkedin -- show <ghlPostId> [--raw]')
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN'])
  const data = await ghl('GET', `/social-media-posting/${LOC}/posts/${id}`)
  const p = data?.results?.post ?? data?.post ?? data
  if (flag === '--raw') {
    console.log(JSON.stringify({ ...p, summary: `${String(p?.summary ?? '').slice(0, 60)}…` }, null, 2))
    return
  }
  const media = p?.media ?? []
  const li = p?.linkedinPostDetails ?? p?.linkedInPostDetails ?? {}
  console.log(`${id}  status=${p?.status}  scheduleDate=${p?.scheduleDate}`)
  console.log(`  first line: ${String(p?.summary ?? '').split('\n')[0]}`)
  console.log(`  media: ${media.length} item(s)  postAsPdf=${li.postAsPdf ?? '?'}  pdfTitle=${li.pdfTitle ?? '?'}`)
  for (const m of media.slice(0, 3)) console.log(`    ${m.type}  …${String(m.url).slice(-60)}`)
  if (media.length > 3) console.log(`    … and ${media.length - 3} more`)
  // Verified 2026-10-16: a SCHEDULED post reads back with only its first media item, yet it
  // published with all 8 slides (as a new GHL record). Don't "fix" a 1-media scheduled post;
  // check a published one with `list` (its [N media] count is the real one).
  if (p?.status === 'scheduled' && media.length === 1) {
    console.log('  (scheduled posts read back with only their first slide; GHL attaches all of them when it publishes)')
  }
}
const COMMANDS = { check, accounts, schedule, update, show, list, delete: del, ideas, sync }
if (!COMMANDS[cmd]) {
  console.log('Usage: npm run linkedin -- <check | accounts | schedule <post.md> [--draft|--dry-run] | update <post.md> [--dry-run] | list | delete <id> | ideas [used <id>] | sync>')
  process.exit(cmd ? 1 : 0)
}
try {
  await COMMANDS[cmd](...args)
} catch (e) {
  fail(e.message)
}
