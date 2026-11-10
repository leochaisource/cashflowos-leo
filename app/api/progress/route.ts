import { supabase, supabaseConfigured } from '@/lib/supabase'
import { claudeClient } from '@/lib/claude-usage'
import { ingestSummaries } from '@/lib/progress-sort'
import { beat } from '@/lib/heartbeat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// CLIENT PROGRESS FROM CODE SESSIONS (owner, 2026-11-10). The laptop's
// scripts/progress-sync.ts posts the last week of claude-mem session summaries
// here every half hour; lib/progress-sort.ts sorts the new ones to clients,
// logs what got done and adds the to-dos. Re-sends cost nothing (the ledger
// skips what's sorted), so the laptop can be off for days.
//
//   POST /api/progress             body { items: [...], health: { captureBroken, newestAt } }
//   POST /api/progress?dry=1       sort, write nothing (no ledger claim either)
//   POST /api/progress?flush=1     don't wait for a session to go quiet for an hour
//
// Needs `Authorization: Bearer <PROGRESS_SECRET>`. FAILS CLOSED.

function authed(req: Request): boolean {
  const secret = process.env.PROGRESS_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  if (!supabaseConfigured) return Response.json({ ok: false, error: 'not configured' })
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return Response.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' })
  const params = new URL(req.url).searchParams
  const dry = params.get('dry') === '1'
  const body = (await req.json().catch(() => ({}))) as {
    items?: unknown
    health?: { captureBroken?: boolean; newestAt?: string | null }
  }

  const result = await ingestSummaries({
    db: supabase,
    anthropic: claudeClient('progress-sort', { apiKey }),
    items: body.items,
    dry,
    flush: params.get('flush') === '1',
    todosFromDays: Number(params.get('todosFromDays')) || undefined,
    // A dry run may try a cheaper model on the same sessions (comparing before switching).
    model: dry && ['claude-haiku-5-5', 'claude-sonnet-5-5'].includes(params.get('model') ?? '') ? params.get('model')! : undefined,
  }).catch((e) => ({ ok: false, error: (e as Error).message }))

  if (!dry) {
    // The 9am Today message reads both: when the laptop last reported, and
    // whether claude-mem is still writing summaries.
    await beat(supabase, 'progress-sync', !!result.ok, result.ok ? undefined : (result as { error?: string }).error)
    const health = {
      at: new Date().toISOString(),
      captureBroken: !!body.health?.captureBroken,
      newestAt: typeof body.health?.newestAt === 'string' ? body.health.newestAt : null,
    }
    await supabase.storage
      .from('cfo-cache')
      .upload('progress/laptop.json', JSON.stringify(health), { upsert: true, contentType: 'application/json' })
      .catch(() => {})
  }
  return Response.json(result)
}
