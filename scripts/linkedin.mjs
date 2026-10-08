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
//   npm run linkedin -- list                          scheduled / failed / recent posts
//   npm run linkedin -- delete <ghlPostId>            delete a DRAFT (cleans up a test)
//   npm run linkedin -- ideas                         ideas you ✅'d on Telegram, not used yet
//   npm run linkedin -- ideas used <actionId>         mark one used once it became a post
//
// Called by the /linkedin-posts skill. Never prints a secret.
//
// THE GUARD: Leo's GHL is NOT the Claude Malaysia sub-account. That one has
// Kingsley's LinkedIn connected, and a post scheduled there goes out under his
// name. So: refuse if the location IS the Claude Malaysia one, refuse unless the
// target account is a LinkedIn account whose name matches GHL_LEO_LINKEDIN_NAME.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
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
async function ghl(method, path, { json, form } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Version: VERSION,
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

function readPost(path) {
  const raw = readFileSync(path, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) fail(`${basename(path)} has no frontmatter block (--- … ---).`)
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { fm, body: m[2].replace(/\s+$/, ''), raw }
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
  const draft = flags.includes('--draft')
  const path = resolvePath(file)
  if (!existsSync(path)) fail(`No such post file: ${path}`)
  const { fm, body, raw } = readPost(path)

  // ---- refuse anything that isn't ready (before touching the network) ----
  if (fm.ghl_post_id) fail(`${basename(path)} is already in GHL (ghl_post_id ${fm.ghl_post_id}). Not sending it twice.`)
  if (fm.status !== 'approved') fail(`${basename(path)} is status "${fm.status || '?'}". Only "approved" posts are scheduled.`)
  if (!body) fail(`${basename(path)} has an empty body.`)
  if (body.length > MAX_BODY) fail(`${basename(path)} is ${body.length} characters; LinkedIn's limit is ${MAX_BODY}.`)
  const when = Date.parse(fm.slot || '')
  if (!draft) {
    if (!fm.slot || Number.isNaN(when)) fail(`${basename(path)} has no valid slot (e.g. 2026-10-13T09:00:00+08:00).`)
    if (!/[+-]\d\d:\d\d$|Z$/.test(fm.slot)) fail(`slot "${fm.slot}" has no timezone. Write it as …T09:00:00+08:00.`)
    if (when < Date.now() + HEADROOM_MS) fail(`slot ${fm.slot} is less than an hour away (or past). Pick a later slot.`)
  }
  let photo = null
  if (fm.photo && !/^none$/i.test(fm.photo)) {
    photo = resolvePath(fm.photo)
    if (!existsSync(photo)) fail(`Photo not found: ${photo}`)
    if (!/\.jpe?g$/i.test(photo)) fail(`Photo must be a .jpg prepared by linkedin/tools/photo-prep.mjs: ${photo}`)
    if (statSync(photo).size > MAX_PHOTO) fail(`Photo is over 5 MB. Re-run photo-prep on it: ${photo}`)
  }

  const payload = {
    accountIds: [ACCOUNT || '<GHL_LEO_LINKEDIN_ACCOUNT_ID>'],
    summary: body,
    media: photo ? [{ url: '<uploaded photo url>', type: 'image/jpeg' }] : [],
    type: 'post',
    status: draft ? 'draft' : 'scheduled',
    ...(draft ? {} : { scheduleDate: new Date(when).toISOString() }),
    userId: USER || '<GHL_LEO_USER_ID>',
    ...(fm.first_comment ? { followUpComment: fm.first_comment } : {}),
  }

  if (dry) {
    console.log(`DRY RUN, nothing sent. ${basename(path)} would be sent as:\n`)
    console.log(JSON.stringify({ ...payload, summary: `${body.slice(0, 120)}… (${body.length} chars)` }, null, 2))
    if (photo) console.log(`\nphoto: ${photo} (${(statSync(photo).size / 1024).toFixed(0)} KB)`)
    if (!draft) console.log(`goes live: ${fm.slot} = ${new Date(when).toISOString()} UTC`)
    return
  }

  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN', 'GHL_LEO_LINKEDIN_ACCOUNT_ID', 'GHL_LEO_USER_ID'])
  const acct = await leoLinkedIn()

  if (photo) {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(photo)], { type: 'image/jpeg' }), basename(photo))
    form.append('hosted', 'false')
    form.append('name', basename(photo))
    const up = await ghl('POST', '/medias/upload-file', { form })
    const url = up?.url || up?.fileUrl
    if (!url) fail(`Photo upload returned no url: ${JSON.stringify(up).slice(0, 300)}`)
    payload.media = [{ url, type: 'image/jpeg' }]
    console.log(`📷 photo uploaded: ${basename(photo)}`)
  }

  const res = await ghl('POST', `/social-media-posting/${LOC}/posts`, { json: payload })
  const id = res?.results?.post?._id || res?.post?._id || res?.results?._id || res?._id
  if (!id) fail(`GHL accepted the call but returned no post id: ${JSON.stringify(res).slice(0, 400)}`)

  if (draft) {
    console.log(`📝 DRAFT created in GHL for ${acct.name}: ${id}\n   Check it in GHL → Social Planner, then remove it with: npm run linkedin -- delete ${id}`)
    return // a test draft does not mark the post file
  }
  writeFrontmatter(path, raw, { status: 'scheduled', ghl_post_id: id })
  console.log(`✅ ${basename(path)} scheduled for ${fm.slot} on ${acct.name}'s LinkedIn (GHL post ${id}).`)
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
      console.log(`  ${String(when).slice(0, 16)}  ${p._id}  ${String(p.summary || '').split('\n')[0].slice(0, 70)}`)
    }
  }
}

async function del(id) {
  if (!id) fail('Usage: npm run linkedin -- delete <ghlPostId>')
  need(['GHL_LEO_LOCATION_ID', 'GHL_LEO_TOKEN'])
  const data = await ghl('GET', `/social-media-posting/${LOC}/posts/${id}`)
  const post = data?.results?.post ?? data?.post ?? data
  if (post?.status !== 'draft') fail(`Post ${id} is "${post?.status}", not a draft. Only test drafts can be deleted from here; do it in GHL if you mean it.`)
  await ghl('DELETE', `/social-media-posting/${LOC}/posts/${id}`)
  console.log(`🗑️  Draft ${id} deleted.`)
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

// ==========================================================================
const [cmd, ...args] = process.argv.slice(2)
const COMMANDS = { check, accounts, schedule, list, delete: del, ideas }
if (!COMMANDS[cmd]) {
  console.log('Usage: npm run linkedin -- <check | accounts | schedule <post.md> [--draft|--dry-run] | list | delete <id> | ideas [used <id>]>')
  process.exit(cmd ? 1 : 0)
}
try {
  await COMMANDS[cmd](...args)
} catch (e) {
  fail(e.message)
}
