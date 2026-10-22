import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdClient } from './ad-clients.ts'
import { journeyFor } from './funnel-config.ts'
import { archiveCohort, klEnd, klStart, loadJourney, windowFor, type EventWindow } from './funnel-data.ts'
import type { JourneyRow } from './funnel-report.ts'
import { contactsWithTag, paymentAttempts, pipelineByName, pipelineCards, whatsappMessages } from './ghl.ts'

// THE LEAD JOURNEY, rebuilt each morning (owner, 2026-10-22). One row per lead
// of the event cohort, stamped with the first time each stage was seen:
//
//   opted in / ad / funnel   the archive of form submissions (ghl_leads)
//   replied                  their first inbound WhatsApp message after opting in
//   engaged, hot             the AI's intent tags, the buying-signal tags and
//                            the closer's list (a card = hot)
//   webinar                  the webinar attendance tags (dated ones carry the date)
//   called                   the closer's Call Log (call_log, sent hourly by the sheet)
//   checkout, paid           GHL payments: failed/pending attempts and successes;
//                            seats and revenue from the sales archive (ghl_sales)
//
// Tags carry no date, so a stage first seen through a tag is stamped with the
// morning it was first noticed — day-accurate from the day this runs, not
// before. Nothing here calls the AI: it reads what the day's jobs already wrote.

const API = 'https://services.leadconnectorhq.com'
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Every tag name in the location (to find the dated webinar-attendance tags). */
async function locationTags(locationId: string, token: string): Promise<string[]> {
  const res = await fetch(`${API}/locations/${encodeURIComponent(locationId)}/tags`, {
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`GHL ${res.status} on /locations/tags`)
  const j = (await res.json()) as { tags?: { name: string }[] }
  return [...new Set((j.tags ?? []).map((t) => t.name))]
}

/** "cmw-attended-13oct" → 13 Oct, 8pm KL (the webinar slot), in the window's year; undated → null. */
function webinarDate(tag: string, prefix: string, year: string): string | null {
  const m = tag.slice(prefix.length).match(/^-(\d{1,2})([a-z]{3})$/i)
  if (!m) return null
  const mon = MONTHS.indexOf(m[2].toLowerCase())
  if (mon < 0) return null
  return new Date(`${year}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T20:00:00+08:00`).toISOString()
}

const earlier = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b)
/** A stage can't come before the opt-in: floor a sighting at the opt-in time. */
const notBefore = (at: string, optin: string) => (at < optin ? optin : at)

export type JourneyRefresh = {
  ok: boolean
  event: string
  leads: number
  replied: number
  hot: number
  called: number
  paid: number
  warnings: string[]
  dryRun?: boolean
}

/**
 * Rebuild one cohort. `days` = the KL days whose WhatsApp messages to read for
 * replies (the nightly run passes yesterday; a backfill passes every day of the
 * window). Tags, the list, calls and payments are read as they stand now.
 */
export async function refreshJourney(args: {
  client: AdClient
  db: SupabaseClient
  /** A day inside the cohort's window — normally yesterday. */
  day: string
  days?: string[]
  now?: Date
  dryRun?: boolean
}): Promise<JourneyRefresh> {
  const { client, db } = args
  const cfg = journeyFor(client.id)
  const g = client.ghl
  const w: EventWindow | null = windowFor(client, args.day)
  if (!cfg || !g || !w) return { ok: false, event: '', leads: 0, replied: 0, hot: 0, called: 0, paid: 0, warnings: ['no journey for this client or day'] }
  const nowISO = (args.now ?? new Date()).toISOString()
  const until = nowISO < klEnd(w.to) ? nowISO : klEnd(w.to)
  // Tags carry no date and the AI's intent tags change daily, so for an event
  // that ended days ago a tag says nothing about THEN: only dated sources count.
  const live = Date.parse(until) >= Date.parse(nowISO) - 2 * 864e5
  const token = process.env[g.tokenEnv]!.trim()
  const loc = process.env[g.locationEnv]!.trim()
  const warnings: string[] = []

  // 1. The cohort, from the archive, merged into what earlier mornings recorded.
  const base = await archiveCohort(db, client, w.from, w.to, until)
  // A dry run works before supabase/funnel.sql exists; a real run needs the table.
  const priorRows = await loadJourney(db, client.id, w.date).catch((e) => {
    if (args.dryRun) return [] as JourneyRow[]
    throw e
  })
  const prior = new Map(priorRows.map((r) => [r.contact_id, r]))
  const rows = new Map<string, JourneyRow>()
  for (const b of base) {
    const p = prior.get(b.contact_id)
    rows.set(b.contact_id, {
      ...b,
      webinar_at: p?.webinar_at ?? null,
      replied_at: p?.replied_at ?? null,
      engaged_at: p?.engaged_at ?? null,
      hot_at: p?.hot_at ?? null,
      called_at: p?.called_at ?? null,
      picked_up: p?.picked_up ?? null,
      checkout_at: earlier(p?.checkout_at ?? null, b.checkout_at),
      attended_at: p?.attended_at ?? null,
      intent: p?.intent ?? null,
      list_stage: p?.list_stage ?? null,
    })
  }

  // 2. Replies: the first message from them after they opted in.
  for (const day of args.days ?? [args.day]) {
    try {
      const msgs = await whatsappMessages(loc, token, klStart(day), klEnd(day))
      for (const m of msgs) {
        if (m.direction !== 'inbound') continue
        const r = rows.get(m.contactId)
        if (r && m.dateAdded >= r.opted_in_at) r.replied_at = earlier(r.replied_at, m.dateAdded)
      }
    } catch (e) {
      warnings.push(`WhatsApp ${day}: ${(e as Error).message}`)
    }
  }

  // 3. Tags as they stand this morning.
  const seen = (r: JourneyRow, at: string = nowISO) => notBefore(at < until ? at : until, r.opted_in_at)
  const withTag = async (tag: string) => {
    try {
      return await contactsWithTag(loc, token, tag)
    } catch (e) {
      warnings.push(`tag ${tag}: ${(e as Error).message}`)
      return []
    }
  }
  for (const tag of live ? new Set([...cfg.engagedTags, ...cfg.hotTags]) : []) {
    for (const c of await withTag(tag)) {
      const r = rows.get(c.id)
      if (!r) continue
      if (cfg.engagedTags.includes(tag)) r.engaged_at = r.engaged_at ?? seen(r)
      if (cfg.hotTags.includes(tag)) r.hot_at = r.hot_at ?? seen(r)
      if (tag === 'intent-hot') r.intent = 'hot'
      else if (tag === 'intent-warm' && r.intent !== 'hot') r.intent = 'warm'
    }
  }
  for (const tag of live ? cfg.checkoutTags : [])
    for (const c of await withTag(tag)) {
      const r = rows.get(c.id)
      if (r) r.checkout_at = r.checkout_at ?? seen(r)
    }
  if (cfg.webinarTagPrefix) {
    try {
      const prefix = cfg.webinarTagPrefix
      const tags = (await locationTags(loc, token)).filter((t) => t.toLowerCase().startsWith(prefix))
      for (const tag of tags) {
        const dated = webinarDate(tag, prefix, w.date.slice(0, 4))
        if (dated && (dated < klStart(w.from) || dated > klEnd(w.to))) continue // another event's webinar
        if (!dated && !live) continue // the undated tag can't be placed in an old event
        for (const c of await withTag(tag)) {
          const r = rows.get(c.id)
          if (r && (!dated || dated >= r.opted_in_at)) r.webinar_at = earlier(r.webinar_at, dated ?? seen(r))
        }
      }
    } catch (e) {
      warnings.push(`webinar tags: ${(e as Error).message}`)
    }
  }
  for (const tag of live ? cfg.attendedTags : [])
    for (const c of await withTag(tag)) {
      const r = rows.get(c.id)
      if (r) r.attended_at = r.attended_at ?? seen(r)
    }

  // 4. The closer's list: a card means hot, from the day it was created.
  if (g.hotList) {
    try {
      const pipe = await pipelineByName(loc, token, g.hotList.pipeline)
      if (pipe) {
        const names = new Map(pipe.stages.map((s) => [s.id, s.name]))
        for (const card of await pipelineCards(loc, token, pipe.id)) {
          const r = rows.get(card.contactId)
          if (!r || card.createdAt > until) continue
          r.hot_at = earlier(r.hot_at, notBefore(card.createdAt, r.opted_in_at))
          r.list_stage = names.get(card.stageId) ?? r.list_stage
        }
      } else warnings.push(`pipeline "${g.hotList.pipeline}" not found`)
    } catch (e) {
      warnings.push(`hot list: ${(e as Error).message}`)
    }
  }

  // 5. Calls, from the Call Log the sheet sends every hour.
  try {
    const { data, error } = await db.from('call_log').select('contact_id, called_at, picked_up').eq('project', client.id)
    if (error) throw new Error(error.message)
    for (const c of data ?? []) {
      const r = c.contact_id ? rows.get(c.contact_id) : undefined
      if (!r || !c.called_at || c.called_at < r.opted_in_at || c.called_at > until) continue
      r.called_at = earlier(r.called_at, c.called_at)
      if (c.picked_up) r.picked_up = true
      else if (r.picked_up === null) r.picked_up = false
    }
  } catch (e) {
    warnings.push(`call log: ${(e as Error).message}`)
  }

  // 6. Payments, live from GHL: who started a checkout, who paid and when.
  try {
    const p = await paymentAttempts(loc, token, klStart(w.from), g.includeOrderSources ?? [], until)
    for (const u of p.unpaid) {
      const r = rows.get(u.contactId)
      if (r && u.at >= r.opted_in_at) r.checkout_at = earlier(r.checkout_at, u.at)
    }
    for (const [id, at] of p.paidAt) {
      const r = rows.get(id)
      if (!r || at < r.opted_in_at || at > until) continue
      r.paid_at = earlier(r.paid_at, at)
      r.checkout_at = earlier(r.checkout_at, at)
      r.seats = r.seats ?? 1 // the sales archive fills the real count next morning
    }
  } catch (e) {
    warnings.push(`payments: ${(e as Error).message}`)
  }

  const all = [...rows.values()]
  const out: JourneyRefresh = {
    ok: true,
    event: w.date,
    leads: all.length,
    replied: all.filter((r) => r.replied_at).length,
    hot: all.filter((r) => r.hot_at).length,
    called: all.filter((r) => r.called_at).length,
    paid: all.filter((r) => r.paid_at).length,
    warnings,
    dryRun: args.dryRun,
  }
  if (args.dryRun) return out

  const stamp = new Date().toISOString()
  const payload = all.map((r) => ({ ...r, project: client.id, event_date: w.date, updated_at: stamp }))
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await db.from('lead_journey').upsert(payload.slice(i, i + 500), { onConflict: 'project,event_date,contact_id' })
    if (error) throw new Error(/lead_journey|does not exist|schema cache/i.test(error.message) ? 'run supabase/funnel.sql once' : error.message)
  }
  return out
}

// ---------------------------------------------------------------- the call log

export type SheetCall = { calledAt: string | null; contactId: string | null; outcome: string | null; pickedUp: string | null; attempt: number | string | null; calledBy: string | null }

/** "14/10/2026 17:06" or "14/10/2026" (Malaysia time) or an ISO instant → ISO. */
export function parseCalledAt(v: string | null): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toISOString()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!m) return null
  const [, d, mo, y, h = '12', mi = '00'] = m
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00+08:00`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/**
 * Replace the project's stored Call Log with the sheet's current one: upsert
 * every row (keyed by its content), then drop rows the sheet no longer has.
 */
export async function storeCallLog(db: SupabaseClient, project: string, calls: SheetCall[]): Promise<{ stored: number }> {
  const { createHash } = await import('node:crypto')
  const stamp = new Date().toISOString()
  const rows = calls
    .filter((c) => c.contactId && c.outcome)
    .map((c) => ({
      project,
      row_key: createHash('sha1').update(JSON.stringify([c.calledAt, c.contactId, c.outcome, c.attempt, c.calledBy])).digest('hex').slice(0, 32),
      contact_id: String(c.contactId).replace(/^'/, ''),
      called_at: parseCalledAt(c.calledAt),
      outcome: c.outcome,
      picked_up: /^y/i.test(c.pickedUp ?? ''),
      attempt: Number(c.attempt) || null,
      called_by: c.calledBy || null,
      synced_at: stamp,
    }))
  const unique = [...new Map(rows.map((r) => [r.row_key, r])).values()]
  for (let i = 0; i < unique.length; i += 500) {
    const { error } = await db.from('call_log').upsert(unique.slice(i, i + 500), { onConflict: 'project,row_key' })
    if (error) throw new Error(/call_log|does not exist|schema cache/i.test(error.message) ? 'run supabase/funnel.sql once' : error.message)
  }
  if (unique.length) await db.from('call_log').delete().eq('project', project).lt('synced_at', stamp)
  return { stored: unique.length }
}
