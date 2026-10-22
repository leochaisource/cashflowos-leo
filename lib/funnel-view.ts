import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdClient } from './ad-clients.ts'
import { journeyFor, type RateKey } from './funnel-config.ts'
import { archiveCohort, eventWindows, klEnd, klToday, loadJourney, loadManualBenchmarks, loadSpend, windowFor, type EventWindow } from './funnel-data.ts'
import { bottleneckLine, funnelReport, historyBenchmarks, rankCreatives, type CreativeRow, type FunnelReport, type JourneyRow, type Status } from './funnel-report.ts'

// One event cohort, ready to show (owner, 2026-10-22): the Funnel tab, the
// 8am brief line and the red-stage alert all read this, so they agree.

export type FunnelView = {
  window: EventWindow
  windows: EventWindow[]
  /** 'all' or one funnel label. */
  funnel: string
  funnels: string[]
  rows: JourneyRow[]
  report: FunnelReport
  creatives: CreativeRow[]
  eventOpen: boolean
  /** The journey table has this cohort (else only opt-ins and sales, from the archive). */
  tracked: boolean
  /** Finished events the benchmarks came from. */
  history: string[]
  error: string | null
}

const HISTORY_EVENTS = 3

export async function funnelView(db: SupabaseClient, client: AdClient, opts: { eventNo?: number; funnel?: string } = {}): Promise<FunnelView | null> {
  const cfg = journeyFor(client.id)
  const windows = eventWindows(client)
  if (!cfg || !windows.length) return null
  const today = klToday()
  const window = (opts.eventNo ? windows.find((w) => w.no === opts.eventNo) : null) ?? windowFor(client, today) ?? windows[windows.length - 1]
  const eventOpen = window.to >= today
  const funnel = opts.funnel && opts.funnel !== 'all' ? opts.funnel : 'all'

  let rows: JourneyRow[] = []
  let tracked = true
  let error: string | null = null
  try {
    rows = await loadJourney(db, client.id, window.date)
    if (!rows.length) tracked = false
  } catch (e) {
    tracked = false
    error = (e as Error).message
  }
  if (!tracked) rows = await archiveCohort(db, client, window.from, window.to, eventOpen ? new Date().toISOString() : klEnd(window.to))
  const funnels = [...new Set(rows.map((r) => r.funnel ?? 'Other'))].sort()
  const mine = funnel === 'all' ? rows : rows.filter((r) => (r.funnel ?? 'Other') === funnel)

  const spend = await loadSpend(db, client, window.from, eventOpen ? today : window.to)
  const spendTotal = funnel === 'all' ? spend.total : spend.byFunnel.get(funnel) ?? 0

  // Benchmarks: the median of the last finished events, unless typed in.
  const finished = windows.filter((w) => w.to < today && w.date !== window.date && w.to < window.to).slice(-HISTORY_EVENTS)
  const past: JourneyRow[][] = []
  const history: string[] = []
  if (tracked)
    for (const w of finished) {
      const rs = await loadJourney(db, client.id, w.date).catch(() => [] as JourneyRow[])
      const f = funnel === 'all' ? rs : rs.filter((r) => (r.funnel ?? 'Other') === funnel)
      if (f.length) {
        past.push(f)
        history.push(w.label)
      }
    }
  const manual = await loadManualBenchmarks(db, client.id, funnel)
  const benchmarks = historyBenchmarks(past, cfg, manual)

  const report = funnelReport({ rows: mine, config: cfg, spend: spendTotal, eventOpen, benchmarks, stagesTracked: tracked })
  const creatives = rankCreatives(mine, spend.byAd, tracked)
  return { window, windows, funnel, funnels, rows: mine, report, creatives, eventOpen, tracked, history, error }
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** The 8am brief's line for the event in progress. Empty when there's no bottleneck or nothing is tracked yet. */
export async function funnelBriefLine(db: SupabaseClient, client: AdClient): Promise<string> {
  const v = await funnelView(db, client)
  if (!v || !v.tracked) return ''
  return bottleneckLine(v.report, `${v.window.label} · ${shortDate(v.window.date)}`, client.currency || 'RM') ?? ''
}

/**
 * Rates that turned red since the last check (stored in cfo-cache
 * funnel/<project>-status.json). The first check only records, never alerts.
 */
export async function newlyRed(db: SupabaseClient, client: AdClient): Promise<{ view: FunnelView | null; red: FunnelReport['rates'] }> {
  const v = await funnelView(db, client)
  if (!v || !v.tracked) return { view: v, red: [] }
  const path = `funnel/${client.id}-status.json`
  type State = { event?: string; statuses?: Partial<Record<RateKey, Status>> }
  const { data } = await db.storage.from('cfo-cache').download(path)
  const prev: State | null = data ? (JSON.parse(await data.text()) as State) : null
  const statuses = Object.fromEntries(v.report.rates.map((r) => [r.key, r.status])) as Partial<Record<RateKey, Status>>
  const red = prev?.event === v.window.date ? v.report.rates.filter((r) => r.status === 'red' && prev?.statuses?.[r.key] !== 'red') : []
  await db.storage.from('cfo-cache').upload(path, JSON.stringify({ event: v.window.date, at: new Date().toISOString(), statuses }), { upsert: true, contentType: 'application/json' })
  return { view: v, red }
}
