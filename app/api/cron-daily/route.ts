import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'
import { claimScheduledRun } from '@/lib/cron-claim'
import { getRecords, rm, todayISO, type Rec } from '@/lib/records'
import { propose, proposeAndNotify, runAutopilot } from '@/lib/actions'
import { AGENTS, SCHEDULED, type ProposalDraft } from '@/agents/registry'
import { activeProjects, focusProjects } from '@/lib/settings'
import { workProjectsFrom, urgentStepLines } from '@/lib/work-projects'
import { syncProjectAds } from '@/lib/ad-sync'
import { logRun } from '@/lib/runs'
import { runWatchdog, watchdogCrashed, watchdogSection, weekSummary, saveWatchdog, type WatchdogReport } from '@/lib/watchdog'

// 🔒 Don't edit — this keeps your robot safe.
// THE ONE daily cron (Vercel Hobby allows 2; the other is the 8am ads brief).
// It runs four things in order, once a day:
//   ⓪ the WATCHDOG (lib/watchdog.ts, owner 2026-11-10): did the unattended jobs run
//      and do their numbers add up? It retries what is safe to repeat, and its
//      findings go to the OWNER ONLY, inside this message, only when something is
//      wrong (plus a "still alive" line on Mondays),
//   ① tidy: proposals nobody answered in time are marked 'expired', so every
//      "waiting on your YES" count (this brief, Home, Approvals) is the same, true number,
//   ② the 9am brief — ONLY WHEN SOMETHING NEEDS THE OWNER, and only that thing:
//      steps overdue or due today/tomorrow, live approvals, invoices that went
//      overdue since yesterday. Nothing needs him → no message. (Owner's call,
//      2026-09-26: the old brief — funnel river, all-time money totals and a
//      narrative paragraph every morning — was noise he had stopped reading.
//      Those numbers still live on the Agency page.)
//   ③ a sweep of every 'daily' scheduled agent — each only CREATES proposals
//      (still passes through the ASK zone; nothing executes here).
//
// AUTH FAILS CLOSED: this endpoint creates proposals, so with no CRON_SECRET set
// it returns 401 to everyone. Vercel Cron sends the Bearer token automatically
// once you set the same value in your Vercel env.

export const dynamic = 'force-dynamic'
// 300, not 60: on Sundays the LinkedIn Ideas check runs a web-searching research call
// (agents/linkedin/research.ts) before pitching angles. Other days finish in seconds.
export const maxDuration = 300

// Who receives the brief: your team's numeric Telegram ids (comma-separated), or
// OWNER_CHAT_ID as the solo fallback. None set = nobody (the brief just no-ops).
function recipients(): string[] {
  const team = (process.env.TELEGRAM_TEAM_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s))
  const list = team.length
    ? team
    : ([process.env.OWNER_CHAT_ID?.trim()].filter(Boolean) as string[])
  return Array.from(new Set(list))
}

const PAID = new Set(['paid', 'done', 'closed', 'reversed'])
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const LABEL = new Map(AGENTS.map((a) => [a.key, a.label]))

export async function GET(req: Request) {
  // ---- FAIL-CLOSED Bearer. Unset secret ⇒ 401 (never open). ----
  const secret = process.env.CRON_SECRET?.trim()
  const authed = !!secret && req.headers.get('authorization') === `Bearer ${secret}`
  if (!authed) return new Response('forbidden', { status: 401 })

  // A second delivery of this morning's scheduled run: the brief already went out.
  if (!(await claimScheduledRun(req, 'cron-daily'))) return Response.json({ ok: true, duplicate: true })

  const today = todayISO()
  const yesterday = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10)
  const rows = await getRecords()
  const now = new Date().toISOString()

  // ① TIDY. The approve path already refuses an expired proposal (the claim
  // requires expires_at > now), so a 'proposed' row past its window is dead —
  // yet it kept counting as "waiting on your YES" (49 of them on 2026-09-26).
  let expired = 0
  if (supabaseConfigured) {
    const { data } = await supabase
      .from('agent_actions')
      .update({ status: 'expired' })
      .eq('status', 'proposed')
      .lt('expires_at', now)
      .select('id')
    expired = data?.length ?? 0
  }

  // ② WHAT NEEDS YOU — live proposals only.
  let proposed: { agent_key: string; payload: any }[] = []
  if (supabaseConfigured) {
    const { data } = await supabase
      .from('agent_actions')
      .select('agent_key, payload')
      .eq('status', 'proposed')
      .gt('expires_at', now)
      .order('proposed_at', { ascending: false })
    proposed = (data ?? []) as any[]
  }

  // Steps overdue or due today/tomorrow, across ad clients and work projects.
  const ads = await activeProjects()
  const urgent = urgentStepLines(
    rows,
    [
      ...ads.map((p) => ({ id: p.id, name: p.client ?? p.name })),
      ...workProjectsFrom(rows).map((w) => ({ id: w.slug, name: w.name })),
    ],
    today,
  )

  // Money: an invoice that went overdue since yesterday is news; the rest are context.
  const overdue = rows.filter(
    (r) => r.category === 'cash_in' && !PAID.has((r.status || '').toLowerCase()) && !!r.due_date && r.due_date < today,
  )
  const newlyOverdue = overdue.filter((r) => r.due_date === yesterday)

  // ⓪ THE WATCHDOG. Runs BEFORE the message so its findings ride in it, and
  // before the sweep so it sees what yesterday's sweep left (the LinkedIn step).
  // A 60s budget for retries: the sweep after it can need most of the 300s on a
  // Sunday. A crash here becomes one line, never a lost 9am message.
  const owner = process.env.OWNER_CHAT_ID?.trim()
  let wd: WatchdogReport | null = null
  let wdText: string | null = null
  if (supabaseConfigured) {
    try {
      wd = await runWatchdog({
        db: supabase,
        focus: await focusProjects(),
        deadline: Date.now() + 60_000,
        retry: {
          resync: (client) => syncProjectAds(client, 7),
          send: (chat, text) => sendMessage(chat, text, { noPreview: true }),
        },
      })
    } catch (e) {
      console.error('[CFO] watchdog crashed:', e)
      wd = watchdogCrashed(e)
    }
    const monday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1
    const quiet = !wd.problems.length && !wd.fixed.length
    const week = monday && quiet ? await weekSummary(supabase, wd.day).catch(() => null) : null
    wdText = watchdogSection(wd, { week })
  }

  const needsYou = urgent.length > 0 || proposed.length > 0 || newlyOverdue.length > 0
  const to = recipients()
  let sent = 0
  let wdSent: boolean | null = wdText ? false : null
  const brief = needsYou ? buildBrief(urgent, proposed, newlyOverdue, overdue) : null
  // The watchdog goes to the OWNER only: the team list may include people who
  // shouldn't read about other clients' faults. Under Telegram's limit it shares
  // the owner's message; otherwise it follows as its own.
  const together = !!brief && !!wdText && brief.length + wdText.length < 3800
  const sends = await Promise.allSettled(
    to.map(async (id) => {
      const isOwner = id === owner
      const first = isOwner && together ? `${brief}\n\n${wdText}` : brief
      const r = first ? await sendMessage(id, first) : null
      if (isOwner && wdText && !together) {
        const w = await sendMessage(id, wdText, { noPreview: true })
        wdSent = w.ok
      } else if (isOwner && wdText) wdSent = !!r?.ok
      return r
    }),
  )
  // sendMessage reports failure in its value; a fulfilled promise is not a delivery.
  sent = sends.filter((r) => r.status === 'fulfilled' && r.value?.ok).length
  if (wdText && owner && !to.includes(owner)) wdSent = (await sendMessage(owner, wdText, { noPreview: true })).ok
  // The record of this morning: the 8am dead-man check and Monday's line read it.
  if (wd) await saveWatchdog(supabase, wd, { delivered: wdSent })

  // ③ SWEEP the scheduled agents — CREATE proposals only (they pass through ASK).
  let created = 0
  const crashed: { label: string; error: string }[] = []
  for (const agent of SCHEDULED) {
    let drafts: ProposalDraft[] = []
    try {
      // `await` because a check may READ before it proposes (the Head of Marketing
      // reads `ad_daily`). A sync check awaits harmlessly. Still create-only —
      // nothing here executes.
      drafts = await agent.check(rows, today)
    } catch (e) {
      console.error(`[CFO] scheduled check "${agent.key}" threw:`, e)
      // Used to vanish into the logs. Now the owner hears it (below) and it's audited.
      const error = (e as Error)?.message ?? String(e)
      crashed.push({ label: agent.label, error })
      await logRun(agent.key, 'failed', { where: 'cron-daily sweep', error })
      continue
    }
    for (const d of drafts) {
      // 🟢 GRADUATED (auto) — the owner has taught this one; run it once, then tell
      // them. Still the same claim-check funnel, still undoable, still audited.
      if (d.auto) {
        const done = await runAutopilot(agent.key, d.payload)
        if (done) {
          created++
          if (owner) {
            await sendMessage(
              owner,
              `🟢 <b>${agent.label}</b> handled this for you: ${d.text}\n` +
                `Reply <code>/undo-${done.row.id}</code> within 24h to reverse.`,
            )
          }
        }
        continue
      }
      // 🟡 ASK-FIRST (the default) — create the proposal and surface the buttons.
      // With an owner we send the buttons to them; otherwise just record the
      // proposal (it still shows on the Approvals tab). Either way: create, not run.
      const row = owner
        ? await proposeAndNotify({
            agentKey: agent.key,
            idempotencyKey: d.idempotencyKey,
            payload: d.payload,
            chatId: owner,
            text: d.text,
          })
        : await propose({ agentKey: agent.key, idempotencyKey: d.idempotencyKey, payload: d.payload })
      if (row) created++
    }
  }

  // A scheduled agent that crashed: one short line to the owner, in words.
  // Nothing is retried today; tomorrow's run is the retry.
  if (crashed.length && owner) {
    const lines = crashed.map((c) => `• ${esc(c.label)}: ${esc(c.error.slice(0, 160))}`).join('\n')
    await sendMessage(owner, `⚠️ <b>9am run</b>: ${crashed.length === 1 ? 'one job' : `${crashed.length} jobs`} crashed and did nothing today.\n${lines}\nThey run again tomorrow morning. Ask Claude if this repeats.`)
  }

  return Response.json({
    ok: true,
    sent,
    recipients: to.length,
    watchdog: wd ? { problems: wd.problems.length, fixed: wd.fixed.length, delivered: wdSent, checks: wd.checks } : null,
    sweep_crashed: crashed.map((c) => c.label),
    skipped: needsYou ? null : 'nothing needs you today — no brief sent',
    needs_yes: proposed.length,
    urgent_steps: urgent.length,
    newly_overdue_invoices: newlyOverdue.length,
    expired_proposals: expired,
    proposals_created: created,
  })
}

// The 9am brief: only the sections that have something in them. Deterministic —
// no model, no API key, nothing to go missing.
function buildBrief(urgent: string[], proposed: { agent_key: string; payload: any }[], newlyOverdue: Rec[], overdue: Rec[]): string {
  const parts: string[] = ['☀️ <b>What needs you today</b>']

  if (urgent.length) {
    const shown = urgent.slice(0, 8)
    parts.push(
      '<b>Due</b>\n' +
        shown.map((l) => `• ${esc(l).replace(/OVERDUE by (\d+)d/g, '<b>OVERDUE by $1d</b>')}`).join('\n') +
        (urgent.length > shown.length ? `\n…and ${urgent.length - shown.length} more` : ''),
    )
  }

  if (proposed.length) {
    const list = proposed
      .slice(0, 5)
      .map((a) => {
        const pl = a.payload || {}
        const what =
          typeof pl.amount === 'number'
            ? `${rm(pl.amount)}${pl.merchant ? ` · ${pl.merchant}` : ''}`
            : pl.ad_name
              ? String(pl.ad_name)
              : pl.text
                ? String(pl.text)
                : ''
        return `• ${esc(LABEL.get(a.agent_key) ?? a.agent_key)}${what ? `: ${esc(what.slice(0, 60))}` : ''}`
      })
      .join('\n')
    parts.push(
      `<b>Waiting on your YES</b> · ${proposed.length}\n${list}` +
        (proposed.length > 5 ? `\n…and ${proposed.length - 5} more on the Approvals page` : ''),
    )
  }

  if (newlyOverdue.length) {
    const total = overdue.reduce((s, r) => s + Number(r.amount || 0), 0)
    parts.push(
      '<b>Money</b>\n' +
        newlyOverdue.map((r) => `• Went overdue yesterday: ${esc(r.title)} (${rm(Number(r.amount || 0))})`).join('\n') +
        `\n• ${overdue.length} invoice${overdue.length === 1 ? '' : 's'} overdue in total · ${rm(total)} owed`,
    )
  }

  return parts.join('\n\n')
}
