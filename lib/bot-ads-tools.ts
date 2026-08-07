import 'server-only'
import { PROJECTS, getProject, type Project } from './ad-clients'
import { scorecards, projectScorecard, WINNER_MIN_LEADS, LOSER_MIN_IMPRESSIONS } from './metrics'
import { syncProjectAds } from './ad-sync'

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
function resolve(q: string | undefined): { project?: Project; candidates?: Project[] } {
  if (!q || !q.trim()) {
    return PROJECTS.length === 1 ? { project: PROJECTS[0] } : { candidates: PROJECTS }
  }
  const needle = q.trim().toLowerCase()
  const exact = getProject(needle)
  if (exact) return { project: exact }
  const hits = PROJECTS.filter((p) =>
    [p.id, p.name, p.client ?? ''].some((s) => s.toLowerCase().includes(needle) || needle.includes(s.toLowerCase())),
  )
  if (hits.length === 1) return { project: hits[0] }
  return { candidates: hits.length ? hits : PROJECTS }
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

// ---------------------------------------------------------------- execution
export async function runBotAdsTool(name: string, input: any): Promise<string> {
  try {
    const days = Number.isFinite(Number(input?.days)) ? Math.min(Math.max(Number(input.days), 1), 90) : WINDOW

    if (name === 'list_projects') {
      const cards = await scorecards(PROJECTS, days)
      return JSON.stringify({
        window_days: days,
        projects: PROJECTS.map((p) => {
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

    const { project, candidates } = resolve(input?.project)
    if (!project) return ask(candidates ?? PROJECTS)

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
