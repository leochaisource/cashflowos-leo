import { CORE, RATES, STAGES, type JourneyConfig, type RateKey, type StageKey } from './funnel-config.ts'

// THE FUNNEL X-RAY, computed (owner, 2026-10-22). Pure: rows in, numbers out,
// so the Funnel tab, the 8am brief, the red-stage alert and the scripts can
// never disagree. Rows come from `lead_journey` (lib/lead-journey.ts).
//
// The bottleneck is the stage with the most MONEY at stake, not the reddest
// one: for each rate below its benchmark, "if this stage converted at the
// benchmark, how many more customers would the cohort have had" — using what
// actually happened to the leads who did get past it — times revenue per
// customer.

export type JourneyRow = {
  contact_id: string
  name: string | null
  funnel: string | null
  form_id?: string | null
  ad_name: string | null
  campaign?: string | null
  opted_in_at: string
  webinar_at: string | null
  replied_at: string | null
  engaged_at: string | null
  hot_at: string | null
  called_at: string | null
  picked_up?: boolean | null
  checkout_at: string | null
  paid_at: string | null
  seats: number | null
  revenue: number | null
  attended_at: string | null
  intent?: string | null
  list_stage?: string | null
}

const COLUMN: Record<StageKey, keyof JourneyRow> = {
  optin: 'opted_in_at',
  webinar: 'webinar_at',
  replied: 'replied_at',
  engaged: 'engaged_at',
  hot: 'hot_at',
  called: 'called_at',
  checkout: 'checkout_at',
  paid: 'paid_at',
  attended: 'attended_at',
}

/** When the lead hit this stage itself (no carrying forward), or null. */
export const stageTime = (r: JourneyRow, s: StageKey): string | null => (r[COLUMN[s]] as string | null) ?? null

/** Furthest core stage reached (index into CORE). */
function coreReach(r: JourneyRow): number {
  for (let i = CORE.length - 1; i >= 0; i--) if (stageTime(r, CORE[i])) return i
  return 0
}

/** Reached `s`: core stages carry forward from any later core stage; side stages must have happened. */
export function reached(r: JourneyRow, s: StageKey): boolean {
  const i = CORE.indexOf(s)
  return i >= 0 ? coreReach(r) >= i : !!stageTime(r, s)
}

export type Status = 'green' | 'yellow' | 'red' | 'none'

export type RateRow = {
  key: RateKey
  label: string
  owner: string | null
  side: boolean
  base: number
  hit: number
  rate: number | null
  benchmark: number | null
  benchmarkSource: 'history' | 'manual' | null
  status: Status
  /** Extra customers if this stage converted at its benchmark (null = can't tell). */
  customersAtStake: number | null
  /** ...in money, at this cohort's revenue per customer. */
  atStake: number | null
  /** While the event is open, only leads old enough to have had the chance count. */
  matureDays: number
  note: string | null
}

export type FunnelReport = {
  leads: number
  counts: Record<StageKey, number>
  customers: number
  seats: number
  revenue: number
  revenuePerCustomer: number | null
  spend: number | null
  costPer: Partial<Record<StageKey, number | null>>
  roas: number | null
  rates: RateRow[]
  bottleneck: RateRow | null
  speed: { replyHours: number | null; callHours: number | null; payDays: number | null }
}

export type Benchmarks = Partial<Record<RateKey, { value: number; source: 'history' | 'manual' }>>

const MIN_BASE = 10
const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 36e5

export function funnelReport(args: {
  rows: JourneyRow[]
  config: JourneyConfig
  spend: number | null
  now?: Date
  /** The event hasn't happened yet: young leads are left out of each rate. */
  eventOpen: boolean
  benchmarks?: Benchmarks
  /** false = rows from the archive only (opt-in and paid): every stage rate in between is unknown, not 100%. */
  stagesTracked?: boolean
}): FunnelReport {
  const { rows, config } = args
  const now = (args.now ?? new Date()).getTime()
  const counts = Object.fromEntries(STAGES.map((s) => [s.key, rows.filter((r) => reached(r, s.key)).length])) as Record<StageKey, number>
  const paidRows = rows.filter((r) => r.paid_at)
  const customers = paidRows.length
  const seats = paidRows.reduce((n, r) => n + (r.seats ?? 1), 0)
  const revenue = rows.reduce((n, r) => n + Number(r.revenue ?? 0), 0)
  const revenuePerCustomer = customers ? revenue / customers : null
  const attendedTracked = config.attendedTags.length > 0 || rows.some((r) => r.attended_at)

  const rates: RateRow[] = []
  for (const def of RATES) {
    if (def.key === 'webinar' && !config.webinarFunnel) continue
    const owner = config.owners[def.key] ?? null
    const bench = args.benchmarks?.[def.key]
    const blank = (note: string): RateRow => ({
      key: def.key, label: def.label, owner, side: !!def.side, base: 0, hit: 0, rate: null,
      benchmark: bench?.value ?? null, benchmarkSource: bench?.source ?? null, status: 'none',
      customersAtStake: null, atStake: null, matureDays: def.matureDays, note,
    })
    if (args.stagesTracked === false) {
      rates.push(blank('needs the nightly lead journey'))
      continue
    }
    if (def.key === 'showup' && !attendedTracked) {
      rates.push(blank('not tracked yet: needs an attendance list'))
      continue
    }
    if (def.key === 'showup' && args.eventOpen) {
      rates.push(blank('after the event'))
      continue
    }
    const cutoff = args.eventOpen && def.matureDays ? now - def.matureDays * 864e5 : Infinity
    let base = rows.filter((r) => reached(r, def.from) && Date.parse(r.opted_in_at) <= cutoff)
    if (def.key === 'webinar') base = base.filter((r) => r.funnel === config.webinarFunnel)
    const hitRows = base.filter((r) => reached(r, def.to))
    const rate = base.length ? hitRows.length / base.length : null
    const row: RateRow = {
      key: def.key, label: def.label, owner, side: !!def.side, base: base.length, hit: hitRows.length, rate,
      benchmark: bench?.value ?? null, benchmarkSource: bench?.source ?? null, status: 'none',
      customersAtStake: null, atStake: null, matureDays: def.matureDays, note: null,
    }
    if (base.length < MIN_BASE) row.note = base.length ? `only ${base.length} leads so far` : 'no leads at this stage yet'
    else if (row.benchmark === null) row.note = 'no benchmark yet'
    else {
      const b = row.benchmark
      row.status = rate! >= b ? 'green' : rate! >= b * config.yellowFloor ? 'yellow' : 'red'
      if (rate! < b && def.key !== 'showup') {
        let extra: number | null = null
        if (!def.side) {
          // Leads who did get past this stage went on to pay at this rate.
          const downstream = hitRows.length ? hitRows.filter((r) => r.paid_at).length / hitRows.length : null
          if (downstream !== null) extra = (b - rate!) * base.length * downstream
        } else {
          // A side stage only matters if the leads who hit it paid more often.
          const missed = base.filter((r) => !reached(r, def.to))
          if (hitRows.length >= MIN_BASE && missed.length >= MIN_BASE) {
            const withIt = hitRows.filter((r) => r.paid_at).length / hitRows.length
            const without = missed.filter((r) => r.paid_at).length / missed.length
            if (withIt > without) extra = (b - rate!) * base.length * (withIt - without)
          }
          if (extra === null) row.note = "can't tell its effect on sales yet"
        }
        row.customersAtStake = extra
        row.atStake = extra !== null && revenuePerCustomer !== null ? extra * revenuePerCustomer : null
      }
    }
    rates.push(row)
  }

  const behind = rates.filter((r) => r.status === 'red' || r.status === 'yellow')
  const bottleneck =
    [...behind].filter((r) => r.atStake !== null).sort((a, b) => b.atStake! - a.atStake!)[0] ??
    [...behind].sort((a, b) => a.rate! / a.benchmark! - b.rate! / b.benchmark!)[0] ??
    null

  const spend = args.spend
  const costPer: Partial<Record<StageKey, number | null>> = {}
  for (const k of ['optin', 'replied', 'engaged', 'hot', 'checkout', 'paid'] as StageKey[])
    costPer[k] = spend !== null && counts[k] ? spend / counts[k] : null

  const replyH = rows.filter((r) => r.replied_at && r.replied_at >= r.opted_in_at).map((r) => hours(r.opted_in_at, r.replied_at!))
  const callH = rows.filter((r) => r.called_at && r.hot_at && r.called_at >= r.hot_at).map((r) => hours(r.hot_at!, r.called_at!))
  const payD = paidRows.filter((r) => r.paid_at! >= r.opted_in_at).map((r) => hours(r.opted_in_at, r.paid_at!) / 24)

  return {
    leads: rows.length,
    counts,
    customers,
    seats,
    revenue,
    revenuePerCustomer,
    spend,
    costPer,
    roas: spend ? revenue / spend : null,
    rates,
    bottleneck,
    speed: { replyHours: median(replyH), callHours: median(callH), payDays: median(payD) },
  }
}

/**
 * Benchmarks from the project's own FINISHED events: the median rate per stage
 * across them, counting only cohorts with at least 20 leads at the base.
 * Typed-in values (funnel_benchmarks) override these.
 */
export function historyBenchmarks(finished: JourneyRow[][], config: JourneyConfig, manual: Partial<Record<RateKey, number>> = {}): Benchmarks {
  const per = new Map<RateKey, number[]>()
  // A past event only speaks for a stage it actually recorded: an event that
  // ended before a stage was tracked would otherwise show 100% (everyone who
  // paid "got past" it) and set an impossible benchmark.
  const recorded = (rows: JourneyRow[], s: StageKey) => s === 'optin' || rows.filter((r) => stageTime(r, s)).length >= 5
  for (const rows of finished) {
    const rep = funnelReport({ rows, config, spend: null, eventOpen: false })
    for (const r of rep.rates) {
      const def = RATES.find((d) => d.key === r.key)!
      if (r.rate === null || r.base < 20 || !recorded(rows, def.from) || !recorded(rows, def.to)) continue
      ;(per.get(r.key) ?? per.set(r.key, []).get(r.key)!).push(r.rate)
    }
  }
  const out: Benchmarks = {}
  for (const [k, xs] of per) {
    const m = median(xs)
    if (m !== null) out[k] = { value: m, source: 'history' }
  }
  for (const [k, v] of Object.entries(manual)) if (typeof v === 'number') out[k as RateKey] = { value: v, source: 'manual' }
  return out
}

// ---------------------------------------------------------------- creatives

export type CreativeRow = {
  funnel: string
  ad: string
  leads: number
  spend: number | null
  customers: number
  seats: number
  revenue: number
  cpl: number | null
  costPerCustomer: number | null
  leadToCustomer: number | null
  /** Share of this ad's leads that reached each core stage. */
  reach: Partial<Record<StageKey, number>>
  /** The core stage where this ad's leads fall furthest behind the funnel's other leads. */
  weakStage: StageKey | null
}

export const NO_AD_TAG = '(no ad tag)'
export const UNFILLED_AD_TAG = '(ad name not filled in)'

/** The ad a lead came from, as the dashboards name it. */
export function adLabel(utm: string | null | undefined): string {
  const s = (utm ?? '').trim()
  if (!s) return NO_AD_TAG
  if (/\{\{.*\}\}/.test(s)) return UNFILLED_AD_TAG
  return s
}

export const adKey = (funnel: string, ad: string) => `${funnel}::${ad.toLowerCase().replace(/\s+/g, ' ').trim()}`

/**
 * Every ad, by funnel, with what its leads became. `spend` is keyed by
 * adKey(funnel, ad). `stagesTracked` = the rows carry the middle stages (the
 * journey table); without it only leads and customers are known.
 */
export function rankCreatives(rows: JourneyRow[], spend: Map<string, number>, stagesTracked: boolean): CreativeRow[] {
  const groups = new Map<string, JourneyRow[]>()
  for (const r of rows) {
    const k = adKey(r.funnel ?? 'Other', adLabel(r.ad_name))
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(r)
  }
  const steps: StageKey[] = ['replied', 'engaged', 'hot', 'checkout', 'paid']
  const funnelStep = new Map<string, number>()
  const stepRate = (rs: JourneyRow[], i: number) => {
    const from = i ? steps[i - 1] : 'optin'
    const base = rs.filter((r) => reached(r, from))
    return base.length >= MIN_BASE ? base.filter((r) => reached(r, steps[i])).length / base.length : null
  }
  if (stagesTracked)
    for (const f of new Set(rows.map((r) => r.funnel ?? 'Other'))) {
      const rs = rows.filter((r) => (r.funnel ?? 'Other') === f)
      steps.forEach((_, i) => {
        const v = stepRate(rs, i)
        if (v !== null) funnelStep.set(`${f}::${i}`, v)
      })
    }
  const out: CreativeRow[] = []
  for (const rs of groups.values()) {
    const funnel = rs[0].funnel ?? 'Other'
    const ad = adLabel(rs[0].ad_name)
    const paid = rs.filter((r) => r.paid_at)
    const sp = spend.get(adKey(funnel, ad)) ?? null
    const reach: Partial<Record<StageKey, number>> = {}
    let weakStage: StageKey | null = null
    if (stagesTracked) {
      for (const s of steps) reach[s] = rs.filter((r) => reached(r, s)).length / rs.length
      let worst = 0.85 // only call out a stage well below the funnel's own rate
      steps.forEach((s, i) => {
        const mine = stepRate(rs, i)
        const all = funnelStep.get(`${funnel}::${i}`)
        if (mine !== null && all) {
          const ratio = mine / all
          if (ratio < worst) {
            worst = ratio
            weakStage = s
          }
        }
      })
    }
    out.push({
      funnel,
      ad,
      leads: rs.length,
      spend: sp,
      customers: paid.length,
      seats: paid.reduce((n, r) => n + (r.seats ?? 1), 0),
      revenue: rs.reduce((n, r) => n + Number(r.revenue ?? 0), 0),
      cpl: sp !== null && rs.length ? sp / rs.length : null,
      costPerCustomer: sp !== null && paid.length ? sp / paid.length : null,
      leadToCustomer: rs.length ? paid.length / rs.length : null,
      reach,
      weakStage,
    })
  }
  return out
}

/**
 * Best first: ads with customers by cost per customer; then ads that spent
 * without a customer, most money first; last, leads with no ad to charge
 * (no tag, or a tag that matches no ad), most leads first.
 */
export function sortCreatives(rows: CreativeRow[], by: 'customer' | 'cpl'): CreativeRow[] {
  const tier = (c: CreativeRow) => (!c.spend ? 2 : by === 'cpl' || c.customers ? 0 : 1)
  return [...rows].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b)
    if (tier(a) === 2) return b.leads - a.leads
    if (by === 'cpl') return (a.cpl ?? Infinity) - (b.cpl ?? Infinity) || b.leads - a.leads
    if (tier(a) === 0) return a.costPerCustomer! - b.costPerCustomer!
    return (b.spend ?? 0) - (a.spend ?? 0)
  })
}

/** One line for the 8am brief — the bottleneck, its gap and what it's worth. Null when nothing is behind. */
export function bottleneckLine(rep: FunnelReport, eventLabel: string, currency = 'RM'): string | null {
  const b = rep.bottleneck
  if (!b || b.rate === null || b.benchmark === null) return null
  const pctS = (v: number) => `${Math.round(v * 100)}%`
  const stake = b.atStake !== null ? ` · ~${currency}${Math.round(b.atStake).toLocaleString('en-MY')} at stake` : ''
  const icon = b.status === 'red' ? '🔴' : '🟡'
  return `🧭 Funnel bottleneck (${eventLabel}): ${icon} ${b.label} ${pctS(b.rate)} vs ${pctS(b.benchmark)} benchmark${stake}${b.owner ? ` · ${b.owner}` : ''}`
}
