import type { Project } from './ad-clients'

// No `import 'server-only'` here on purpose: this module holds no credentials —
// it reads a link-shared CSV — and staying free of that guard is what lets the
// parser be run and tested offline against a captured sheet.

// THE MASTER LEADS SHEET — every opt-in, and whether they paid.
//
// Read as CSV through Google's export endpoint, so a link-shared sheet needs no
// API key and no service account. Read-only by construction: this code cannot
// write to the client's sheet even if something later asks it to.
//
// Everything here is defensive on purpose. A leads sheet is a LIVING document
// that a human edits daily: columns get renamed, reordered, added, and typed
// into by hand. The first real sheet proved the point — its "UTM Content"
// header contains a NON-BREAKING SPACE (U+00A0) instead of a space, so an exact
// header match silently returns nothing and the brief would have reported "no
// ads produced any leads" forever, with no error anywhere.

const EXPORT = (id: string, gid = '0') =>
  `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`

// ---------------------------------------------------------------- CSV
/** RFC4180-ish parser: handles quoted fields, escaped quotes, and newlines inside cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows
}

/**
 * Header keys, flattened to something matchable: every kind of space (including
 * the non-breaking one Google Forms likes to emit), punctuation and case are
 * removed. "UTM Content", "utm content" and "UTM_Content" all become
 * "utmcontent".
 */
const norm = (s: string) => s.replace(/[\s ​]+/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase()

/** First column whose normalised header matches any alias. -1 when absent. */
function findCol(headers: string[], aliases: string[]): number {
  const flat = headers.map(norm)
  for (const a of aliases) {
    const i = flat.indexOf(norm(a))
    if (i !== -1) return i
  }
  return -1
}

// ---------------------------------------------------------------- parsing bits
/**
 * Dates as a Malaysian human types them: 4/8/2026 is the 4th of August.
 * DAY FIRST — reading it month-first would put every August lead in April and
 * quietly empty "leads yesterday".
 */
export function parseSheetDate(v: string): Date | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/)
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0'] = dmy
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm))
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t)
}

/** "RM397 (General)" → 397. "RM 1,297" → 1297. Anything unparseable → null. */
export function parseMoney(v: string): number | null {
  const m = (v ?? '').replace(/[, ]/g, '').match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

/** A hand-typed yes. Blank is "not recorded"; "no"/"0"/"-" is a real no. */
const truthy = (v: string): boolean => {
  const s = (v ?? '').trim().toLowerCase()
  if (!s || ['no', 'n', 'false', '0', '-', 'tbc', 'na', 'n/a'].includes(s)) return false
  return true
}

const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---------------------------------------------------------------- the shape
export type SheetLead = {
  optedInAt: Date | null
  date: string | null // YYYY-MM-DD, local
  name: string
  phone: string
  email: string
  ad: string // UTM Content — which creative brought them
  source: string // UTM Source — placement
  campaign: string
  webinar: string
  paid: boolean
  paidAmount: number | null
  attended: boolean | null // null = the sheet has no Attended column yet
  booked: boolean
  appointmentResult: string
  nextAction: string
  student: boolean
}

export type LeadsSummary = {
  ok: boolean
  error?: string
  total: number
  yesterday: number
  today: number
  last7: number
  /** null when the sheet carries no such column — never a fake zero. */
  attended: number | null
  appointments: number | null
  signups: number
  revenue: number
  byAd: { ad: string; leads: number; paid: number }[]
  bySource: { source: string; leads: number }[]
  followUps: { name: string; phone: string; days: number; ad: string }[]
  recentPayers: { name: string; amount: number | null; date: string | null }[]
  webinars: string[]
  hasAttendedColumn: boolean
}

// ---------------------------------------------------------------- load
export async function loadSheetLeads(project: Project): Promise<{ leads: SheetLead[]; error?: string }> {
  if (!project.leadsSheet) return { leads: [] }
  const url = EXPORT(project.leadsSheet.id, project.leadsSheet.gid)
  let text: string
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
    if (!res.ok) return { leads: [], error: `sheet returned HTTP ${res.status} — is it still shared as "anyone with the link"?` }
    text = await res.text()
    // A sheet that lost its link-sharing returns Google's sign-in HTML with a
    // 200, which would otherwise parse into gibberish rows.
    if (/^\s*</.test(text)) return { leads: [], error: 'sheet is no longer publicly readable (Google returned a login page)' }
  } catch (e) {
    return { leads: [], error: (e as Error).message }
  }

  const rows = parseCsv(text.trim())
  if (rows.length < 2) return { leads: [] }
  const headers = rows[0]
  const col = {
    date: findCol(headers, ['timezone', 'timestamp', 'date', 'submitted at', 'opt in time', 'created at']),
    name: findCol(headers, ['full name', 'name', 'lead name']),
    phone: findCol(headers, ['phone', 'phone number', 'whatsapp', 'contact']),
    email: findCol(headers, ['email', 'email address']),
    paid: findCol(headers, ['purchase ticket', 'ticket', 'purchase', 'payment', 'paid']),
    webinar: findCol(headers, ['webinar date', 'session', 'cohort', 'class date']),
    source: findCol(headers, ['utm source', 'source', 'placement']),
    ad: findCol(headers, ['utm content', 'ad', 'ad name', 'creative']),
    campaign: findCol(headers, ['utm campaign', 'campaign']),
    // Not in the sheet yet — the moment someone adds an "Attended" column it
    // starts counting, with no code change.
    attended: findCol(headers, ['attended', 'attendance', 'show up', 'showed up', 'turned up']),
    booked: findCol(headers, ['booked 1 1', 'booked 11', 'booked', 'appointment booked', 'call booked']),
    result: findCol(headers, ['appointment result', 'call result', 'outcome']),
    next: findCol(headers, ['next action', 'next step', 'follow up']),
    student: findCol(headers, ['student', 'enrolled', 'joined']),
  }
  const at = (r: string[], i: number) => (i === -1 ? '' : (r[i] ?? '').trim())

  const leads: SheetLead[] = rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim())) // skip blank rows a human left behind
    .map((r) => {
      const d = parseSheetDate(at(r, col.date))
      const paidRaw = at(r, col.paid)
      return {
        optedInAt: d,
        date: d ? localISO(d) : null,
        name: at(r, col.name) || '(no name)',
        phone: at(r, col.phone),
        email: at(r, col.email),
        ad: at(r, col.ad),
        source: at(r, col.source),
        campaign: at(r, col.campaign),
        webinar: at(r, col.webinar),
        paid: !!paidRaw,
        paidAmount: paidRaw ? parseMoney(paidRaw) : null,
        attended: col.attended === -1 ? null : truthy(at(r, col.attended)),
        booked: truthy(at(r, col.booked)),
        appointmentResult: at(r, col.result),
        nextAction: at(r, col.next),
        student: truthy(at(r, col.student)),
      }
    })

  return { leads }
}

// ---------------------------------------------------------------- summarise
export function summariseLeads(
  leads: SheetLead[],
  opts: { today?: string; hasAttendedColumn?: boolean; error?: string } = {},
): LeadsSummary {
  const now = new Date()
  const today = opts.today ?? localISO(now)
  const dayBefore = (n: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - n)
    return localISO(d)
  }
  const yest = dayBefore(1)
  const week = dayBefore(7)

  const paidLeads = leads.filter((l) => l.paid)
  const hasAttended = opts.hasAttendedColumn ?? leads.some((l) => l.attended !== null)
  const attendedCount = hasAttended ? leads.filter((l) => l.attended).length : null
  const bookedCount = leads.some((l) => l.booked) ? leads.filter((l) => l.booked).length : null

  const group = <T extends string>(key: (l: SheetLead) => T) => {
    const m = new Map<T, { leads: number; paid: number }>()
    for (const l of leads) {
      const k = key(l)
      const cur = m.get(k) ?? { leads: 0, paid: 0 }
      cur.leads++
      if (l.paid) cur.paid++
      m.set(k, cur)
    }
    return m
  }

  const byAd = [...group((l) => l.ad || '(no ad tag)')]
    .map(([ad, v]) => ({ ad, ...v }))
    .sort((a, b) => b.leads - a.leads)
  const bySource = [...group((l) => l.source || '(none)')]
    .map(([source, v]) => ({ source, leads: v.leads }))
    .sort((a, b) => b.leads - a.leads)

  // Who to chase: opted in, hasn't paid, and nobody has written a next action
  // against them. Oldest first — the ones going cold.
  const followUps = leads
    .filter((l) => !l.paid && !l.nextAction && l.optedInAt)
    .map((l) => ({
      name: l.name,
      phone: l.phone,
      days: Math.max(0, Math.floor((now.getTime() - (l.optedInAt as Date).getTime()) / 86400000)),
      ad: l.ad,
    }))
    .sort((a, b) => b.days - a.days)

  const recentPayers = paidLeads
    .sort((a, b) => (b.optedInAt?.getTime() ?? 0) - (a.optedInAt?.getTime() ?? 0))
    .map((l) => ({ name: l.name, amount: l.paidAmount, date: l.date }))

  return {
    ok: !opts.error,
    error: opts.error,
    total: leads.length,
    yesterday: leads.filter((l) => l.date === yest).length,
    today: leads.filter((l) => l.date === today).length,
    last7: leads.filter((l) => l.date && l.date >= week).length,
    attended: attendedCount,
    appointments: bookedCount,
    signups: paidLeads.length,
    revenue: paidLeads.reduce((s, l) => s + (l.paidAmount ?? 0), 0),
    byAd,
    bySource,
    followUps,
    recentPayers,
    webinars: [...new Set(leads.map((l) => l.webinar).filter(Boolean))],
    hasAttendedColumn: hasAttended,
  }
}

/** Load + summarise in one call. Never throws — a bad sheet must not kill a brief. */
export async function leadsSummary(project: Project, today?: string): Promise<LeadsSummary | null> {
  if (!project.leadsSheet) return null
  const { leads, error } = await loadSheetLeads(project)
  return summariseLeads(leads, { today, error })
}
