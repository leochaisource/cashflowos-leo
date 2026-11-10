import { after } from 'next/server'
import { claudeClient } from '@/lib/claude-usage'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage } from '@/lib/telegram'
import { proposeAndNotify } from '@/lib/actions'
import { APP_URL } from '@/lib/brief-digest'
import { PROJECTS } from '@/lib/ad-clients'
import { AGENTS } from '@/agents/registry'
import { libraryStep, stepFor, type LibraryStep } from '@/agents/ai-library/run'
import { FOCUSES, type Focus } from '@/agents/ai-library/research'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // one web-searching research call (~1-3 min) + plain page checks

// THE AI LIBRARY's own request (agents/ai-library/run.ts): research Tue–Fri,
// 3 ideas on Saturday (Sunday catch-up). Started each morning by the 9am cron's
// sweep (agents/registry.ts → aiLibraryCheck), so it gets its own 300 seconds.
//
//   POST /api/ai-library                       today's step; answers 202 at once
//   ...?wait=1                                 runs it and answers with the result
//   ...?step=research&focus=malaysia-sea       a chosen step / focus
//   ...?dry=1                                  saves nothing, sends nothing; returns the preview
//   ...?to=none                                saves, but sends nothing
//   ...?force=1                                run again even though today's / this week's ran
//
// Needs `Authorization: Bearer <CRON_SECRET>`. FAILS CLOSED. Cards go to the owner only.

function authed(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

/** Facts read live, so the ideas don't rely only on the written setup in stack.ts. */
function liveFacts(): string[] {
  const focus = PROJECTS.filter((p) => p.rank).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  return [
    `Ad clients on the focus list: ${focus.map((p) => `${p.rank}. ${p.name}`).join('; ') || 'none'}`,
    `Other ad clients: ${PROJECTS.filter((p) => !p.rank).map((p) => p.name).join('; ') || 'none'}`,
    `AI Employees tab: ${AGENTS.map((a) => a.label).join(', ')}`,
  ]
}

async function run(q: URLSearchParams) {
  if (!supabaseConfigured) return { ok: false, error: 'Supabase is not configured' }
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  const owner = process.env.OWNER_CHAT_ID?.trim()
  if (!key) {
    if (owner) await sendMessage(owner, '⚠️ <b>AI Library</b>: ANTHROPIC_API_KEY is missing on Vercel, so nothing ran today.').catch(() => {})
    return { ok: false, error: 'ANTHROPIC_API_KEY missing' }
  }
  const step = (['research', 'suggest'].includes(q.get('step') ?? '') ? q.get('step') : undefined) as LibraryStep | undefined
  const focus = (q.get('focus') && q.get('focus')! in FOCUSES ? q.get('focus') : undefined) as Focus | undefined
  const dryRun = q.get('dry') === '1'
  const force = q.get('force') === '1'
  const which = step ?? stepFor(new Date())?.step
  const r = await libraryStep({
    db: supabase,
    // Its own meter label per step, so the daily spend alert says which one spent it.
    anthropic: claudeClient(which === 'suggest' ? 'ai-library-ideas' : 'ai-library-research', { apiKey: key, timeout: 240_000, maxRetries: 1 }),
    now: new Date(),
    step,
    focus,
    dryRun,
    force,
    liveFacts: liveFacts(),
    appUrl: APP_URL,
  })

  // Deliver: ideas as ✅/❌ cards (a ✅ puts the idea on Tasks), notes as plain messages.
  let sent = 0
  const failed: string[] = []
  if (!dryRun && q.get('to') !== 'none' && owner) {
    for (const c of r.cards) {
      if (c.kind === 'idea') {
        const row = await proposeAndNotify({
          agentKey: 'ai-library',
          // A forced re-run is a new card, not a silent duplicate of Saturday's.
          idempotencyKey: `ai-library:idea:${c.week}:${c.position}${force ? `:r${Date.now()}` : ''}`,
          payload: { kind: 'ai_idea', suggestion_id: c.suggestionId, week: c.week, title: c.title, first_step: c.firstStep },
          chatId: owner,
          text: c.text,
          // 23h, not a week: an open proposal is listed in the 9am "What needs you" brief
          // every morning, and an optional idea mustn't nag. It lapses before Sunday's brief.
          expiresInH: 23,
        })
        if (row) {
          sent++
          if (c.suggestionId) await supabase.from('ai_library_suggestions').update({ action_id: row.id, updated_at: new Date().toISOString() }).eq('id', c.suggestionId)
        } else failed.push(`idea ${c.position}`)
      } else {
        const s = await sendMessage(owner, c.text, { noPreview: true })
        if (s.ok) sent++
        else failed.push(c.key)
      }
    }
  }
  if (r.notes.length) console.log('[CFO] ai-library:', r.notes.join(' · '))
  return { ok: true, step: r.step, notes: r.notes, cards: r.cards.length, sent, failed, preview: dryRun ? { preview: r.preview, cards: r.cards } : undefined }
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response('forbidden', { status: 401 })
  const q = new URL(req.url).searchParams
  if (q.get('wait') === '1') return Response.json(await run(q))
  after(() =>
    run(q).catch(async (e) => {
      console.error('[CFO] ai-library failed:', e)
      const owner = process.env.OWNER_CHAT_ID?.trim()
      if (owner) await sendMessage(owner, `⚠️ <b>AI Library</b>: today's run stopped (${String((e as Error).message).slice(0, 160).replace(/</g, '&lt;')}).`).catch(() => {})
    }),
  )
  return Response.json({ ok: true, started: true }, { status: 202 })
}
