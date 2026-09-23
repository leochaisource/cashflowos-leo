// Display formatting. Pure and client-safe (no 'server-only') so the entry form
// and the tiles can share it.
//
// Every formatter takes `number | null` and returns EM DASH for null. That's the
// visible half of the null ≠ 0 rule in lib/metrics.ts: a metric nobody has
// recorded looks obviously empty, never like a measured zero.

export const DASH = '—'

/** Money. Small amounts (a CPL) keep their sen; large ones don't need them. */
export function money(n: number | null | undefined, currency = 'RM'): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH
  const dp = Math.abs(n) < 100 ? 2 : 0
  return `${currency} ${n.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

/** A rate that arrives as 0–1. `pct(0.62)` → "62%". */
export function pct(n: number | null | undefined, dp = 0): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH
  return `${(n * 100).toFixed(dp)}%`
}

/** Whole counts. */
export function num(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH
  return n.toLocaleString('en-MY')
}

/** ROAS and friends. */
export function times(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH
  return `${n.toFixed(2)}×`
}

/** "8:04am, today" / "yesterday 8:04am" / "3 Aug, 8:04am" — for the sync stamp. */
/**
 * Every date and time on the dashboard is MALAYSIAN time, stated explicitly.
 *
 * Without a timeZone, toLocale* uses the machine's zone — and Vercel's servers
 * run in UTC, so production printed every time eight hours early ("synced
 * 12:35 am" for an 8:35 am sync), while the same code on a laptop in KL looked
 * right. An explicit zone also means server and browser always agree, so a
 * client component can never hydrate with a different time than the server
 * rendered.
 */
const TZ = 'Asia/Kuala_Lumpur'

/** The calendar day of an instant, in Malaysia: "2026-09-23". */
const klDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ })

/**
 * Whole CALENDAR days between an instant and now, in Malaysia. Not "periods of
 * 24 hours": at 1am, something from 8:35am the previous morning is yesterday,
 * even though it was only seventeen hours ago.
 */
function calendarDaysAgo(d: Date, now = new Date()): number {
  return Math.round((Date.parse(klDay(now)) - Date.parse(klDay(d))) / 86400000)
}

export function whenShort(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  const time = d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
  const days = calendarDaysAgo(d)
  if (days <= 0) return `today ${time}`
  if (days === 1) return `yesterday ${time}`
  return `${d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', timeZone: TZ })} ${time}`
}

/** "2 Aug 2026" for launch dates. A date-only "2026-08-02" (UTC midnight) is 8am that day in KL — the same date. */
export function dateLong(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ })
}

/** Days from today until a date. Negative = in the past. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}

/**
 * "today" / "yesterday" / "3d ago" / "2 Aug" — for WHEN something was last
 * seen, where the distance matters more than the clock time.
 */
export function agoShort(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  const days = calendarDaysAgo(d)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days}d ago`
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', timeZone: TZ })
}

/**
 * Shorten text to `max` CHARACTERS, never splitting one.
 *
 * `.slice()` counts UTF-16 units, and the bold/italic "𝐔𝐧𝐢𝐜𝐨𝐝𝐞 𝐟𝐨𝐧𝐭𝐬" competitor
 * ads love are two units each — so a plain slice can cut one in half. The
 * orphaned half renders differently on the server and in the browser (a React
 * hydration error on the competitor library), and in anything sent to the
 * model it gets the whole request rejected. Array.from() walks code points.
 */
export function clip(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() + '…' : text
}
