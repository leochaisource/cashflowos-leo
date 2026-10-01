import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/hotleads-sheet.ts (Node type stripping).
import { contactBasics, customFieldIds, classifyFirstTouch, type ContactBasics } from './ghl.ts'
import type { Followups } from './followups.ts'

// THE HOT-LEADS SHEET — owner's ask (2026-10-01): every day's hot leads in the
// shared "Leads Follow Up List" Google Sheet, with their interest, objection,
// opt-in and last-message dates, so the team has one running list.
//
// The sheet's own Apps Script (apps-script/hot-leads.gs) receives the rows:
// a server can't write to a Google Sheet without Google auth, and the script
// runs as the sheet's owner. One row per lead per day (key = date|contactId);
// the team's "status" and "Notes" columns are never overwritten.
//
// Hot leads = chats the model judged hot + checkouts started that day and not
// completed (the closest to paying). Warm and cold stay in GHL tasks / tags.

export type SheetRow = Record<string, string | number>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const kl = (iso: string) => new Date(Date.parse(iso) + 8 * 3600e3)
const klDate = (iso: string | null | undefined) => (iso ? kl(iso).toISOString().slice(0, 10) : '')
const klDateTime = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = kl(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const text = (s: string | null | undefined) => (s ? `'${s}` : '') // keep "+60…" as text, not a number

/** One row per hot lead (and per unpaid checkout started that day) for the report day in `f`. */
export async function hotLeadRows(args: {
  f: Followups
  project: string
  locationId: string
  token: string
  agreementDate: string
  assignee: string | null
  funnels: { formId: string; label: string }[]
  db?: SupabaseClient | null
}): Promise<SheetRow[]> {
  const { f } = args
  const chatOf = new Map(f.chats.map((c) => [c.contactId, c]))
  const ids = new Set<string>()
  for (const c of f.chats) if (c.intent === 'hot') ids.add(c.contactId)
  const unpaidToday = f.unpaid.filter((u) => klDate(u.at) === f.day)
  for (const u of unpaidToday) ids.add(u.contactId)
  if (!ids.size) return []

  // Contact details — already read for the chats; the rest a few at a time.
  const details = new Map<string, ContactBasics>()
  for (const id of ids) {
    const d = chatOf.get(id)?.details
    if (d) details.set(id, d)
  }
  const missing = [...ids].filter((id) => !details.has(id))
  for (let i = 0; i < missing.length; i += 6)
    await Promise.all(
      missing.slice(i, i + 6).map(async (id) => {
        try {
          details.set(id, await contactBasics(args.token, id))
        } catch {
          // a row without details still beats no row
        }
      }),
    )

  // "Your Industry" / "Your Role" from the opt-in form.
  let industryId: string | null = null
  let roleId: string | null = null
  try {
    const fields = await customFieldIds(args.locationId, args.token)
    const pick = (re: RegExp, prefer: string) => fields.get(prefer) ?? [...fields].find(([n]) => re.test(n))?.[1] ?? null
    industryId = pick(/industry/, 'your industry')
    roleId = pick(/\brole\b|position|job title/, 'your role')
  } catch {
    // leave the two columns blank
  }
  const field = (d: ContactBasics | undefined, id: string | null) => {
    const v = id ? d?.customFields.find((x) => x.id === id)?.value : null
    return Array.isArray(v) ? v.join(', ') : v ? String(v) : ''
  }

  // First opt-in per contact, from the stored form submissions.
  const optin = new Map<string, { at: string; formId: string }>()
  if (args.db) {
    const { data } = await args.db
      .from('ghl_leads')
      .select('contact_id, form_id, submitted_at')
      .eq('project', args.project)
      .in('contact_id', [...ids])
      .order('submitted_at')
    for (const r of (data ?? []) as { contact_id: string; form_id: string; submitted_at: string }[])
      if (!optin.has(r.contact_id)) optin.set(r.contact_id, { at: r.submitted_at, formId: r.form_id })
  }
  const formLabel = new Map(args.funnels.map((x) => [x.formId, x.label]))

  const rows: SheetRow[] = []
  for (const id of ids) {
    const c = chatOf.get(id)
    const u = unpaidToday.find((x) => x.contactId === id)
    const d = details.get(id)
    const o = optin.get(id)
    const touch = d ? classifyFirstTouch(d.firstTouch, args.agreementDate).source : null
    const paid = f.paidAt.get(id)
    rows.push({
      Date: f.day,
      Type: u ? (c?.intent === 'hot' ? '💳 Payment not completed · 🔥 hot chat' : '💳 Payment not completed') : '🔥 Hot chat',
      Name: d?.name ?? c?.name ?? u?.name ?? '',
      Phone: text(d?.phone),
      Email: d?.email ?? u?.email ?? '',
      Industry: field(d, industryId),
      Role: field(d, roleId),
      'Opted in': klDate(o?.at ?? d?.dateAdded),
      'Opt-in form': (o && formLabel.get(o.formId)) || d?.source || '',
      'First touch': touch === 'ads' ? 'Ads' : touch === 'organic' ? 'Organic' : touch ? 'Unknown' : '',
      'Last message from them': c ? klDateTime(c.lastInboundAt) : '',
      Interest: c?.interest ?? (u ? `Started checkout${u.amount ? ` (RM${u.amount})` : ''}` : ''),
      Objection: c?.objection ?? (u ? `Payment ${u.status} — didn't complete` : ''),
      "Event they're eyeing": c?.event ?? '',
      'Suggested next step': c?.next ?? (u ? 'Ask what stopped the payment and resend the payment link' : ''),
      'Paid?': paid ? `Paid ✅ ${klDate(paid)}` : 'Not yet',
      'GHL link': `=HYPERLINK("https://app.gohighlevel.com/v2/location/${args.locationId}/contacts/detail/${id}","Open in GHL")`,
      'Assigned to': args.assignee ?? '',
      Key: `${f.day}|${id}`,
    })
  }
  // Payment problems first, then by last message.
  return rows.sort((a, b) => Number(String(b.Type).startsWith('💳')) - Number(String(a.Type).startsWith('💳')))
}

/** Everyone who has paid, for the sheet to mark "Paid ✅" on their older rows. */
export const paidList = (f: Followups) => [...f.paidAt].map(([contactId, at]) => ({ contactId, paidAt: klDate(at) }))

/** Send rows to the sheet's Apps Script. Never throws — returns the outcome for a note. */
export async function pushHotLeads(
  url: string,
  secret: string,
  rows: SheetRow[],
  paid: { contactId: string; paidAt: string }[],
): Promise<{ ok: boolean; inserted?: number; updated?: number; paidMarked?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, rows, paid }),
      redirect: 'follow', // Apps Script answers via a redirect to googleusercontent.com
      signal: AbortSignal.timeout(60000),
    })
    const body = await res.text()
    try {
      return JSON.parse(body)
    } catch {
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
