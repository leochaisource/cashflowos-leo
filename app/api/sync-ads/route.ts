import { AD_CLIENTS, isConfigured } from '@/lib/ad-clients'
import { activeProjects } from '@/lib/settings'
import { syncProjectAds } from '@/lib/ad-sync'

// Meta → `ad_daily`, and NOTHING else. No Adyntel credits, no model call, no
// Telegram message. That's the whole point: refreshing the dashboard should cost
// nothing, so it's safe to call as often as you like — unlike /api/cron-ads,
// which spends real credit every time it runs.
//
// AUTH FAILS CLOSED, same as the other crons: no CRON_SECRET set = 401 for
// everyone. It hits a third-party API on your account, so it is not open.
//
//   GET /api/sync-ads                      → every configured project
//   GET /api/sync-ads?client=dianna-nlp    → one project
//   GET /api/sync-ads?days=30              → a longer backfill (default 7)

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  const authed = !!secret && req.headers.get('authorization') === `Bearer ${secret}`
  if (!authed) return new Response('forbidden', { status: 401 })

  const url = new URL(req.url)
  const only = url.searchParams.get('client')
  // Clamped: a typo'd ?days=9999 would page through years of Meta data.
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90)

  const available = only ? AD_CLIENTS : await activeProjects()
  const queue = available.filter((c) => (only ? c.id === only : true))
  const results: unknown[] = []
  const skipped: string[] = []

  // Sequential: one project's failure must not take the others down, and Meta
  // rate-limits per token anyway.
  for (const client of queue) {
    if (!isConfigured(client)) {
      skipped.push(`${client.id} (missing ${client.adAccountEnv} or ${client.tokenEnv})`)
      continue
    }
    try {
      results.push(await syncProjectAds(client, days))
    } catch (e) {
      console.error(`[CFO] sync ${client.id} failed:`, e)
      results.push({ project: client.id, ok: false, error: (e as Error).message })
    }
  }

  return Response.json({ ok: true, days, projects: results.length, skipped, results })
}
