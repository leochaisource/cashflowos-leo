import type { AdClient } from './ad-clients'
// Explicit .ts extension: this file is shared with scripts/ (Node type stripping).
import { previousEventDate } from './deal.ts'

// GoHighLevel — the half of the funnel Meta cannot see.
//
// Meta knows what was SPENT and what it attributed. GHL knows who actually
// opted in and who actually paid. The morning brief joins them per funnel, and
// that join is the whole point of this file: spend comes from `ad_daily`
// (Meta), leads come from a named GHL FORM, purchases come from GHL payments.
//
// NULL ≠ 0, same rule as lib/metrics.ts. If GHL is unreachable, a lead count is
// null ("we could not ask"), never 0 ("nobody opted in") — a brief that reports
// zero leads on a day that produced sixty is worse than one that admits it
// could not read them.
//
// WHY FORM SUBMISSIONS AND NOT CONTACTS: this location has
// `allowDuplicateContact: false`, so a person who opts in a second time updates
// the existing contact and creates no new row. Counting contacts therefore
// UNDERCOUNTS opt-ins (verified 2026-09-23: 51 new contacts vs 63 submissions
// for the same day and form). The form is what the owner means by "leads".
//
// Deliberately WITHOUT the `server-only` guard, like lib/delivery.ts: the
// offline replay script has to render the exact block the cron sends, and a
// number that can only be checked in production is a number nobody checks.

const API = 'https://services.leadconnectorhq.com'
const VERSION = '2021-07-28'

export type GhlFunnelRow = {
  label: string
  campaign: string
  /** Meta spend for this campaign over the report day. Always a real number. */
  spend: number
  /** GHL form submissions over the same day. null = GHL could not be read. */
  leads: number | null
  cpl: number | null
}

// NO LANDING PAGE CONVERSION RATE HERE, deliberately (decided 2026-09-23).
// It needs opt-ins over PAGE VIEWS, and GoHighLevel does not expose funnel page
// analytics: the REST route answers 401 "not yet supported by the IAM Service"
// to a Private Integration Token, and the MCP server ships no funnel tools at
// all. Meta's landing_page_view was tried as a stand-in and rejected — it is
// Meta's own pixel-side estimate of its own traffic, so dividing GHL opt-ins by
// it mixes two different populations and flatters or punishes the page at
// random. A misleading rate in front of a client is worse than no rate.

export type GhlPerformance = {
  /** The day these figures cover, ISO, in the ad account's timezone. */
  date: string
  funnels: GhlFunnelRow[]
  /** Seats sold on the report day itself. null = unreadable. */
  purchasesToday: number | null
  /** Money collected on the report day (tickets + upgrades). null = unreadable. */
  revenueToday: number | null
  /** WhatsApp conversation windows opened on the report day. null = unreadable, or not tracked. */
  whatsappWindows: number | null
  /** Whether this client tracks WhatsApp windows — so a failed read prints "unavailable" instead of vanishing. */
  whatsappTracked: boolean
  /** Seats sold since `salesSince` (the last class) through the report day. */
  purchasesTotal: number | null
  salesSince: string
  /** Meta spend since `spendSince` (campaign start) through the report day. */
  spendTotal: number
  spendSince: string
  costPerSale: number | null
  /** Anything that went wrong, for the brief's warning line. */
  problems: string[]
  /** "Are we on track" — set by the cron when the client has an event schedule. */
  pace?: { line: string } | null
  /** Who to chase today (lib/followups.ts) — set by the cron; rendered at the end of the block. */
  followups?: {
    text: string
    unpaid: number
    chats: number
    hot: number
    warm: number
    /** GHL tasks created/refreshed for the follow-up owner — read back next morning for progress. */
    tasks?: { contactId: string; taskId: string; kind: 'hot' | 'warm' | 'unpaid' }[]
  } | null
}

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Version: VERSION,
  Accept: 'application/json',
  'Content-Type': 'application/json',
})

/** Both credentials present? Mirrors isConfigured() for Meta. */
export function ghlConfigured(client: AdClient): boolean {
  const c = client.ghl
  if (!c) return false
  return !!process.env[c.tokenEnv]?.trim() && !!process.env[c.locationEnv]?.trim()
}

/**
 * The start and end of one day in a named IANA timezone, as UTC instants.
 *
 * Meta reports its daily rows in the AD ACCOUNT's timezone (Asia/Kuala_Lumpur
 * here), so the leads have to be counted over the same boundaries or the two
 * halves of a funnel line describe different days. GHL's date-only filter is
 * UTC — eight hours off, which silently moved ~10% of a day's opt-ins into the
 * wrong report. Explicit instants avoid the whole question.
 */
export function dayBounds(dateISO: string, timeZone: string): { start: string; end: string } {
  // Offset for that zone on that date, derived rather than hard-coded so this
  // keeps working if a client is ever added in a zone that observes DST.
  const probe = new Date(`${dateISO}T12:00:00Z`)
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value // e.g. "GMT+08:00"
  const offset = (tzName ?? 'GMT+00:00').replace('GMT', '') || '+00:00'
  return {
    start: new Date(`${dateISO}T00:00:00.000${offset}`).toISOString(),
    end: new Date(`${dateISO}T23:59:59.999${offset}`).toISOString(),
  }
}

async function getJSON(url: string, token: string, version = VERSION): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { ...headers(token), Version: version }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`GHL ${res.status} on ${new URL(url).pathname}`)
  return (await res.json()) as Record<string, unknown>
}

/**
 * How many times ONE form was submitted in a window.
 *
 * `meta.total` gives the exact count without paging, so this costs one call per
 * form per day no matter the volume.
 */
export async function formSubmissions(
  locationId: string,
  token: string,
  formId: string,
  start: string,
  end: string,
): Promise<number> {
  const url =
    `${API}/forms/submissions?locationId=${encodeURIComponent(locationId)}` +
    `&formId=${encodeURIComponent(formId)}&startAt=${encodeURIComponent(start)}` +
    `&endAt=${encodeURIComponent(end)}&limit=1`
  const j = await getJSON(url, token)
  const total = (j.meta as { total?: number } | undefined)?.total
  if (typeof total !== 'number') throw new Error(`GHL form ${formId}: no total in response`)
  return total
}

/**
 * How many WhatsApp conversation windows OPENED in one day.
 *
 * WhatsApp gives a business 24 hours of free-form chat each time the customer
 * messages. A lead who never replies to the outbound template never opens one,
 * so opt-ins overstate the conversations the team can actually have. A window
 * opens on an inbound message when that person has sent nothing in the 24 hours
 * before it — so the export reads from a day EARLIER than the report day, or a
 * lead who also wrote late the previous night would be miscounted as new.
 *
 * Counts people, not messages: one person can only open one window per day
 * (a second would need a 24-hour gap inside the same day). Reads the
 * conversations export (100 per page, cursor-paged); the conversations API
 * wants its own Version header.
 */
export async function whatsappWindowsOpened(
  locationId: string,
  token: string,
  dayStartISO: string,
  dayEndISO: string,
): Promise<number> {
  const dayStart = Date.parse(dayStartISO)
  const dayEnd = Date.parse(dayEndISO)
  const from = new Date(dayStart - 864e5).toISOString()
  type Msg = { contactId?: string; direction?: string; dateAdded?: string }
  const byContact = new Map<string, number[]>()
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const url =
      `${API}/conversations/messages/export?locationId=${encodeURIComponent(locationId)}&channel=WhatsApp&limit=100` +
      `&startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(dayEndISO)}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const j = await getJSON(url, token, '2021-04-15')
    const msgs = (j.messages as Msg[] | undefined) ?? []
    for (const m of msgs) {
      if (m.direction !== 'inbound' || !m.contactId || !m.dateAdded) continue
      const t = Date.parse(m.dateAdded)
      if (!Number.isFinite(t)) continue
      ;(byContact.get(m.contactId) ?? byContact.set(m.contactId, []).get(m.contactId)!).push(t)
    }
    cursor = (j.nextCursor as string | undefined) ?? null
    if (!cursor || msgs.length < 100) break
  }
  let opened = 0
  for (const times of byContact.values()) {
    const today = times.filter((t) => t >= dayStart && t <= dayEnd)
    // Opened today if any of today's messages had no inbound in the 24h before it.
    if (today.some((t) => !times.some((p) => p < t && p >= t - 864e5))) opened++
  }
  return opened
}

export type LeadRow = {
  submissionId: string
  contactId: string | null
  formId: string
  formName: string | null
  name: string | null
  email: string | null
  phone: string | null
  submittedAt: string
  payload: unknown
}

/**
 * The submissions themselves, not just the count — the list the archive keeps
 * so a name can be looked up months later without asking the CRM.
 *
 * Paged, because unlike the count this cannot be answered by `meta.total`.
 */
export async function formSubmissionRows(
  locationId: string,
  token: string,
  formId: string,
  start: string,
  end: string,
): Promise<LeadRow[]> {
  type Sub = {
    id?: string
    _id?: string
    contactId?: string
    formId?: string
    formName?: string
    name?: string
    email?: string
    phone?: string
    createdAt?: string
  }
  const out: LeadRow[] = []
  for (let page = 1; page <= 10; page++) {
    const url =
      `${API}/forms/submissions?locationId=${encodeURIComponent(locationId)}` +
      `&formId=${encodeURIComponent(formId)}&startAt=${encodeURIComponent(start)}` +
      `&endAt=${encodeURIComponent(end)}&limit=100&page=${page}`
    const j = await getJSON(url, token)
    const subs = (j.submissions as Sub[] | undefined) ?? []
    for (const s of subs) {
      const id = s.id ?? s._id
      if (!id || !s.createdAt) continue
      out.push({
        submissionId: String(id),
        contactId: s.contactId ?? null,
        formId,
        formName: s.formName ?? null,
        name: s.name ?? null,
        email: s.email ?? null,
        phone: s.phone ?? null,
        submittedAt: s.createdAt,
        payload: s,
      })
    }
    if (subs.length < 100) break
  }
  return out
}

/**
 * Seats are counted from TRANSACTIONS, not from the orders list.
 *
 * The orders endpoint does not reliably return the multi-ticket orders — a
 * RM794 two-seat order is absent from the list with or without a status filter,
 * though it reads correctly when fetched by id (verified 2026-09-23). The
 * transaction carries the order id in `entityId`, so the transactions are the
 * spine and each order is read individually for its quantity.
 */
type Txn = {
  entityId?: string
  entitySourceName?: string
  status?: string
  createdAt: string
  amount?: number
  currency?: string
  contactId?: string
  contactName?: string
  contactEmail?: string
}

/**
 * SEATS sold, not transactions.
 *
 * One order can carry two tickets — a RM794 line is two people at RM397, and
 * counting it as a single "purchase" undercounts the room. The quantity only
 * appears on the order DETAIL, so the list is fetched once and each order is
 * then read for its line items.
 *
 * Upsells are excluded by source name: a VIP upgrade is an existing buyer
 * spending more, not another seat, and counting it inflates both the head count
 * and the cost per sale.
 */
export type SaleRow = {
  transactionId: string
  orderId: string | null
  contactId: string | null
  contactName: string | null
  contactEmail: string | null
  amount: number | null
  currency: string | null
  seats: number
  sourceName: string | null
  /** An upsell to an existing buyer — revenue, but not another seat. */
  isUpsell: boolean
  status: string | null
  paidAt: string
  payload: unknown
}

/**
 * Every paid transaction in the window, with its seat count resolved.
 *
 * Kept separate from seatsSold() because the ARCHIVE wants the rows and the
 * brief only wants the total — and upsells belong in the archive (they are real
 * revenue) while being excluded from the head count.
 */
export async function saleRows(
  locationId: string,
  token: string,
  fromISO: string,
  untilISO: string,
  excludeSources: string[],
  // The GHL location also sells other businesses' products (Forex, Brain
  // Health, CloserKing). Only sources matching one of these are this client's.
  includeSources: string[] = [],
): Promise<SaleRow[]> {
  // GHL's date-only startAt/endAt are UTC, so the request is deliberately
  // widened by a day at each end and the exact window is applied here against
  // each order's real timestamp. Without that, a Malaysian day loses its first
  // eight hours of orders to the previous UTC date.
  const pad = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 864e5).toISOString().slice(0, 10)
  const txns: Txn[] = []
  for (let offset = 0; offset < 500; offset += 100) {
    const j = await getJSON(
      `${API}/payments/transactions?altId=${encodeURIComponent(locationId)}&altType=location` +
        `&limit=100&offset=${offset}&startAt=${pad(fromISO, -1)}&endAt=${pad(untilISO, 1)}`,
      token,
    )
    const batch = (j.data as Txn[] | undefined) ?? []
    txns.push(...batch)
    if (batch.length < 100) break
  }

  const from = new Date(fromISO).getTime()
  const until = new Date(untilISO).getTime()
  const wanted = txns.filter((t) => {
    // Paid only: a pending or failed checkout is not a seat in the room.
    if (t.status !== 'succeeded') return false
    const src = (t.entitySourceName ?? '').toLowerCase()
    if (includeSources.length && !includeSources.some((x) => src.includes(x.toLowerCase()))) return false
    const at = new Date(t.createdAt).getTime()
    return at >= from && at <= until
  })

  const out: SaleRow[] = []
  for (const t of wanted) {
    let seats = 1
    if (t.entityId) {
      try {
        const d = await getJSON(
          `${API}/payments/orders/${t.entityId}?altId=${encodeURIComponent(locationId)}&altType=location`,
          token,
        )
        // The single-order response puts line items at the TOP level, while the
        // LIST response nests everything under `data`. Reading only `data.items`
        // silently returned zero items for every order, which made every
        // two-ticket sale count as one seat.
        const items = ((d.items ?? (d.data as { items?: { qty?: number }[] } | undefined)?.items ?? []) as {
          qty?: number
        }[])
        const summed = items.reduce((s, i) => s + (i.qty ?? 1), 0)
        if (summed > 0) seats = summed
      } catch {
        // One unreadable order must not blank the whole count — it is at least
        // one seat, and the brief still needs a number it can stand behind.
      }
    }
    const src = t.entitySourceName ?? null
    out.push({
      transactionId: String(t.entityId ? `${t.entityId}:${t.createdAt}` : t.createdAt),
      orderId: t.entityId ?? null,
      contactId: t.contactId ?? null,
      contactName: t.contactName ?? null,
      contactEmail: t.contactEmail ?? null,
      amount: typeof t.amount === 'number' ? t.amount : null,
      currency: t.currency ?? null,
      seats,
      sourceName: src,
      isUpsell: excludeSources.some((x) => (src ?? '').toLowerCase().includes(x.toLowerCase())),
      status: t.status ?? null,
      paidAt: t.createdAt,
      payload: t,
    })
  }
  return out
}

/** Seats that fill the room: paid, upsells excluded. */
export async function seatsSold(
  locationId: string,
  token: string,
  fromISO: string,
  untilISO: string,
  excludeSources: string[],
  includeSources: string[] = [],
): Promise<number> {
  const rows = await saleRows(locationId, token, fromISO, untilISO, excludeSources, includeSources)
  return rows.filter((r) => !r.isUpsell).reduce((s, r) => s + r.seats, 0)
}

/**
 * The whole performance block for one day: spend from Meta (passed in, since
 * lib/metrics already owns `ad_daily`), leads and purchases from GHL.
 */
/**
 * The cumulative window of the performance block. With a deal schedule it rolls
 * by itself: "since the last class" becomes the previous event's day, and spend
 * starts the day after — the dates that used to be moved by hand after every
 * event. The configured dates still apply while they are later (e.g. a campaign
 * that started after the last event).
 */
export function perfWindow(client: AdClient, dateISO: string): { salesSince: string; spendSince: string } {
  const cfg = client.ghl!
  const prev = client.deal ? previousEventDate(client.deal, dateISO) : null
  if (!prev) return { salesSince: cfg.salesSince, spendSince: cfg.spendSince }
  const dayAfter = new Date(Date.parse(`${prev}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)
  return {
    salesSince: cfg.salesSince > prev ? cfg.salesSince : prev,
    spendSince: cfg.spendSince > dayAfter ? cfg.spendSince : dayAfter,
  }
}

export async function ghlPerformance(
  client: AdClient,
  dateISO: string,
  spendByCampaign: (campaign: string, from: string, to: string) => number,
): Promise<GhlPerformance | null> {
  const cfg = client.ghl
  if (!cfg || !ghlConfigured(client)) return null
  const token = process.env[cfg.tokenEnv]!.trim()
  const locationId = process.env[cfg.locationEnv]!.trim()
  const tz = cfg.timeZone ?? 'Asia/Kuala_Lumpur'
  const { start, end } = dayBounds(dateISO, tz)
  const win = perfWindow(client, dateISO)
  const problems: string[] = []

  const funnels: GhlFunnelRow[] = []
  for (const f of cfg.funnels) {
    const spend = spendByCampaign(f.campaign, dateISO, dateISO)
    let leads: number | null = null
    try {
      leads = await formSubmissions(locationId, token, f.formId, start, end)
    } catch (e) {
      problems.push(`${f.label} leads unreadable (${(e as Error).message}) — shown as unknown, not zero.`)
    }
    funnels.push({
      label: f.label,
      campaign: f.campaign,
      spend,
      leads,
      cpl: leads && leads > 0 ? spend / leads : null,
    })
  }

  let whatsappWindows: number | null = null
  if (cfg.whatsappWindows) {
    try {
      whatsappWindows = await whatsappWindowsOpened(locationId, token, start, end)
    } catch (e) {
      problems.push(`WhatsApp conversations unreadable (${(e as Error).message}) — shown as unknown, not zero.`)
    }
  }

  let purchasesTotal: number | null = null
  let purchasesToday: number | null = null
  let revenueToday: number | null = null
  try {
    // Cumulative runs from the start of the last class's day; "today" is the
    // report day only. Both end at the close of the report day, so a brief
    // never counts a sale that happened after the period it describes.
    const salesFrom = dayBounds(win.salesSince, tz).start
    purchasesTotal = await seatsSold(locationId, token, salesFrom, end, cfg.excludeOrderSources ?? [], cfg.includeOrderSources ?? [])
    const today = await saleRows(locationId, token, start, end, cfg.excludeOrderSources ?? [], cfg.includeOrderSources ?? [])
    purchasesToday = today.filter((r) => !r.isUpsell).reduce((s, r) => s + r.seats, 0)
    revenueToday = today.reduce((s, r) => s + (r.amount ?? 0), 0)
  } catch (e) {
    problems.push(`Purchases unreadable from GHL (${(e as Error).message}) — shown as unknown, not zero.`)
  }

  const spendTotal = spendByCampaign('*', win.spendSince, dateISO)
  return {
    date: dateISO,
    funnels,
    purchasesToday,
    revenueToday,
    whatsappWindows,
    whatsappTracked: !!cfg.whatsappWindows,
    purchasesTotal,
    salesSince: win.salesSince,
    spendTotal,
    spendSince: win.spendSince,
    costPerSale: purchasesTotal && purchasesTotal > 0 ? spendTotal / purchasesTotal : null,
    problems,
  }
}

// ---------------------------------------------------------------- follow-up inputs

export type WaMessage = { id: string; direction: 'inbound' | 'outbound'; body: string; contactId: string; dateAdded: string }

/**
 * Every WhatsApp message (both directions) in a window, oldest first.
 *
 * The export has been seen to answer with an EMPTY page while hundreds of
 * messages exist (2026-09-28) — which would read as "nobody messaged us". So
 * the pages received are checked against the export's own `total`: short →
 * retry, still short → throw, and the caller says "unavailable", never "none".
 */
export async function whatsappMessages(locationId: string, token: string, fromISO: string, toISO: string): Promise<WaMessage[]> {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt))
    const out: WaMessage[] = []
    let received = 0
    let total: number | null = null
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const url =
        `${API}/conversations/messages/export?locationId=${encodeURIComponent(locationId)}&channel=WhatsApp&limit=100` +
        `&startDate=${encodeURIComponent(fromISO)}&endDate=${encodeURIComponent(toISO)}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const j = await getJSON(url, token, '2021-04-15')
      if (total === null && typeof j.total === 'number') total = j.total
      const msgs = (j.messages as Record<string, unknown>[] | undefined) ?? []
      received += msgs.length
      for (const m of msgs) {
        const direction = m.direction === 'inbound' ? 'inbound' : m.direction === 'outbound' ? 'outbound' : null
        if (!direction || !m.contactId || !m.dateAdded) continue
        out.push({ id: String(m.id), direction, body: String(m.body ?? ''), contactId: String(m.contactId), dateAdded: String(m.dateAdded) })
      }
      cursor = (j.nextCursor as string | undefined) ?? null
      if (!cursor || msgs.length < 100) break
    }
    if (total === null || received >= total * 0.95) return out.sort((a, b) => a.dateAdded.localeCompare(b.dateAdded))
    last = `WhatsApp export incomplete — got ${received} of ${total} messages`
  }
  throw new Error(last)
}

/** A contact's display name and tags. The message export carries ids only. */
export async function contactBasics(token: string, contactId: string): Promise<{ name: string | null; email: string | null; tags: string[] }> {
  const j = await getJSON(`${API}/contacts/${encodeURIComponent(contactId)}`, token)
  const c = (j.contact ?? j) as Record<string, unknown>
  const name = (c.contactName as string) || [c.firstName, c.lastName].filter(Boolean).join(' ') || (c.name as string) || null
  return {
    name: name ? String(name).trim() : null,
    email: c.email ? String(c.email).toLowerCase() : null,
    tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
  }
}

// ---------------------------------------------------------------- writes (tasks, tags)

async function sendJSON(method: 'POST' | 'PUT' | 'DELETE', url: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GHL ${res.status} on ${method} ${new URL(url).pathname}${detail ? ` — ${detail.slice(0, 160)}` : ''}`)
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

export type GhlTask = { id: string; title: string; body: string | null; dueDate: string | null; completed: boolean; assignedTo: string | null }

export async function contactTasks(token: string, contactId: string): Promise<GhlTask[]> {
  const j = await getJSON(`${API}/contacts/${encodeURIComponent(contactId)}/tasks`, token)
  return ((j.tasks as GhlTask[] | undefined) ?? []).map((t) => ({ ...t, completed: !!t.completed }))
}

export async function getTask(token: string, contactId: string, taskId: string): Promise<GhlTask | null> {
  const j = await getJSON(`${API}/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, token)
  const t = (j.task ?? null) as GhlTask | null
  return t ? { ...t, completed: !!t.completed } : null
}

export type TaskInput = { title: string; body: string; dueDate: string; assignedTo: string }

export async function createTask(token: string, contactId: string, t: TaskInput): Promise<string> {
  const j = await sendJSON('POST', `${API}/contacts/${encodeURIComponent(contactId)}/tasks`, token, { ...t, completed: false })
  const id = ((j.task ?? j) as { id?: string }).id
  if (!id) throw new Error('GHL created a task but returned no id')
  return id
}

export async function updateTask(token: string, contactId: string, taskId: string, t: TaskInput): Promise<void> {
  await sendJSON('PUT', `${API}/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, token, { ...t, completed: false })
}

export async function addTags(token: string, contactId: string, tags: string[]): Promise<void> {
  if (tags.length) await sendJSON('POST', `${API}/contacts/${encodeURIComponent(contactId)}/tags`, token, { tags })
}

export async function removeTags(token: string, contactId: string, tags: string[]): Promise<void> {
  if (tags.length) await sendJSON('DELETE', `${API}/contacts/${encodeURIComponent(contactId)}/tags`, token, { tags })
}

export type CheckoutAttempt = { contactId: string; name: string | null; email: string | null; status: string; at: string; amount: number | null }

/**
 * The location's own team (GHL users) — their test checkouts and chats are not
 * leads. Found 2026-09-29 when the client's owner landed on the unpaid list.
 */
export async function teamMembers(locationId: string, token: string): Promise<{ emails: Set<string>; names: Set<string> }> {
  const j = await getJSON(`${API}/users/?locationId=${encodeURIComponent(locationId)}`, token)
  const norm = (s: string) => s.toLowerCase().replace(/s+/g, ' ').trim()
  const emails = new Set<string>()
  const names = new Set<string>()
  for (const u of (j.users as Record<string, unknown>[] | undefined) ?? []) {
    if (u.email) emails.add(String(u.email).toLowerCase())
    const n = (u.name as string) || [u.firstName, u.lastName].filter(Boolean).join(' ')
    if (n && norm(n).includes(' ')) names.add(norm(n)) // full names only — "KL" or "Tan" alone would catch real leads
  }
  return { emails, names }
}

/**
 * Who has ever paid for this client's product, and who STARTED a checkout
 * since `sinceISO` (failed or pending) but never paid. Many failed attempts are
 * followed by a successful retry minutes later — those people are not unpaid.
 */
export async function paymentAttempts(
  locationId: string,
  token: string,
  sinceISO: string,
  includeSources: string[],
): Promise<{ paidEver: Set<string>; unpaid: CheckoutAttempt[] }> {
  const txns: Txn[] = []
  for (let offset = 0; offset < 1000; offset += 100) {
    const j = await getJSON(
      `${API}/payments/transactions?altId=${encodeURIComponent(locationId)}&altType=location&limit=100&offset=${offset}`,
      token,
    )
    const batch = (j.data as Txn[] | undefined) ?? []
    txns.push(...batch)
    if (batch.length < 100) break
  }
  const ours = (t: Txn) => !includeSources.length || includeSources.some((x) => (t.entitySourceName ?? '').toLowerCase().includes(x.toLowerCase()))
  const paidEver = new Set(txns.filter((t) => ours(t) && t.status === 'succeeded' && t.contactId).map((t) => t.contactId!))
  const since = Date.parse(sinceISO)
  const latest = new Map<string, CheckoutAttempt>()
  for (const t of txns) {
    if (!ours(t) || !t.contactId || t.status === 'succeeded' || paidEver.has(t.contactId)) continue
    if (Date.parse(t.createdAt) < since) continue
    const cur = latest.get(t.contactId)
    if (!cur || t.createdAt > cur.at)
      latest.set(t.contactId, {
        contactId: t.contactId,
        name: t.contactName ?? null,
        email: t.contactEmail ? t.contactEmail.toLowerCase() : null,
        status: t.status ?? 'unknown',
        at: t.createdAt,
        amount: t.amount ?? null,
      })
  }
  return { paidEver, unpaid: [...latest.values()].sort((a, b) => b.at.localeCompare(a.at)) }
}

// ---------------------------------------------------------------- first touch

/** What GHL recorded about how a contact first arrived. */
export type FirstTouch = {
  dateAdded: string | null
  sessionSource: string | null
  utmSource: string | null
  campaign: string | null
  url: string | null
  fbclid: boolean
  fbc: boolean
  adId: string | null
}

export async function contactFirstTouch(locationId: string, token: string, contactId: string): Promise<FirstTouch> {
  const j = await getJSON(`${API}/contacts/${encodeURIComponent(contactId)}`, token)
  const c = (j.contact ?? j) as Record<string, unknown>
  const a = (c.attributionSource ?? {}) as Record<string, string | null | undefined>
  void locationId // the token is scoped to the location; kept for a uniform call shape
  return {
    dateAdded: (c.dateAdded as string) ?? null,
    sessionSource: a.sessionSource ?? null,
    utmSource: a.utmSource ?? null,
    campaign: a.campaign ?? null,
    url: a.url ?? null,
    fbclid: !!a.fbclid || /[?&]fbclid=/.test(a.url ?? ''),
    fbc: !!a.fbc,
    adId: a.adId ?? null,
  }
}

/**
 * Clause 6 of the Claude Malaysia agreement, as far as GHL can see it:
 *   · on the House's records on/before the agreement date → Organic (6(a)),
 *   · first touch a paid click or ad lead form → Ads (6(b)),
 *   · anything else → unknown, which the contract counts as Organic (6(c)).
 *
 * This is the FALLBACK. The House decides seats from its payment records and
 * community join dates (EventOps); GHL often loses the ad click — the CS team's
 * "cs follow up" links and direct checkouts become the recorded first touch — so
 * this undercounts Ads Seats (14 here vs EventOps' 29 on 27 Sep 2026).
 */
export function classifyFirstTouch(t: FirstTouch, agreementDate: string): { source: 'ads' | 'organic' | 'unknown'; reason: string } {
  const paid =
    t.fbclid || t.fbc || !!t.adId || /\[sf\]/i.test(t.campaign ?? '') || /^(facebook|instagram)_/i.test(t.utmSource ?? '')
  const pre = !!t.dateAdded && t.dateAdded <= new Date(`${agreementDate}T23:59:59+08:00`).toISOString()
  if (pre) return { source: 'organic', reason: `on the House's records since ${t.dateAdded!.slice(0, 10)} (before the agreement)` }
  if (paid) return { source: 'ads', reason: `first touch: ${t.utmSource ?? t.sessionSource ?? 'paid click'}${t.campaign ? ` · ${t.campaign}` : ''}` }
  if (/community|organic|affiliate/i.test(t.utmSource ?? '') || /community|organic/i.test(t.campaign ?? ''))
    return { source: 'organic', reason: `first touch: ${t.utmSource ?? t.campaign}` }
  return { source: 'unknown', reason: `first touch: ${t.utmSource ?? t.sessionSource ?? 'nothing recorded'} — no ad click on record` }
}

// ---------------------------------------------------------------- rendering
const rm = (n: number) => 'RM' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ddmmyy = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${d}${m}${y.slice(2)}`
}
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

/**
 * The exact text the owner asked for. Rendered HERE, in code, rather than
 * described to the model — a brief whose numbers are retyped by a language
 * model is a brief whose numbers can drift, and these go to a client group.
 */
export function renderPerformance(p: GhlPerformance): string {
  const out: string[] = [`Ads performance update ${ddmmyy(p.date)}`]
  for (const f of p.funnels) {
    out.push(
      '',
      `${f.label}:`,
      `Amount spent: ${rm(f.spend)}`,
      `Leads: ${f.leads === null ? 'unavailable' : f.leads}`,
      `CPL: ${f.cpl === null ? (f.leads === 0 ? 'no leads yet' : 'unavailable') : rm(f.cpl)}`,
    )
  }
  if (p.whatsappWindows !== null || p.whatsappTracked)
    out.push('', `WhatsApp conversation windows opened: ${p.whatsappWindows === null ? 'unavailable' : p.whatsappWindows}`)
  out.push(
    '',
    `Direct purchases: ${p.purchasesToday === null ? 'unavailable' : p.purchasesToday}` +
      (p.revenueToday ? ` (${rm(p.revenueToday)} collected)` : ''),
  )
  if (p.pace) out.push(p.pace.line)
  out.push(
    '',
    `Total purchases: ${p.purchasesTotal === null ? 'unavailable' : p.purchasesTotal} (accumulative, since ${longDate(p.salesSince)})`,
    `Total Amount spend: ${rm(p.spendTotal)} (since ${longDate(p.spendSince)})`,
    `Cost Per Sale: ${p.costPerSale === null ? 'unavailable' : rm(p.costPerSale)}`,
  )
  if (p.followups?.text) out.push('', p.followups.text)
  return out.join('\n')
}
