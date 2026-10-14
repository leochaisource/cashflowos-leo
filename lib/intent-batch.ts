import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdClient } from './ad-clients.ts'
import { meterBatchResult } from './claude-usage.ts'
import { eventFor } from './deal.ts'
import { buildFollowups, intentBatchRequests, intentVerdicts } from './followups.ts'
import { dayBounds } from './ghl.ts'
import { loadIntentCache, saveIntentCache, type CachedVerdict } from './intent-cache.ts'

// THE OVERNIGHT HALF-PRICE JUDGE (owner, 2026-10-15).
//
// The 8am run judges YESTERDAY's chats, and yesterday is finished at midnight.
// So between midnight and 7am the sheet's hourly trigger (apps-script/
// hot-leads.gs → /api/intent-batch) sends the chats the verdict cache can't
// answer to the Batch API, which charges half price and answers within hours.
// The next hourly call files the answers in the same verdict cache, keyed by
// exactly what the model read (lib/intent-cache.ts). At 8am buildFollowups()
// finds them and judges live only what's still missing — same model, same
// prompt, same labels. A batch still running at 8am is cancelled (unprocessed
// requests aren't billed) and those chats are judged live as before.
//
// State per project: cfo-cache `intent/<project>-batch.json`.

const BUCKET = 'cfo-cache'
const TZ = 'Asia/Kuala_Lumpur'
export const BATCH_FEATURE = 'intent-judge-batch'

type BatchState = {
  /** The report day whose chats were sent. */
  day: string
  batchId: string | null
  submittedAt: string
  /** custom_id → the chats in that request, with their verdict-cache keys. */
  groups: Record<string, { id: string; key: string }[]>
  status: 'submitted' | 'collected' | 'cancelled' | 'empty'
  doneAt?: string
  filed?: number
  missing?: number
}

const statePath = (project: string) => `intent/${project}-batch.json`

async function loadState(db: SupabaseClient, project: string): Promise<BatchState | null> {
  const { data, error } = await db.storage.from(BUCKET).download(statePath(project))
  if (error || !data) return null
  try {
    return JSON.parse(await data.text()) as BatchState
  } catch {
    return null
  }
}

async function saveState(db: SupabaseClient, project: string, s: BatchState): Promise<void> {
  const { error } = await db.storage
    .from(BUCKET)
    .upload(statePath(project), JSON.stringify(s), { upsert: true, contentType: 'application/json' })
  if (error) throw new Error(`batch state not saved: ${error.message}`)
}

/** The product line the judge reads — part of every verdict's cache key, so all callers share it. */
export function intentProduct(client: AdClient, nextTo: string): string {
  const d = client.deal!
  return `${client.client ?? client.name} one-day Claude AI workshop on ${nextTo}, tickets RM${d.ticketPrices.general} General / RM${d.ticketPrices.vip} VIP`
}

/** buildFollowups() arguments for the 8am run's report day (no model client). Null without an upcoming event. */
export function followupsArgs(client: AdClient, day: string) {
  const g = client.ghl
  if (!g?.followups || !client.deal) return null
  const tz = g.timeZone ?? TZ
  const next = eventFor(client.deal, new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10))
  if (!next) return null
  const { start, end } = dayBounds(day, tz)
  return {
    locationId: process.env[g.locationEnv]!.trim(),
    token: process.env[g.tokenEnv]!.trim(),
    day,
    dayStartISO: start,
    dayEndISO: end,
    salesSinceISO: dayBounds(next.from, tz).start,
    includeSources: g.includeOrderSources ?? [],
    product: intentProduct(client, next.to),
    notLeads: g.notLeads,
    cacheKey: client.id,
  }
}

/** Yesterday in KL — the day the next 8am run reports on. */
export function klYesterday(now = new Date()): string {
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ })
  return new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10)
}

export const klHour = (now = new Date()) => Number(now.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }))

export type BatchStep = { ok: boolean; action: string; day?: string; chats?: number; requests?: number; filed?: number; missing?: number; error?: string }

/** Send `day`'s not-yet-judged chats to the Batch API, once per day. */
export async function submitIntentBatch(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  day: string
  dryRun?: boolean
}): Promise<BatchStep> {
  const { client, db, day } = args
  const prev = await loadState(db, client.id)
  if (prev?.day === day) return { ok: true, action: `already ${prev.status} for ${day}`, day }
  const fa = followupsArgs(client, day)
  if (!fa) return { ok: true, action: 'no event to judge for', day }
  const f = await buildFollowups({ ...fa, anthropic: null, db, planOnly: true })
  const pending = f.pending ?? []
  const keyOf = new Map(pending.map((p) => [p.id, p.key]))
  const reqs = intentBatchRequests(fa.product, pending)
  const step = { ok: true, day, chats: pending.length, requests: reqs.length }
  if (args.dryRun) return { ...step, action: 'dry run: nothing sent' }
  const state: BatchState = {
    day,
    batchId: null,
    submittedAt: new Date().toISOString(),
    groups: Object.fromEntries(reqs.map((r) => [r.custom_id, r.ids.map((id) => ({ id, key: keyOf.get(id)! }))])),
    status: 'empty',
  }
  if (reqs.length) {
    const batch = await args.anthropic.messages.batches.create({
      requests: reqs.map((r) => ({ custom_id: r.custom_id, params: r.params })),
    } as unknown as Anthropic.Messages.BatchCreateParams)
    state.batchId = batch.id
    state.status = 'submitted'
  }
  await saveState(db, client.id, state)
  return { ...step, action: reqs.length ? 'submitted' : 'nothing to judge' }
}

/**
 * File a finished batch's verdicts in the verdict cache. Still running:
 * left alone, or cancelled when `cancelIfRunning` (the 8am run can't wait).
 */
export async function collectIntentBatch(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  cancelIfRunning?: boolean
}): Promise<BatchStep> {
  const { client, db, anthropic } = args
  const state = await loadState(db, client.id)
  if (!state || state.status !== 'submitted' || !state.batchId) return { ok: true, action: state ? `nothing to collect (${state.status})` : 'no batch yet', day: state?.day }
  const batch = await anthropic.messages.batches.retrieve(state.batchId)
  if (batch.processing_status !== 'ended') {
    if (!args.cancelIfRunning) return { ok: true, action: `still ${batch.processing_status}`, day: state.day }
    await anthropic.messages.batches.cancel(state.batchId)
    await saveState(db, client.id, { ...state, status: 'cancelled', doneAt: new Date().toISOString() })
    return { ok: true, action: 'cancelled: not finished in time, judged live instead', day: state.day }
  }
  const cache = await loadIntentCache(db, client.id)
  const now = new Date().toISOString()
  let filed = 0
  let missing = 0
  for await (const r of await anthropic.messages.batches.results(state.batchId)) {
    const group = state.groups[r.custom_id] ?? []
    if (r.result.type !== 'succeeded') {
      missing += group.length
      continue
    }
    const msg = r.result.message
    await meterBatchResult(BATCH_FEATURE, msg.model, msg.usage).catch(() => {})
    let verdicts: ReturnType<typeof intentVerdicts> = new Map()
    if (msg.stop_reason !== 'refusal')
      try {
        verdicts = intentVerdicts(msg as unknown as Parameters<typeof intentVerdicts>[0])
      } catch {
        // Not JSON — those chats are judged live at 8am.
      }
    for (const { id, key } of group) {
      const v = verdicts.get(id)
      if (!v) {
        missing++
        continue
      }
      cache.set(key, { v: v as CachedVerdict, at: now }) // the schema allows no 'unknown'
      filed++
    }
  }
  await saveIntentCache(db, client.id, cache)
  await saveState(db, client.id, { ...state, status: 'collected', doneAt: now, filed, missing })
  return { ok: true, action: 'collected', day: state.day, filed, missing }
}
