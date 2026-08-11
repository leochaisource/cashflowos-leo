import 'server-only'
import { PROJECTS, getProject, matchProject, type Project } from './ad-clients'
import { activeProjects } from './settings'
import { scorecards, projectScorecard, WINNER_MIN_LEADS, LOSER_MIN_IMPRESSIONS } from './metrics'
import { syncProjectAds } from './ad-sync'
import { accountInsights } from './meta'
import { loadSheetLeads, type SheetLead } from './leads-sheet'
import { todayISO, type Rec } from './records'

// The bot's ADS hands.
//
// Jarvis's original 13 tools all query ONE table — `records`. So "what's my CPL"
// or "which ad is winning" had no tool behind it, and a bot told never to guess a
// number correctly refused to answer. These tools give it the ad side.
//
// They read `ad_daily` — the daily Meta snapshot — not Meta itself, because a
// chat reply must come back in a second or two and a Graph call is 2-5s and
// rate-limited per token. `refresh_ads` is the escape hatch: it calls Meta live,
// on demand, then the next question reads the fresh rows.
//
// All read-only except refresh_ads, which only ever pulls data IN — it cannot
// change a campaign, a budget, or anything inside the ad account.

const WINDOW = 30

// ---------------------------------------------------------------- resolving
/**
 * Match however the owner says it: "kingsley", "claude malaysia", "dianna",
 * "the workshop one". Matches id, project name and client name.
 */
function resolve(q: string | undefined, pool: Project[]): { project?: Project; candidates?: Project[] } {
  if (!q || !q.trim()) {
    return pool.length === 1 ? { project: pool[0] } : { candidates: pool }
  }
  return matchProject(q, pool)
}

const ask = (candidates: Project[]) =>
  JSON.stringify({
    status: 'ambiguous',
    message: 'Which project?',
    projects: candidates.map((p) => ({ id: p.id, name: p.name })),
  })

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)
const pct = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 10)

// ---------------------------------------------------------------- the schema
export const BOT_ADS_TOOLS = [
  {
    name: 'list_projects',
    description:
      'List every ad project (client) with its headline ad numbers: spend, leads, CPL, active ads, ROAS. ' +
      'Use this FIRST when the owner asks about "my ads", "my clients", "my projects", or when a question ' +
      'does not name which client they mean.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_ad_performance',
    description:
      'Ad performance for one project: spend, leads, average CPL, active ad count, cost trend, and how it ' +
      'compares to the target CPL. Use for "how are the ads doing", "what is my CPL", "how much did I spend on ads".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project or client name, e.g. "Claude Malaysia" or "Dianna". Omit to be asked.' },
        days: { type: 'number', description: `Window in days. Default ${WINDOW}.` },
      },
      required: [],
    },
  },
  {
    name: 'ad_metrics_detail',
    description:
      'EVERY delivery metric for a project: spend, impressions, reach, frequency, clicks, link clicks, ' +
      'CPM, CTR, link CTR, CPC, cost per link click, leads, CPL, and click-to-lead rate — for ' +
      'yesterday, for the last 3 days, and for the window, plus a per-ad breakdown. ' +
      'USE THIS for any question naming a specific metric: "what is my CPM", "what is my CTR", ' +
      '"how is my frequency", "what am I paying per click", "detailed metrics", "full numbers", ' +
      '"break it down". Set live=true to pull it straight from Meta instead of this morning snapshot ' +
      '(that is also the only accurate source of multi-day reach and frequency).',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project or client name.' },
        days: { type: 'number', description: 'Window in days. Default 30.' },
        live: { type: 'boolean', description: 'True = ask Meta right now. Slower, but current to the minute.' },
      },
      required: [],
    },
  },
  {
    name: 'winning_ads',
    description:
      'The best-performing ads for a project — cheapest cost per lead, among ads with enough leads to be ' +
      'believable. Use for "which ad is winning", "best ad", "cheapest leads", "what should I scale".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project or client name.' },
        days: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'losing_ads',
    description:
      'The worst ads for a project — highest cost per lead, and separately the lowest link click-through ' +
      'rate. Use for "which ad is wasting money", "what should I turn off", "worst ad", "what is not working".',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project or client name.' },
        days: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'project_funnel_status',
    description:
      'The full funnel for one project: opt-ins, attendance, appointments, sign-ups, show-up rate, ' +
      'conversion rate, cost per acquisition, ROAS and cash collected. Use for "how is the funnel", ' +
      '"how many leads/sign-ups", "what is my ROAS", "show up rate".',
    input_schema: {
      type: 'object' as const,
      properties: { project: { type: 'string', description: 'Project or client name.' } },
      required: [],
    },
  },
  {
    name: 'leads_today',
    description:
      "Live read of a project's master leads sheet: opt-ins yesterday and today, who paid, and who is " +
      'waiting with no follow-up. Use for "any new leads", "who opted in", "who paid", "who do I chase".',
    input_schema: {
      type: 'object' as const,
      properties: { project: { type: 'string', description: 'Project or client name.' } },
      required: [],
    },
  },
  {
    name: 'lookup_person',
    description:
      'EVERYTHING known about one person or company, by name: which funnel stage they are in, how ' +
      'interested they look, when they were last touched and when to follow up, what ad brought them, ' +
      'what they have paid, and what they still owe with the due date and how late it is. ' +
      'Use this whenever the owner just types a name ("Rachel Ong", "Sunway"), or asks "where is X", ' +
      '"should I chase X", "does X owe me", "what stage is X at", "is X interested". ' +
      'Searches the pipeline, the customer list, the invoices AND the live leads sheet at once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The person or company name, or part of it. Phone or email also works.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'refresh_ads',
    description:
      'Pull fresh numbers from Meta RIGHT NOW for a project, instead of using this morning snapshot. ' +
      'Use when the owner asks for live/current/up-to-the-minute figures, or says the numbers look stale. ' +
      'Takes a few seconds. It only reads from Meta — it cannot change any campaign or budget.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project or client name.' },
        days: { type: 'number', description: 'How many days to re-pull. Default 7.' },
      },
      required: [],
    },
  },
]

export const ADS_TOOL_NAMES = new Set(BOT_ADS_TOOLS.map((t) => t.name))

// ---------------------------------------------------------------- one person
const PAID_STATUS = new Set(['paid', 'closed', 'won', 'executed', 'filed'])
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)

/**
 * How warm someone looks, from what the data actually shows. Deliberately
 * mechanical — it reports the evidence alongside the label so the bot can say
 * WHY, and nobody mistakes a heuristic for a scoring model.
 */
function interestLevel(
  sheet: SheetLead | undefined,
  lead: Rec | undefined,
  customer: Rec | undefined,
  owes: number,
): { level: string; because: string } {
  if (sheet?.paid || (lead && PAID_STATUS.has((lead.status || '').toLowerCase())))
    return { level: 'customer', because: 'has paid' }
  // Someone on the customer list has already bought — the question for them is
  // collection, not interest.
  if (customer)
    return owes > 0
      ? { level: 'customer', because: `on the books with RM ${owes.toLocaleString('en-MY')} outstanding` }
      : { level: 'customer', because: 'on the customer list, nothing outstanding' }
  const stage = (lead?.status || '').toLowerCase()
  if (stage === 'appointment' || sheet?.booked)
    return { level: 'hot', because: 'has an appointment booked' }
  if (sheet?.attended) return { level: 'warm', because: 'attended the session' }
  if (stage === 'contacted' || (lead && lead.meta?.next)) return { level: 'warm', because: 'has been contacted and has a next step' }
  if (stage === 'nurture') return { level: 'cold', because: 'parked in nurture' }
  if (sheet) {
    const age = sheet.date ? daysBetween(todayISO(), sheet.date) : 0
    return age > 5
      ? { level: 'going cold', because: `opted in ${age} days ago and nobody has followed up` }
      : { level: 'new', because: `opted in ${age} day(s) ago, not yet contacted` }
  }
  return { level: 'unknown', because: 'no activity recorded' }
}

async function lookupPerson(q: string, rows: Rec[], pool: Project[] = PROJECTS): Promise<string> {
  const needle = q.trim().toLowerCase()
  if (!needle) return JSON.stringify({ error: 'no name given' })

  const hit = (s: unknown) => String(s ?? '').toLowerCase().includes(needle)
  const matches = rows.filter(
    (r) => hit(r.title) || hit(r.meta?.customer) || hit(r.meta?.merchant) || hit(r.notes),
  )

  // The same person can appear in the leads sheet of any project.
  let sheetLead: SheetLead | undefined
  let sheetProject: string | undefined
  for (const p of pool.filter((x) => x.leadsSheet)) {
    const { leads } = await loadSheetLeads(p)
    const found = leads.find(
      (l) => hit(l.name) || (needle.length > 5 && (hit(l.phone) || hit(l.email))),
    )
    if (found) {
      sheetLead = found
      sheetProject = p.name
      break
    }
  }

  if (!matches.length && !sheetLead)
    return JSON.stringify({ found: false, searched: q, message: 'nobody by that name in the pipeline, the customer list, the invoices or the leads sheet' })

  const today = todayISO()
  const lead = matches.find((r) => r.category === 'lead')
  const customer = matches.find((r) => r.category === 'customer')
  const invoices = matches
    .filter((r) => r.category === 'cash_in' && !PAID_STATUS.has((r.status || '').toLowerCase()))
    .map((r) => ({
      what: r.title,
      amount: Number(r.amount) || 0,
      status: r.status,
      due: r.due_date,
      days_overdue: r.due_date && r.due_date < today ? daysBetween(today, r.due_date) : 0,
      days_until_due: r.due_date && r.due_date >= today ? daysBetween(r.due_date, today) : 0,
    }))
  const paidInvoices = matches
    .filter((r) => r.category === 'cash_in' && PAID_STATUS.has((r.status || '').toLowerCase()))
    .map((r) => ({ what: r.title, amount: Number(r.amount) || 0 }))
  const openTasks = matches.filter((r) => r.category === 'task' && !PAID_STATUS.has((r.status || '').toLowerCase()))

  const owesNow = invoices.reduce((s, i) => s + i.amount, 0)
  const { level, because } = interestLevel(sheetLead, lead, customer, owesNow)
  const lastTouch = (customer?.meta?.last_touch as string) || sheetLead?.date || null
  const nextAction =
    (lead?.meta?.next as string) || (customer?.meta?.next as string) || sheetLead?.nextAction || null

  return JSON.stringify({
    found: true,
    name: lead?.title || customer?.title || sheetLead?.name || q,
    interest: level,
    interest_because: because,
    // Funnel position, in the words the pipeline actually uses.
    stage: lead?.status ?? (customer ? 'customer' : sheetLead ? 'opted in (not yet in the pipeline)' : null),
    deal_value: lead ? Number(lead.meta?.potential ?? lead.amount) || null : null,
    last_touch: lastTouch,
    days_since_touch: lastTouch ? daysBetween(today, lastTouch) : null,
    next_action: nextAction,
    // Follow-up timing: a concrete recommendation, not "soon".
    // Money that is late outranks a written next action — chasing it IS the
    // next action, and the number of days makes the call concrete.
    follow_up: invoices.some((i) => i.days_overdue > 0)
      ? `today — chase RM ${invoices
          .filter((i) => i.days_overdue > 0)
          .reduce((s, i) => s + i.amount, 0)
          .toLocaleString('en-MY')}, ${Math.max(...invoices.map((i) => i.days_overdue))} day(s) overdue` +
        (nextAction ? ` (planned: ${nextAction})` : '')
      : nextAction
      ? `already planned: ${nextAction}`
      : level === 'hot'
        ? 'today — they have an appointment and no next step written down'
        : level === 'going cold'
          ? 'today — they have been waiting several days with no contact'
          : level === 'customer'
            ? 'no chase needed for the sale; check delivery/onboarding'
            : 'within 24 hours while the opt-in is fresh',
    from_leads_sheet: sheetLead
      ? {
          project: sheetProject,
          opted_in: sheetLead.date,
          days_waiting: sheetLead.date ? daysBetween(today, sheetLead.date) : null,
          ad_that_brought_them: sheetLead.ad || null,
          placement: sheetLead.source || null,
          session: sheetLead.webinar || null,
          phone: sheetLead.phone || null,
          email: sheetLead.email || null,
          paid: sheetLead.paid,
          paid_amount: sheetLead.paidAmount,
          attended: sheetLead.attended,
          booked_1_1: sheetLead.booked,
        }
      : null,
    money: {
      owes_now: owesNow,
      unpaid_invoices: invoices,
      overdue_count: invoices.filter((i) => i.days_overdue > 0).length,
      already_paid: paidInvoices,
      declared_owing_on_customer_row: (customer?.meta?.owes as number) ?? null,
    },
    open_tasks: openTasks.map((t) => ({ task: t.title, due: t.due_date })),
    records_matched: matches.length,
  })
}

// ---------------------------------------------------------------- execution
export async function runBotAdsTool(name: string, input: any, rows: Rec[] = []): Promise<string> {
  try {
    const days = Number.isFinite(Number(input?.days)) ? Math.min(Math.max(Number(input.days), 1), 90) : WINDOW

    // Which clients exist right now — the demo switch can hide the samples.
    const pool = await activeProjects()

    if (name === 'lookup_person') return await lookupPerson(String(input?.name ?? ''), rows, pool)

    if (name === 'list_projects') {
      const cards = await scorecards(pool, days)
      return JSON.stringify({
        window_days: days,
        projects: pool.map((p) => {
          const c = cards.get(p.id)!
          return {
            id: p.id,
            name: p.name,
            stage: p.stage ?? null,
            delivering: c.hasDelivery,
            spend: r2(c.spend),
            leads: c.leads,
            cpl: r2(c.avgCPL),
            active_ads: c.activeAds,
            signups: c.signups,
            roas: r2(c.roas),
            // A project with no spend in the window is not the same as one that
            // never ran — say which, so the bot can too.
            note: c.hasDelivery ? null : c.lastSpendDate ? `paused, last spent ${c.lastSpendDate}` : 'never delivered',
          }
        }),
      })
    }

    const { project, candidates } = resolve(input?.project, pool)
    if (!project) return ask(candidates ?? pool)

    if (name === 'refresh_ads') {
      const pulled = await syncProjectAds(project, Number.isFinite(Number(input?.days)) ? Number(input.days) : 7)
      const c = await projectScorecard(project, days)
      return JSON.stringify({
        project: project.name,
        refreshed_from: 'Meta Marketing API, just now',
        days_pulled: pulled.days,
        rows_updated: pulled.rows,
        spend: r2(c.spend),
        leads: c.leads,
        cpl: r2(c.avgCPL),
        active_ads: c.activeAds,
      })
    }

    const c = await projectScorecard(project, days)

    if (name === 'ad_metrics_detail') {
      // Rates go out as percentages with two decimals: a model handed 0.0447
      // will sooner or later report it as "0.04%".
      const block = (d: typeof c.yesterday) => ({
        spend: r2(d.spend),
        impressions: Math.round(d.impressions),
        clicks: Math.round(d.clicks),
        link_clicks: Math.round(d.linkClicks),
        leads: Math.round(d.leads * 100) / 100,
        cpm: r2(d.cpm),
        ctr_pct: pct(d.ctr),
        link_ctr_pct: pct(d.linkCtr),
        cpc: r2(d.cpc),
        cost_per_link_click: r2(d.costPerLinkClick),
        cpl: r2(d.cpl),
        link_click_to_lead_pct: pct(d.leadRate),
      })

      // Live: Meta is the only correct source of multi-day reach and frequency,
      // because reach is de-duplicated people and daily reach cannot be summed.
      let live = null
      if (input?.live && !project.demo) {
        const preset = days <= 1 ? 'yesterday' : days <= 7 ? 'last_7d' : days <= 14 ? 'last_14d' : 'last_30d'
        const a = await accountInsights(project, preset).catch(() => null)
        if (a)
          live = {
            window: a.window,
            spend: r2(a.spend),
            impressions: a.impressions,
            reach: a.reach,
            frequency: r2(a.frequency),
            clicks: a.clicks,
            link_clicks: a.linkClicks,
            unique_link_clicks: a.uniqueLinkClicks,
            cpm: r2(a.cpm),
            ctr_pct: pct(a.ctr),
            link_ctr_pct: pct(a.linkCtr),
            cpc: r2(a.cpc),
            cost_per_link_click: r2(a.costPerLinkClick),
            leads: a.leads,
            cpl: r2(a.cpl),
            // The full action list answers "how many landing page views /
            // video views / messaging starts" without another deploy.
            all_actions: a.actions.filter((x) => x.value > 0).slice(0, 25),
          }
      }

      return JSON.stringify({
        project: project.name,
        currency: project.currency,
        window_days: days,
        source: live ? 'Meta, live just now' : `stored snapshot, synced ${c.syncedAt ?? 'never'}`,
        yesterday: block(c.yesterday),
        last_3_days_total: block(c.last3),
        last_3_days_per_day: block(c.last3PerDay),
        window_total: block(c.delivery),
        live_from_meta: live,
        per_day: c.daily.slice(-7).map((d) => ({
          date: d.date,
          spend: r2(d.spend),
          impressions: d.impressions,
          reach: d.reach,
          frequency: r2(d.frequency),
          cpm: r2(d.cpm),
          link_ctr_pct: pct(d.linkCtr),
          cpc: r2(d.cpc),
          leads: d.leads,
          cpl: r2(d.cpl),
        })),
        per_ad: [...c.winners, ...c.losersByCPL, ...c.losersByCTR]
          .filter((a, i, arr) => arr.findIndex((x) => x.ad_id === a.ad_id) === i)
          .map((a) => ({
            ad: a.ad_name,
            spend: r2(a.spend),
            impressions: a.impressions,
            cpm: r2(a.cpm),
            ctr_pct: pct(a.allCtr),
            link_ctr_pct: pct(a.ctr),
            cpc: r2(a.cpc),
            leads: a.leads,
            cpl: r2(a.cpl),
            status: a.status,
          })),
        note: 'Multi-day reach and frequency are only in live_from_meta — daily reach cannot be added up.',
      })
    }

    if (name === 'get_ad_performance') {
      const last7 = c.dailySpend.slice(-7).reduce((s, d) => s + d.spend, 0)
      return JSON.stringify({
        project: project.name,
        window_days: days,
        delivering: c.hasDelivery,
        last_spend_date: c.lastSpendDate,
        spend: r2(c.spend),
        spend_yesterday: r2(c.spendYesterday),
        spend_last_7_days: r2(last7),
        leads: c.leads,
        cpl: r2(c.avgCPL),
        // The headline delivery metrics, so the commonest follow-up ("and the
        // CPM?") doesn't need a second tool call.
        cpm: r2(c.delivery.cpm),
        ctr_pct: pct(c.delivery.ctr),
        link_ctr_pct: pct(c.delivery.linkCtr),
        cpc: r2(c.delivery.cpc),
        impressions: c.delivery.impressions,
        yesterday: {
          spend: r2(c.yesterday.spend),
          cpm: r2(c.yesterday.cpm),
          link_ctr_pct: pct(c.yesterday.linkCtr),
          cpl: r2(c.yesterday.cpl),
          leads: c.yesterday.leads,
        },
        last_3_days_per_day: {
          spend: r2(c.last3PerDay.spend),
          cpm: r2(c.last3PerDay.cpm),
          link_ctr_pct: pct(c.last3PerDay.linkCtr),
          cpl: r2(c.last3PerDay.cpl),
          leads: Math.round(c.last3PerDay.leads * 100) / 100,
        },
        target_cpl: project.targetCPL ?? null,
        vs_target: c.avgCPL !== null && project.targetCPL ? (c.avgCPL <= project.targetCPL ? 'at or under target' : 'over target') : null,
        active_ads: c.activeAds,
        ads_with_spend: c.adsWithSpend,
        currency: project.currency,
        synced_at: c.syncedAt,
      })
    }

    if (name === 'winning_ads') {
      return JSON.stringify({
        project: project.name,
        window_days: days,
        rule: `only ads with ${WINNER_MIN_LEADS}+ leads qualify, so one lucky cheap lead cannot top the list`,
        winners: c.winners.map((a) => ({ ad: a.ad_name, campaign: a.campaign_name, spend: r2(a.spend), leads: a.leads, cpl: r2(a.cpl), link_ctr_pct: pct(a.ctr), status: a.status })),
        note: c.winners.length ? null : `no ad has reached ${WINNER_MIN_LEADS} leads in this window yet`,
      })
    }

    if (name === 'losing_ads') {
      return JSON.stringify({
        project: project.name,
        window_days: days,
        worst_cpl: c.losersByCPL.map((a) => ({ ad: a.ad_name, spend: r2(a.spend), leads: a.leads, cpl: a.cpl === null ? 'spent with no leads' : r2(a.cpl), status: a.status })),
        worst_link_ctr: c.losersByCTR.map((a) => ({ ad: a.ad_name, impressions: a.impressions, link_ctr_pct: pct(a.ctr), spend: r2(a.spend), status: a.status })),
        rule: `CTR ranking needs ${LOSER_MIN_IMPRESSIONS}+ impressions to mean anything`,
      })
    }

    if (name === 'project_funnel_status') {
      return JSON.stringify({
        project: project.name,
        window_days: days,
        // null means NOT RECORDED. The bot must say so rather than reading it as zero.
        opt_ins: c.optIns,
        attended: c.attended,
        appointments: c.appointments,
        signups: c.signups,
        show_up_rate_pct: pct(c.showUpRate),
        attendee_to_signup_pct: pct(c.convRate),
        course_price: c.coursePrice,
        cash_collected: r2(c.cashCollected),
        revenue_basis: c.revenueBasis,
        cost_per_acquisition: r2(c.cpa),
        roas: r2(c.roas),
        ad_spend: r2(c.spend),
        unrecorded_note: 'any field that is null is NOT being recorded yet — say "not tracked", never zero',
      })
    }

    if (name === 'leads_today') {
      if (!c.sheet) return JSON.stringify({ project: project.name, status: 'no leads sheet connected for this project' })
      if (!c.sheet.ok) return JSON.stringify({ project: project.name, status: 'sheet unreadable', error: c.sheet.error })
      const s = c.sheet
      return JSON.stringify({
        project: project.name,
        opt_ins_yesterday: s.yesterday,
        opt_ins_today: s.today,
        opt_ins_last_7_days: s.last7,
        opt_ins_total: s.total,
        paid: s.signups,
        revenue: s.revenue,
        attendance_tracked: s.hasAttendedColumn,
        top_ads: s.byAd.slice(0, 5),
        recent_payers: s.recentPayers.slice(0, 5),
        waiting_for_follow_up: s.followUps.length,
        chase_first: s.followUps.slice(0, 5),
      })
    }

    return JSON.stringify({ error: `unknown ads tool ${name}` })
  } catch (e) {
    // Never throw into the chat loop — a broken tool should degrade to a
    // sentence, not a silent non-answer.
    return JSON.stringify({ error: (e as Error).message })
  }
}
