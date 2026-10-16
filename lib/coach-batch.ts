import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdClient } from './ad-clients.ts'
import { jsonFrom, jsonRequest, type ClaudeJsonArgs } from './claude-json.ts'
import { meterBatchResult } from './claude-usage.ts'
import { COACH_MODEL, type CoachReport } from './closer-coach.ts'

// ARIELLA'S 9AM COACH, WRITTEN OVERNIGHT AT HALF PRICE (owner, 2026-10-16).
//
// The coach reviews YESTERDAY's chats, which are complete at midnight. So the
// sheet's hourly trigger (/api/intent-batch) sends its request to the Batch API
// after midnight, alongside the lead judging, and files the answer here. At 9am
// runCloserCoach() uses the filed report — numbers, list and "close today"
// picks are still taken at 9am — and only asks the model live when there is no
// report for the day (a batch still running at 9am is cancelled).
//
// State per project: cfo-cache `coach/<project>-batch.json`.

const BUCKET = 'cfo-cache'
export const COACH_BATCH_FEATURE = 'closer-coach-batch'

type CoachBatchState = {
  /** The day reviewed (yesterday when sent). */
  day: string
  batchId: string | null
  submittedAt: string
  status: 'submitted' | 'collected' | 'cancelled' | 'failed' | 'empty'
  doneAt?: string
  report?: CoachReport
  error?: string
}

const statePath = (project: string) => `coach/${project}-batch.json`

async function loadState(db: SupabaseClient, project: string): Promise<CoachBatchState | null> {
  const { data, error } = await db.storage.from(BUCKET).download(statePath(project))
  if (error || !data) return null
  try {
    return JSON.parse(await data.text()) as CoachBatchState
  } catch {
    return null
  }
}

async function saveState(db: SupabaseClient, project: string, s: CoachBatchState): Promise<void> {
  const { error } = await db.storage
    .from(BUCKET)
    .upload(statePath(project), JSON.stringify(s), { upsert: true, contentType: 'application/json' })
  if (error) throw new Error(`coach batch state not saved: ${error.message}`)
}

export type CoachBatchStep = { ok: boolean; action: string; day?: string; error?: string }

/** The day already has a batch (any outcome) — don't send another. */
export async function coachBatchSent(db: SupabaseClient, client: AdClient, day: string): Promise<boolean> {
  return (await loadState(db, client.id))?.day === day
}

/** Send one day's coaching request to the Batch API. `request` null = nobody wrote that day. */
export async function submitCoachRequest(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  day: string
  request: Omit<ClaudeJsonArgs, 'model' | 'fallbackModel'> | null
}): Promise<CoachBatchStep> {
  const { client, db, day, request } = args
  const state: CoachBatchState = { day, batchId: null, submittedAt: new Date().toISOString(), status: 'empty' }
  if (request) {
    const batch = await args.anthropic.messages.batches.create({
      requests: [{ custom_id: 'coach', params: jsonRequest(request, COACH_MODEL) }],
    } as unknown as Anthropic.Messages.BatchCreateParams)
    state.batchId = batch.id
    state.status = 'submitted'
  }
  await saveState(db, client.id, state)
  return { ok: true, action: request ? 'coach submitted' : 'coach: no conversations', day }
}

/** File a finished coaching batch. Still running: left alone, or cancelled when `cancelIfRunning`. */
export async function collectCoachBatch(args: {
  client: AdClient
  anthropic: Anthropic
  db: SupabaseClient
  cancelIfRunning?: boolean
}): Promise<CoachBatchStep> {
  const { client, db, anthropic } = args
  const state = await loadState(db, client.id)
  if (!state || state.status !== 'submitted' || !state.batchId)
    return { ok: true, action: state ? `coach: nothing to collect (${state.status})` : 'coach: no batch yet', day: state?.day }
  const batch = await anthropic.messages.batches.retrieve(state.batchId)
  if (batch.processing_status !== 'ended') {
    if (!args.cancelIfRunning) return { ok: true, action: `coach still ${batch.processing_status}`, day: state.day }
    await anthropic.messages.batches.cancel(state.batchId)
    await saveState(db, client.id, { ...state, status: 'cancelled', doneAt: new Date().toISOString() })
    return { ok: true, action: 'coach cancelled: not finished in time, written live instead', day: state.day }
  }
  const done: CoachBatchState = { ...state, status: 'failed', doneAt: new Date().toISOString() }
  for await (const r of await anthropic.messages.batches.results(state.batchId)) {
    if (r.custom_id !== 'coach') continue
    if (r.result.type !== 'succeeded') {
      done.error = r.result.type
      continue
    }
    const msg = r.result.message
    await meterBatchResult(COACH_BATCH_FEATURE, msg.model, msg.usage).catch(() => {})
    if (msg.stop_reason === 'refusal') {
      done.error = 'the model declined'
      continue
    }
    try {
      done.report = jsonFrom<CoachReport>(msg as unknown as Parameters<typeof jsonFrom>[0])
      done.status = 'collected'
    } catch (e) {
      done.error = (e as Error).message
    }
  }
  await saveState(db, client.id, done)
  return { ok: true, action: `coach ${done.status}${done.error ? ` (${done.error})` : ''}`, day: state.day }
}

/** The overnight report for `day`, collecting (or cancelling) the batch first. Null = write it live. */
export async function takeBatchedCoach(args: { client: AdClient; anthropic: Anthropic; db: SupabaseClient; day: string }): Promise<CoachReport | null> {
  await collectCoachBatch({ ...args, cancelIfRunning: true })
  const state = await loadState(args.db, args.client.id)
  return state?.day === args.day && state.status === 'collected' && state.report ? state.report : null
}
