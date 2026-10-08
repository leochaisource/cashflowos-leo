import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extension: shared with scripts/linkedin-ideas-dry-run.ts (Node type stripping).
import { LOOKBACK_DAYS, type FailedPost } from './definition.ts'

// The LinkedIn Ideas agent's data mouth. Takes the db client as an argument
// (no `server-only`), so the cron and the dry-run script read the SAME rows.
//
// It gathers the raw material of the week (what the morning briefs said, what the
// agents recommended and Leo decided, what competitors started saying, how the
// events are selling) as plain text for prompt.ts. Client numbers are included on
// purpose, as the SOURCE of an angle; prompt.ts flags any angle built on them so
// the skill anonymises it before anything is written for the public.
//
// NULL ≠ 0, same rule as lib/metrics.ts: a section that couldn't be read says
// "unavailable", never "nothing happened".

const sinceISO = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export type WeekFacts = { text: string; sections: number; unavailable: string[] }

export async function loadWeekFacts(db: SupabaseClient, now: Date): Promise<WeekFacts> {
  const since = sinceISO(now, LOOKBACK_DAYS)
  const sinceDay = since.slice(0, 10)
  const parts: string[] = []
  const unavailable: string[] = []

  // ① What the 8am ads briefs said (operator analysis, not the client-facing block).
  {
    const { data, error } = await db
      .from('brief_daily')
      .select('project, date, report_text, purchases_total, spend_total, cost_per_sale')
      .gte('date', sinceDay)
      .order('date', { ascending: false })
      .limit(21)
    if (error) unavailable.push(`morning briefs (${error.message})`)
    else if (data?.length) {
      parts.push(
        'MORNING ADS BRIEFS THIS WEEK (client accounts, operator notes):\n' +
          data
            .map(
              (r: any) =>
                `- ${r.date} [${r.project}] seats sold so far ${r.purchases_total ?? '?'}, spend so far RM${Math.round(Number(r.spend_total ?? 0))}` +
                `${r.cost_per_sale != null ? `, cost per sale RM${Math.round(Number(r.cost_per_sale))}` : ''}. ${clip(r.report_text, 600)}`,
            )
            .join('\n'),
      )
    }
  }

  // ② Event sales vs target (the house reports).
  {
    const { data, error } = await db
      .from('house_reports')
      .select('project, event_date, report_date, paid, target, ads_confirmed, organic_confirmed')
      .gte('report_date', sinceDay)
      .order('report_date', { ascending: false })
      .limit(6)
    if (error) unavailable.push(`event sales (${error.message})`)
    else if (data?.length) {
      parts.push(
        'EVENT SALES VS TARGET:\n' +
          data
            .map(
              (r: any) =>
                `- [${r.project}] event ${r.event_date}, as of ${r.report_date}: ${r.paid ?? '?'} paid of ${r.target ?? '?'} target ` +
                `(ads ${r.ads_confirmed ?? '?'}, organic ${r.organic_confirmed ?? '?'})`,
            )
            .join('\n'),
      )
    }
  }

  // ③ What the AI agents recommended this week, and what Leo decided.
  {
    const { data, error } = await db
      .from('agent_actions')
      .select('agent_key, status, payload, decided_at')
      .gte('decided_at', since)
      .in('status', ['executed', 'rejected'])
      .not('agent_key', 'in', '("linkedin-ideas","job_apply","inbox-digest")')
      .order('decided_at', { ascending: false })
      .limit(20)
    if (error) unavailable.push(`agent decisions (${error.message})`)
    else if (data?.length) {
      parts.push(
        "AI AGENT RECOMMENDATIONS LEO DECIDED ON (his own CashFlowOS system — build-in-public material):\n" +
          data
            .map((r: any) => `- ${r.agent_key}: ${r.status === 'executed' ? 'APPROVED' : 'rejected'} — ${clip(r.payload?.text ?? r.payload?.title ?? r.payload?.note, 220)}`)
            .join('\n'),
      )
    }
  }

  // ④ How busy the robots were (counts only).
  {
    const { data, error } = await db.from('agent_runs').select('agent_key').gte('started_at', since).limit(2000)
    if (error) unavailable.push(`agent activity (${error.message})`)
    else if (data?.length) {
      const by = new Map<string, number>()
      for (const r of data as any[]) by.set(r.agent_key, (by.get(r.agent_key) ?? 0) + 1)
      parts.push(
        `AGENT RUNS THIS WEEK (${data.length} total): ` +
          [...by.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${k} ×${n}`)
            .join(', '),
      )
    }
  }

  // ⑤ Competitor positioning that is new this week.
  {
    const { data, error } = await db
      .from('competitor_profiles')
      .select('project, competitor, usp, offer, is_competitor')
      .gte('usp_updated_at', since)
      .not('usp', 'is', null)
      .limit(12)
    if (error) unavailable.push(`competitor research (${error.message})`)
    else {
      const rows = (data ?? []).filter((r: any) => r.is_competitor !== false).slice(0, 8)
      if (rows.length) {
        parts.push(
          'COMPETITOR ADS — NEW POSITIONING SEEN THIS WEEK (market observation; never name competitors in a post):\n' +
            rows.map((r: any) => `- [${r.project}] USP: ${clip(r.usp, 200)}${r.offer ? ` | offer: ${clip(r.offer, 120)}` : ''}`).join('\n'),
        )
      }
    }
  }

  if (unavailable.length) parts.push(`(Could not read: ${unavailable.join('; ')}.)`)
  return { text: parts.join('\n\n'), sections: parts.length - (unavailable.length ? 1 : 0), unavailable }
}

// GHL posts on Leo's LinkedIn that failed to publish in the last 3 days. Needs
// Leo's OWN sub-account env (the same three the laptop script uses). Unset → [].
export async function loadFailedPosts(now: Date): Promise<FailedPost[]> {
  const loc = process.env.GHL_LEO_LOCATION_ID?.trim()
  const token = process.env.GHL_LEO_TOKEN?.trim()
  const account = process.env.GHL_LEO_LINKEDIN_ACCOUNT_ID?.trim()
  if (!loc || !token || !account) return []
  const res = await fetch(`https://services.leadconnectorhq.com/social-media-posting/${loc}/posts/list`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: process.env.GHL_SOCIAL_API_VERSION?.trim() || '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'failed',
      accounts: account,
      skip: '0',
      limit: '10',
      fromDate: sinceISO(now, 3),
      toDate: now.toISOString(),
      includeUsers: 'false',
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GHL posts/list HTTP ${res.status}`)
  const body: any = await res.json().catch(() => ({}))
  const posts: any[] = body?.results?.posts ?? body?.posts ?? []
  return posts
    .filter((p) => p?._id)
    .map((p) => ({
      id: String(p._id),
      when: String(p.scheduleDate || p.updatedAt || '').slice(0, 16).replace('T', ' ') + ' UTC',
      firstLine: clip(String(p.summary ?? '').split('\n')[0], 120),
      error: clip(p.error ?? p.errorMessage ?? p.failedReason ?? '', 200),
    }))
}
