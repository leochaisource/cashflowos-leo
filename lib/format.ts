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
export function whenShort(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  const time = d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit' })
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days < 1) return `today ${time}`
  if (days < 2) return `yesterday ${time}`
  return `${d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })} ${time}`
}

/** "2 Aug 2026" for launch dates. */
export function dateLong(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Days from today until a date. Negative = in the past. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}
