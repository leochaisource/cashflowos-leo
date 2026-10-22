// THE FUNNEL X-RAY — stages, rates and who owns each one (owner, 2026-10-22).
//
// Modelled on a four-dashboard set-up (lead tick tracker, full-funnel report,
// bottleneck map against benchmarks, creative ranker by customers), adapted to
// an event business that sells over WhatsApp.
//
// Two kinds of stage:
//   · the CORE PATH, which every buyer passes: opted in → replied → engaged →
//     hot → checkout → paid → attended. A lead who reached a later core stage
//     counts as having passed the earlier ones, so the rates multiply out to
//     lead → customer (a direct-ticket buyer who never chatted still "got past"
//     the chat stages).
//   · SIDE STAGES, measured against their own base and never assumed: webinar
//     attendance (webinar-funnel leads) and calls (hot leads). A paid lead who
//     was never called is not counted as called — that gap is the point.
//
// Pure: no I/O, shared with scripts.

export const STAGES = [
  { key: 'optin', label: 'Opted in', short: 'Lead' },
  { key: 'webinar', label: 'Attended the webinar', short: 'Webinar' },
  { key: 'replied', label: 'Replied on WhatsApp', short: 'Replied' },
  { key: 'engaged', label: 'Engaged (warm or hot)', short: 'Engaged' },
  { key: 'hot', label: 'Hot', short: 'Hot' },
  { key: 'called', label: 'Called', short: 'Called' },
  { key: 'checkout', label: 'Reached payment', short: 'Payment' },
  { key: 'paid', label: 'Paid', short: 'Paid' },
  { key: 'attended', label: 'Attended the event', short: 'Attended' },
] as const

export type StageKey = (typeof STAGES)[number]['key']

/** The core path, in order. */
export const CORE: StageKey[] = ['optin', 'replied', 'engaged', 'hot', 'checkout', 'paid', 'attended']

export type RateKey = 'webinar' | 'reply' | 'engage' | 'hot' | 'call' | 'checkout' | 'pay' | 'showup'

export type RateDef = {
  key: RateKey
  label: string
  from: StageKey
  to: StageKey
  /** Side stage: not part of the core path, measured on its own base. */
  side?: boolean
  /** Only leads this many days old count while the event is still open — a lead from this morning hasn't had time. */
  matureDays: number
}

export const RATES: RateDef[] = [
  { key: 'webinar', label: 'Webinar show-up', from: 'optin', to: 'webinar', side: true, matureDays: 0 },
  { key: 'reply', label: 'Reply rate', from: 'optin', to: 'replied', matureDays: 2 },
  { key: 'engage', label: 'Engaged rate', from: 'replied', to: 'engaged', matureDays: 2 },
  { key: 'hot', label: 'Hot rate', from: 'engaged', to: 'hot', matureDays: 2 },
  { key: 'call', label: 'Call rate', from: 'hot', to: 'called', side: true, matureDays: 2 },
  { key: 'checkout', label: 'Reached payment', from: 'hot', to: 'checkout', matureDays: 7 },
  { key: 'pay', label: 'Payment completion', from: 'checkout', to: 'paid', matureDays: 3 },
  { key: 'showup', label: 'Event show-up', from: 'paid', to: 'attended', matureDays: 0 },
]

export type JourneyConfig = {
  /** Funnel label whose leads are invited to a webinar (the webinar stage applies to them only). */
  webinarFunnel?: string
  /** Webinar attendance tags: the general one plus dated ones like "cmw-attended-13oct" (prefix match). */
  webinarTagPrefix?: string
  /** Tags meaning the AI judged the chat warm or hot. */
  engagedTags: string[]
  /** Tags meaning hot: the AI's label and the buying-signal tags. */
  hotTags: string[]
  /** Tags meaning the payment step was reached. Leave empty unless a tag is as reliable as a recorded payment. */
  checkoutTags: string[]
  /** Tags meaning the person came to the event. Empty = not tracked yet. */
  attendedTags: string[]
  /** Who fixes each rate. */
  owners: Partial<Record<RateKey, string>>
  /** Green at or above the benchmark, yellow down to this share of it, red below. */
  yellowFloor: number
}

export const JOURNEYS: Record<string, JourneyConfig> = {
  'claude-malaysia': {
    webinarFunnel: 'Webinar Funnel',
    webinarTagPrefix: 'cmw-attended',
    engagedTags: ['intent-warm', 'intent-hot'],
    // Cart and checkout-page tags mean hot, not checkout: "checkout" is a payment
    // GHL recorded (dated), so every event — past ones included — is measured
    // the same way. They are the hot list's own entry tags too.
    hotTags: ['intent-hot', 'cm1d-hot', 'cm1d-cart', 'cm1d-checkout-open', 'cm1d-pay-failed'],
    checkoutTags: [],
    attendedTags: [],
    owners: {
      webinar: 'Webinar reminders',
      reply: 'Ari + welcome flows',
      engage: 'Ari',
      hot: 'Ari',
      call: 'Ariella',
      checkout: 'Ariella',
      pay: 'Payment page',
      showup: 'Event team',
    },
    yellowFloor: 0.9,
  },
}

export const journeyFor = (projectId: string): JourneyConfig | null => JOURNEYS[projectId] ?? null
