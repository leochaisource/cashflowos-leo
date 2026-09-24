import type { AdClient } from './ad-clients'

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
): Promise<number> {
  const rows = await saleRows(locationId, token, fromISO, untilISO, excludeSources)
  return rows.filter((r) => !r.isUpsell).reduce((s, r) => s + r.seats, 0)
}

/**
 * The whole performance block for one day: spend from Meta (passed in, since
 * lib/metrics already owns `ad_daily`), leads and purchases from GHL.
 */
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
  try {
    // Cumulative runs from the start of the last class's day; "today" is the
    // report day only. Both end at the close of the report day, so a brief
    // never counts a sale that happened after the period it describes.
    const salesFrom = dayBounds(cfg.salesSince, tz).start
    purchasesTotal = await seatsSold(locationId, token, salesFrom, end, cfg.excludeOrderSources ?? [])
    purchasesToday = await seatsSold(locationId, token, start, end, cfg.excludeOrderSources ?? [])
  } catch (e) {
    problems.push(`Purchases unreadable from GHL (${(e as Error).message}) — shown as unknown, not zero.`)
  }

  const spendTotal = spendByCampaign('*', cfg.spendSince, dateISO)
  return {
    date: dateISO,
    funnels,
    purchasesToday,
    whatsappWindows,
    whatsappTracked: !!cfg.whatsappWindows,
    purchasesTotal,
    salesSince: cfg.salesSince,
    spendTotal,
    spendSince: cfg.spendSince,
    costPerSale: purchasesTotal && purchasesTotal > 0 ? spendTotal / purchasesTotal : null,
    problems,
  }
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
  out.push('', `Direct purchases: ${p.purchasesToday === null ? 'unavailable' : p.purchasesToday}`)
  out.push(
    '',
    `Total purchases: ${p.purchasesTotal === null ? 'unavailable' : p.purchasesTotal} (accumulative, since ${longDate(p.salesSince)})`,
    `Total Amount spend: ${rm(p.spendTotal)} (since ${longDate(p.spendSince)})`,
    `Cost Per Sale: ${p.costPerSale === null ? 'unavailable' : rm(p.costPerSale)}`,
  )
  return out.join('\n')
}
