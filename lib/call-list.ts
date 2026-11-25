import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/call-list.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { contactBasics, contactConversationIds, conversationMessages, customFieldIds } from './ghl.ts'
import { readHotList, type ListCard } from './hot-list.ts'
import { speakerOf } from './closer-coach.ts'
import { claudeJson, jsonFrom, jsonRequest, type ClaudeJsonArgs } from './claude-json.ts'
import { meterBatchResult } from './claude-usage.ts'
import { sendMessage } from './telegram.ts'
import { clip, klToday } from './format.ts'

// 📞 ARIELLA'S "CALL THESE FIRST" (owner, 2026-11-25).
//
// Every morning, the decision-makers on her GHL hot list (the opt-in form's
// "Your Role": business owner, CEO/director, HOD/manager), ranked by buying
// intent from their own chats, strongest first, top 10, as its own 9am message.
// The owner gets a copy.
//
// Only people on her list (the rule since 2026-10-14: Telegram never names a
// lead her GHL list doesn't). Paid leads leave the list; a paid tag drops one too.
//
//   ~01:00 /api/intent-batch   reads her list + each candidate's chat, sends ONE
//                              ranking request to the Batch API (half price)
//   09:00  /api/closer-coach   after the coach: takes the ranking, drops anyone
//                              who left the list overnight, sends it
//
// No overnight ranking (deploy day, a failed batch): ranked live if there's time,
// otherwise ordered by list stage in code, and the message says so.
// State per project: cfo-cache `calllist/<project>.json` (private bucket; holds
// names and phone numbers of the day's candidates, never chat text).

export const CALL_LIST_MODEL = 'claude-sonnet-5-5'
export const CALL_LIST_BATCH_FEATURE = 'call-list-batch'
const BUCKET = 'cfo-cache'
const CHAT_DAYS = 21
const CHAT_LINES = 14
const LINE_CHARS = 220
const CONCURRENCY = 6

export type CallCandidate = {
  contactId: string
  name: string
  phone: string | null
  role: string
  industry: string | null
  stage: string
  /** Why she has the card (the card's own reason). */
  why: string
  /** On her list since. */
  since: string
  callBack: string | null
  /** The lead's last message, when the chat was read. */
  lastLeadAt: string | null
  /** Their latest opt-in (the form), else when the contact was made. */
  optedInAt: string | null
  /** Buying steps from their GHL tags (undated), in plain words. */
  signals: string[]
}
type WithChat = CallCandidate & { chat: string[] }
export type CallPick = { contactId: string; why: string }

type CallListState = {
  /** The morning it's for (KL date). */
  day: string
  batchId: string | null
  submittedAt: string
  status: 'submitted' | 'collected' | 'cancelled' | 'failed' | 'empty'
  doneAt?: string
  candidates: CallCandidate[]
  picks?: CallPick[]
  /** overnight | live | list-order */
  ranking?: string
  /** The plain line the message carries when the ranking isn't the overnight one. */
  note?: string
  error?: string
  sentAt?: string
  sentTo?: string[]
}

const statePath = (project: string) => `calllist/${project}.json`

async function loadState(db: SupabaseClient, project: string): Promise<CallListState | null> {
  const { data, error } = await db.storage.from(BUCKET).download(statePath(project))
  if (error || !data) return null
  try {
    return JSON.parse(await data.text()) as CallListState
  } catch {
    return null
  }
}

async function saveState(db: SupabaseClient, project: string, s: CallListState): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(statePath(project), JSON.stringify(s), { upsert: true, contentType: 'application/json' })
  if (error) throw new Error(`call list state not saved: ${error.message}`)
}

async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)).trim()
const klStamp = (iso: string) => {
  const d = new Date(Date.parse(iso) + 8 * 3600e3)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ------------------------------------------------------------------ candidates

export type Gathered = {
  candidates: WithChat[]
  /** On her list, by reason left out. */
  counts: { open: number; staff: number; noRole: number; paid: number; noChat: number }
}

/**
 * The decision-makers on her list right now, with their chats when `chats`.
 * Roles come from the opt-in form's answer stored with each submission
 * (ghl_leads), else the contact's own "Your Role" field in GHL.
 */
export async function gatherCallCandidates(args: {
  client: AdClient
  db: SupabaseClient | null
  chats: boolean
  /** Stop reading chats after this instant (the rest go without one). */
  deadline?: number
}): Promise<Gathered> {
  const g = args.client.ghl
  const cfg = g?.callList
  const closer = g?.followupAssignee
  if (!g || !cfg || !g.hotList || !closer) throw new Error('no call list configured for this client')
  const token = process.env[g.tokenEnv]!.trim()
  const locationId = process.env[g.locationEnv]!.trim()
  const wanted = new Set(cfg.roles.map(norm))
  const paidTags = new Set(g.hotList.paidTags.map(norm))
  const signalOf = new Map(Object.entries(cfg.signals ?? {}).map(([t, words]) => [norm(t), words]))
  const notLeads = new Set(g.notLeads ?? [])

  const list = await readHotList(args.client)
  if (list.error) throw new Error(`her GHL list couldn't be read: ${list.error}`)
  const cards = new Map<string, ListCard>()
  for (const c of list.open) if (!notLeads.has(c.contactId) && !cards.has(c.contactId)) cards.set(c.contactId, c)
  const counts = { open: cards.size, staff: 0, noRole: 0, paid: 0, noChat: 0 }

  // The form's field ids ("Your Role", "Your Industry"): the same lookup as the hot leads sheet.
  const fields = await customFieldIds(locationId, token)
  const pick = (prefer: string, re: RegExp) => fields.get(prefer) ?? [...fields].find(([n]) => re.test(n))?.[1] ?? null
  const roleId = pick('your role', /\brole\b|position|job title/)
  const industryId = pick('your industry', /industry/)
  if (!roleId) throw new Error('the "Your Role" field was not found in GHL')

  // Stored answers first (one query per 100 contacts, no GHL calls); the latest submission wins.
  const stored = new Map<string, { role: string; industry: string; phone: string | null; at: string | null }>()
  if (args.db) {
    const ids = [...cards.keys()]
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await args.db
        .from('ghl_leads')
        .select('contact_id, phone, payload, submitted_at')
        .eq('project', args.client.id)
        .in('contact_id', ids.slice(i, i + 100))
        .order('submitted_at')
      if (error) break // GHL below still has every answer
      for (const r of (data ?? []) as { contact_id: string; phone: string | null; payload: Record<string, unknown> | null; submitted_at: string | null }[]) {
        const p = (r.payload?.others && typeof r.payload.others === 'object' ? r.payload.others : r.payload ?? {}) as Record<string, unknown>
        const role = fieldText(p[roleId])
        if (role) stored.set(r.contact_id, { role, industry: industryId ? fieldText(p[industryId]) : '', phone: r.phone, at: r.submitted_at })
      }
    }
  }

  // One contact read each (phone, tags, the role field) — except leads whose
  // stored answer already rules them out.
  const out: WithChat[] = []
  const readable = [...cards.values()].filter((c) => {
    const s = stored.get(c.contactId)
    if (s && !wanted.has(norm(s.role))) {
      counts.staff++
      return false
    }
    return true
  })
  await pool(readable, async (card) => {
    const s = stored.get(card.contactId)
    let role = s?.role ?? ''
    let industry = s?.industry ?? ''
    let phone = s?.phone ?? null
    let name = card.name
    let optedInAt = s?.at ?? null
    let signals: string[] = []
    try {
      const b = await contactBasics(token, card.contactId)
      if (b.tags.some((t) => paidTags.has(norm(t)))) {
        counts.paid++
        return
      }
      const live = (id: string | null) => (id ? fieldText(b.customFields.find((f) => f.id === id)?.value) : '')
      role = live(roleId) || role
      industry = live(industryId) || industry
      phone = b.phone ?? phone
      name = b.name ?? name
      optedInAt = optedInAt ?? b.dateAdded
      signals = [...new Set(b.tags.map((t) => signalOf.get(norm(t))).filter((x): x is string => !!x))]
    } catch {
      // no contact read: the stored answer stands (no paid-tag check; the list sync moves payers off)
    }
    if (!role) {
      counts.noRole++
      return
    }
    if (!wanted.has(norm(role))) {
      counts.staff++
      return
    }
    out.push({
      contactId: card.contactId,
      name,
      phone,
      role,
      industry: industry || null,
      stage: card.stage,
      why: card.why,
      since: card.since,
      callBack: card.callBack ?? null,
      lastLeadAt: null,
      optedInAt,
      signals,
      chat: [],
    })
  })

  if (args.chats) {
    const from = Date.now() - CHAT_DAYS * 864e5
    await pool(out, async (c) => {
      if (args.deadline && Date.now() > args.deadline) {
        counts.noChat++
        return
      }
      try {
        const convs = (await contactConversationIds(locationId, token, c.contactId)).slice(0, 2)
        const msgs = (await Promise.all(convs.map((id) => conversationMessages(token, id, 40).catch(() => []))))
          .flat()
          .filter((m) => Date.parse(m.dateAdded) >= from)
          .sort((a, b) => a.dateAdded.localeCompare(b.dateAdded))
        const lead = msgs.filter((m) => m.direction === 'inbound')
        c.lastLeadAt = lead.at(-1)?.dateAdded ?? null
        c.chat = msgs.slice(-CHAT_LINES).map((m) => {
          const who = speakerOf(m, closer.userId)
          const label = who === 'ARIELLA' ? closer.name.toUpperCase() : who
          const body = (m.body ?? '').replace(/\s+/g, ' ').trim() || '(media / no text)'
          return `[${klStamp(m.dateAdded)}] ${label}: ${clip(body, who === 'AUTO' ? 90 : LINE_CHARS)}`
        })
        if (!c.chat.length) counts.noChat++
      } catch {
        counts.noChat++
      }
    })
  }
  out.sort((a, b) => a.contactId.localeCompare(b.contactId)) // stable input, whatever order GHL answered in
  return { candidates: out, counts }
}

// ------------------------------------------------------------------ the ranking request

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['contact_id', 'why'],
        properties: { contact_id: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
} as const

const SYSTEM = (closer: string, product: string, max: number) =>
  `You rank sales leads for ${closer}, the human closer for ${product}. Every lead below is on her follow-up list, ` +
  `has not paid, and told the opt-in form they are a business owner, a CEO/director or a head of department/manager. ` +
  `Pick the ${max} she should phone first today and put them in order, the strongest buying intent first.\n\n` +
  `Buying intent, strongest first:\n` +
  `1. Tried to pay or asked how to: a payment that failed or wasn't finished, asked for the link, bank transfer, instalments or an invoice, or said yes to a ticket.\n` +
  `2. Named a seat count, a class date or a ticket type (VIP, 3 seats, 17 Jan), or is booking for a team.\n` +
  `3. Asked something a person still hasn't answered, or is waiting on a boss or HR by a stated day.\n` +
  `4. Asked about the price, date, venue or content after registering.\n` +
  `5. Only general interest (typed a keyword, "interested").\n` +
  `Move up a lead who wrote recently and got no reply from a person. Move down one who said not now, went quiet after the price, ` +
  `or asked to stop. A lead planning a later class is still a lead, lower down. Leave out anyone with no sign of interest at all.\n\n` +
  `Rules:\n` +
  `- Use only what the chats and list details say. Never invent a price, date, seat count or promise.\n` +
  `- why: ONE plain-English sentence, at most 25 words, saying what to act on, e.g. "Card failed for 17 Jan (RM497); asked to pay ` +
  `by online banking on Mon, no reply yet." You may quote up to 8 of the lead's own words. Chats may be in Malay or Chinese; write in English.\n` +
  `- "Signals" come from GHL tags and carry no date: judge how recent they are from the opt-in date and the chat.
` +
  `- contact_id must be one of the ids given, each at most once. Return exactly ${max} (all of them if fewer are given): ` +
  `after the strongest, fill the list with the next strongest, in order.`

export function callListRequest(args: {
  client: AdClient
  candidates: WithChat[]
  today: string
}): Omit<ClaudeJsonArgs, 'model' | 'fallbackModel'> | null {
  const { client, candidates, today } = args
  if (!candidates.length) return null
  const g = client.ghl!
  const max = g.callList!.max
  const upcoming = (client.deal?.events ?? []).filter((e) => e.date >= today).map((e) => e.date)
  const product = `${client.client ?? client.name}'s one-day, in-person Claude AI workshop in Kuala Lumpur (General and VIP tickets)`
  const blocks = candidates.map((c) =>
    [
      `### [${c.contactId}] ${c.name}`,
      `Role: ${c.role}${c.industry ? ` · Industry: ${c.industry}` : ''} · Opted in: ${c.optedInAt ? c.optedInAt.slice(0, 10) : 'unknown'} · On her list: ${c.stage}, since ${c.since.slice(0, 10)}` +
        (c.why ? ` · Card: "${clip(c.why, 160)}"` : '') +
        (c.callBack ? ` · Call back: ${c.callBack}` : '') +
        (c.signals.length ? `
Signals (GHL tags, undated): ${c.signals.join('; ')}` : ''),
      c.chat.length
        ? `Chat, oldest first (LEAD = the lead, ARI = the AI assistant, ${g.followupAssignee!.name.toUpperCase()} = her, TEAM = other staff, AUTO = automation):\n${c.chat.join('\n')}`
        : `(no chat in the last ${CHAT_DAYS} days)`,
    ].join('\n'),
  )
  return {
    effort: 'medium',
    maxTokens: 8000,
    system: SYSTEM(g.followupAssignee!.name, product, max),
    user: `Today is ${today} (Kuala Lumpur). Upcoming classes: ${upcoming.join(', ') || 'none scheduled'}.\n${candidates.length} leads:\n\n${blocks.join('\n\n')}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
  }
}

/** The model's picks, checked: only given ids, each once, at most `max`, a sentence each. */
export function cleanPicks(raw: unknown, candidates: CallCandidate[], max: number): CallPick[] {
  const ids = new Set(candidates.map((c) => c.contactId))
  const seen = new Set<string>()
  const list = (raw as { picks?: { contact_id?: unknown; why?: unknown }[] } | null)?.picks
  if (!Array.isArray(list)) return []
  const out: CallPick[] = []
  for (const p of list) {
    const id = String(p?.contact_id ?? '').replace(/^\[|\]$/g, '').trim()
    const why = clip(String(p?.why ?? '').replace(/\s+/g, ' ').trim(), 220)
    if (!ids.has(id) || seen.has(id) || !why) continue
    seen.add(id)
    out.push({ contactId: id, why })
    if (out.length >= max) break
  }
  return out
}

// ------------------------------------------------------------------ without the model

const STAGE_WEIGHT: Record<string, number> = { 'link sent': 4, 'call back': 3, hot: 3, thinking: 2, contacted: 1 }
const ROLE_WEIGHT = (r: string) => (/owner|founder|ceo|director/i.test(r) ? 1 : 0)

/** Ordered by buying steps (tags), then list stage, then owners/CEOs before HODs, then the latest message from the lead. */
export function rankByList(candidates: CallCandidate[], max: number): CallPick[] {
  return [...candidates]
    .sort(
      (a, b) =>
        (b.signals?.length ?? 0) - (a.signals?.length ?? 0) ||
        (STAGE_WEIGHT[b.stage.toLowerCase()] ?? 0) - (STAGE_WEIGHT[a.stage.toLowerCase()] ?? 0) ||
        ROLE_WEIGHT(b.role) - ROLE_WEIGHT(a.role) ||
        (b.lastLeadAt ?? b.since).localeCompare(a.lastLeadAt ?? a.since),
    )
    .slice(0, max)
    .map((c) => {
      const steps = (c.signals ?? []).map((x) => x.charAt(0).toUpperCase() + x.slice(1))
      return { contactId: c.contactId, why: clip([...steps, c.why].filter(Boolean).join('. ') || `On your list: ${c.stage}`, 220) }
    })
}

/**
 * The model's order, topped up to `max` from the list order when it returned
 * fewer (it was asked for exactly `max`). Returns how many were topped up, for the message.
 */
export function fillTo(picks: CallPick[], candidates: CallCandidate[], max: number): { picks: CallPick[]; filled: number } {
  if (picks.length >= max) return { picks: picks.slice(0, max), filled: 0 }
  const taken = new Set(picks.map((p) => p.contactId))
  const extra = rankByList(candidates.filter((c) => !taken.has(c.contactId)), max - picks.length)
  return { picks: [...picks, ...extra], filled: extra.length }
}
const filledNote = (n: number, total: number) =>
  n ? `The last ${n} of these ${total} are ordered by checkout steps and list stage: the AI ranked only ${total - n}.` : null

// ------------------------------------------------------------------ the message

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const longDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const shortRole = (r: string) =>
  /owner|founder/i.test(r) ? 'Owner / Founder' : /ceo|director/i.test(r) ? 'CEO / Director' : /head of department/i.test(r) ? 'HOD / Manager' : r
const shortIndustry = (s: string | null) => (s ? s.replace(/\s*\(.*\)\s*$/, '').trim() : '')

export function renderCallList(args: {
  today: string
  picks: CallPick[]
  candidates: CallCandidate[]
  /** Decision-makers on her list not shown. */
  more: number
  /** A plain line when the ranking isn't the overnight one. */
  note?: string | null
}): string {
  const byId = new Map(args.candidates.map((c) => [c.contactId, c]))
  const head = [
    `📞 <b>Call these first</b> · ${esc(longDay(args.today))}`,
    `<i>Business owners, CEOs and HODs on your list, strongest buying signs first. Call them in this order.</i>`,
  ]
  const entries = args.picks.flatMap((p, i) => {
    const c = byId.get(p.contactId)
    if (!c) return []
    const meta = [shortRole(c.role), shortIndustry(c.industry), c.stage].filter(Boolean).join(' · ')
    return [`${i + 1}. <b>${esc(c.name)}</b>${c.phone ? ` · ${esc(c.phone)}` : ''}\n   ${esc(meta)}${c.callBack ? ` · call back ${esc(c.callBack)}` : ''}\n   ${esc(p.why)}`]
  })
  const tail: string[] = []
  if (!entries.length) tail.push('<i>No business owner, CEO or HOD on your list shows buying signs this morning.</i>')
  if (args.more > 0) tail.push(`<i>+${args.more} more decision-maker${args.more === 1 ? '' : 's'} on your list in GHL.</i>`)
  if (args.note) tail.push(`<i>${esc(args.note)}</i>`)
  // One Telegram message (4,096 characters): drop from the bottom if it ever runs over.
  let shown = entries
  const build = () => [...head, '', shown.join('\n\n'), ...(tail.length ? ['', ...tail] : [])].join('\n')
  while (build().length > 3900 && shown.length > 1) shown = shown.slice(0, -1)
  return build()
}

// ------------------------------------------------------------------ overnight batch

export type CallListStep = { ok: boolean; action: string; day?: string; error?: string }

/** After midnight (/api/intent-batch): gather this morning's candidates and send the ranking to the Batch API, once a day. */
export async function submitOvernightCallList(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  dryRun?: boolean
}): Promise<CallListStep> {
  const { client, db } = args
  if (!client.ghl?.callList) return { ok: true, action: 'call list: not configured' }
  const day = klToday()
  const prev = await loadState(db, client.id)
  if (prev?.day === day) return { ok: true, action: `call list: already ${prev.status}`, day }
  const { candidates, counts } = await gatherCallCandidates({ client, db, chats: true, deadline: Date.now() + 150_000 })
  const request = callListRequest({ client, candidates, today: day })
  if (args.dryRun) return { ok: true, action: `call list (dry): ${candidates.length} candidates of ${counts.open} on her list`, day }
  const strip = (c: WithChat): CallCandidate => {
    const { chat: _chat, ...rest } = c
    return rest
  }
  const state: CallListState = { day, batchId: null, submittedAt: new Date().toISOString(), status: 'empty', candidates: candidates.map(strip) }
  if (request) {
    const batch = await args.anthropic.messages.batches.create({
      requests: [{ custom_id: 'calllist', params: jsonRequest(request, CALL_LIST_MODEL) }],
    } as unknown as Anthropic.Messages.BatchCreateParams)
    state.batchId = batch.id
    state.status = 'submitted'
  }
  await saveState(db, client.id, state)
  return { ok: true, action: request ? `call list submitted (${candidates.length} candidates)` : 'call list: no candidates', day }
}

/** File a finished ranking. Still running: left alone, or cancelled when `cancelIfRunning`. */
export async function collectCallListBatch(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  cancelIfRunning?: boolean
}): Promise<CallListStep> {
  const { client, db, anthropic } = args
  const state = await loadState(db, client.id)
  if (!state || state.status !== 'submitted' || !state.batchId)
    return { ok: true, action: state ? `call list: nothing to collect (${state.status})` : 'call list: no batch yet', day: state?.day }
  const batch = await anthropic.messages.batches.retrieve(state.batchId)
  if (batch.processing_status !== 'ended') {
    if (!args.cancelIfRunning) return { ok: true, action: `call list still ${batch.processing_status}`, day: state.day }
    await anthropic.messages.batches.cancel(state.batchId)
    await saveState(db, client.id, { ...state, status: 'cancelled', doneAt: new Date().toISOString(), error: 'not finished by 9am' })
    return { ok: true, action: 'call list cancelled: not finished in time', day: state.day }
  }
  const done: CallListState = { ...state, status: 'failed', doneAt: new Date().toISOString() }
  for await (const r of await anthropic.messages.batches.results(state.batchId)) {
    if (r.custom_id !== 'calllist') continue
    if (r.result.type !== 'succeeded') {
      done.error = r.result.type
      continue
    }
    const msg = r.result.message
    await meterBatchResult(CALL_LIST_BATCH_FEATURE, msg.model, msg.usage).catch(() => {})
    if (msg.stop_reason === 'refusal') {
      done.error = 'the model declined'
      continue
    }
    try {
      const max = client.ghl?.callList?.max ?? 10
      const ranked = fillTo(cleanPicks(jsonFrom(msg as unknown as Parameters<typeof jsonFrom>[0]), state.candidates, max), state.candidates, max)
      done.picks = ranked.picks
      done.note = filledNote(ranked.filled, ranked.picks.length) ?? undefined
      done.ranking = 'overnight'
      done.status = 'collected'
    } catch (e) {
      done.error = (e as Error).message
    }
  }
  await saveState(db, client.id, done)
  return { ok: true, action: `call list ${done.status}${done.error ? ` (${done.error})` : ''}`, day: state.day }
}

// ------------------------------------------------------------------ 9am

export type CallListRun = {
  ok: boolean
  day: string
  text: string | null
  sentTo: string[]
  /** overnight | live | list-order */
  ranking?: string
  skipped?: string
  error?: string
}

/**
 * The 9am message. `to`: "closer" = Ariella (+ the owner's copy), "owner" = a
 * preview to the owner, "none" = build only. `deadline`: when this run must be
 * done by (it shares the coach's 300s); ranking live needs ~2 minutes of it.
 */
export async function runCallList(args: {
  client: AdClient
  db: SupabaseClient | null
  /** Metered as 'call-list' for a live ranking; null = no model. */
  anthropic: Anthropic | null
  to: 'closer' | 'owner' | 'none'
  deadline?: number
  force?: boolean
  /** Read only: no batch collected or cancelled, no state written (previews from scripts/call-list.ts). */
  dry?: boolean
}): Promise<CallListRun> {
  const { client, db } = args
  const g = client.ghl
  const cfg = g?.callList
  const closer = g?.followupAssignee
  const day = klToday()
  if (!g || !cfg || !closer) return { ok: false, day, text: null, sentTo: [], error: 'no call list configured' }
  const deadline = args.deadline ?? Date.now() + 240_000
  const left = () => deadline - Date.now()

  let state = db ? await loadState(db, client.id) : null
  if (state?.day === day && state.sentAt && args.to === 'closer' && !args.force)
    return { ok: true, day, text: null, sentTo: [], skipped: `already sent ${state.sentAt}` }
  if (!args.dry && db && args.anthropic && state?.day === day && state.status === 'submitted') {
    await collectCallListBatch({ client, anthropic: args.anthropic, db, cancelIfRunning: true }).catch(() => null)
    state = await loadState(db, client.id)
  }

  let candidates: CallCandidate[]
  let picks: CallPick[]
  let ranking: string
  let note: string | null = null
  // Already ranked for today (overnight, or by an earlier run): use it as it is.
  // An empty overnight answer is an answer: nobody shows buying signs.
  if (state?.day === day && state.status === 'collected' && Array.isArray(state.picks)) {
    candidates = state.candidates
    picks = state.picks
    ranking = state.ranking ?? 'overnight'
    note = state.note ?? null
  } else {
    const why =
      state?.day === day
        ? state.status === 'empty'
          ? 'nobody qualified at midnight'
          : `the overnight ranking ${state.status === 'cancelled' ? "wasn't finished in time" : 'failed'}`
        : "there was no overnight ranking"
    // Live, when there's a model and time: read the chats again and rank now.
    const live = !!args.anthropic && left() > 150_000
    const got = await gatherCallCandidates({ client, db, chats: live, deadline: Date.now() + Math.min(60_000, left() - 90_000) })
    candidates = got.candidates
    picks = []
    ranking = 'list-order'
    if (live) {
      const request = callListRequest({ client, candidates: got.candidates, today: day })
      if (request) {
        const res = await claudeJson<unknown>({
          anthropic: args.anthropic!,
          model: CALL_LIST_MODEL,
          ...request,
          timeoutMs: Math.max(30_000, Math.min(120_000, left() - 30_000)),
          maxRetries: 1,
        }).catch((e: Error) => ({ data: null, refused: false, stop: e.message }))
        picks = cleanPicks(res.data, candidates, cfg.max)
        if (picks.length) {
          ranking = 'live'
          const ranked = fillTo(picks, candidates, cfg.max)
          picks = ranked.picks
          note = filledNote(ranked.filled, picks.length)
        } else note = `The AI ranking failed this morning (${clip(String(res.stop ?? 'no answer'), 80)}), so this is ordered by checkout steps and list stage.`
      }
    } else if (candidates.length) note = `Ordered by checkout steps and list stage: ${why} and there wasn't time to rank them live.`
    if (!picks.length) picks = rankByList(candidates, cfg.max)
    if (db) {
      const strip = (c: CallCandidate & { chat?: string[] }): CallCandidate => {
        const { chat: _chat, ...rest } = c
        return rest
      }
      state = { day, batchId: null, submittedAt: new Date().toISOString(), status: 'collected', candidates: candidates.map(strip), picks, ranking, note: note ?? undefined }
    }
  }

  // Her list now, not at midnight: anyone who paid or left it since is dropped.
  const now = await readHotList(client)
  if (!now.error) {
    const open = new Set(now.open.map((c) => c.contactId))
    picks = picks.filter((p) => open.has(p.contactId))
    candidates = candidates.filter((c) => open.has(c.contactId))
  } else note = [note, `Your GHL list couldn't be re-checked this morning (${clip(now.error, 80)}).`].filter(Boolean).join(' ')
  const shown = new Set(picks.map((p) => p.contactId))
  const more = candidates.filter((c) => !shown.has(c.contactId)).length
  const text = renderCallList({ today: day, picks, candidates, more, note })

  const owner = process.env.OWNER_CHAT_ID?.trim()
  let recipients: string[] = []
  let body = text
  if (args.to === 'owner') {
    recipients = owner ? [owner] : []
    body = `<i>Preview: what ${esc(closer.name)} gets at 9am.</i>\n\n${text}`
  }
  if (args.to === 'closer') {
    if (closer.telegramChatId) recipients = [closer.telegramChatId]
    else if (owner) {
      recipients = [owner]
      body = `<i>${esc(closer.name)}'s Telegram isn't linked yet, so this came to you.</i>\n\n${text}`
    }
  }
  const sentTo: string[] = []
  let sendError: string | null = null
  for (const chatId of recipients) {
    // The closer hears from the client's bot (lib/ad-clients.ts `bot`); the owner always from SFAiOyen.
    const bot = chatId === closer.telegramChatId ? client.bot : undefined
    const r = await sendMessage(chatId, body, { noPreview: true, bot })
    if (r.ok) sentTo.push(chatId)
    else sendError = r.error ?? 'send failed'
  }
  // The owner's copy of what she got, as with the coach. A failed copy never counts against her send.
  if (args.to === 'closer' && closer.telegramChatId && sentTo.includes(closer.telegramChatId) && owner && owner !== closer.telegramChatId) {
    const at = new Date().toLocaleTimeString('en-GB', { timeZone: g.timeZone ?? 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })
    const r = await sendMessage(owner, `📋 <i>Copy: sent to ${esc(closer.name)} on Telegram at ${at}.</i>\n\n${text}`, { noPreview: true })
    if (r.ok) sentTo.push(owner)
  }
  if (!args.dry && db && state && args.to === 'closer' && sentTo.length)
    await saveState(db, client.id, { ...state, sentAt: new Date().toISOString(), sentTo }).catch(() => {})
  else if (!args.dry && db && state && ranking !== 'overnight') await saveState(db, client.id, state).catch(() => {})
  return { ok: !sendError && (recipients.length === 0 || sentTo.length > 0), day, text, sentTo, ranking, error: sendError ?? note ?? undefined }
}
