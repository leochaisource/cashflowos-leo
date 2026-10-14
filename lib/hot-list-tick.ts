import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import { pipelineByName, pipelineCards, updateCard, addTags, removeTags, setContactField, whatsappMessagesViaConversations, type Card } from './ghl.ts'
import { eventFor } from './deal.ts'
import { sendMessage } from './telegram.ts'

// THE HOT LIST, HOURLY (owner, 2026-10-15) — what happens after Ariella moves a
// card, without her having to remember:
//
//   📞 Call back   she called, no answer or busy, and picked WHEN on the card
//                  ("Call back": In 1 hour … In 2 days; nothing picked = in 2
//                  hours). At that time she's pinged: call now. Ari can WhatsApp
//                  the lead right after the missed call.
//   🤔 Thinking    they talked but aren't ready. Ari follows up on day 1 and day
//                  3, then 2 days before the class; when the class has passed
//                  the card goes to Parked.
//   💳 Link sent   24h and still no payment: she's pinged (and Ari can ask
//                  whether the payment went through).
//   Any of the three — the lead writes back on WhatsApp: she's pinged.
//
// Pings go to her Telegram and as a GHL in-app notification (the coach-nudge
// workflow: a note field + a tag). Ari's messages are GHL tags that fire
// workflows sending approved WhatsApp templates; each is off until its tag is
// configured. Nothing goes to a lead between 9pm and 9am; pings wait for 8am.
// No AI here — it costs no Claude credit.

const BUCKET = 'cfo-cache'
const statePath = (project: string) => `hotlist/${project}-tick.json`
const KL = 8 * 3600e3
const H = 3600e3

type CardState = {
  /** stageId@changedAt — a new stage entry starts over. */
  entry: string
  did: string[]
  cb?: { choice: string | null; base: string; due: string; done: boolean }
  /** The class they were thinking about when they entered Thinking. */
  classDate?: string
  /** The last inbound WhatsApp we pinged about. */
  seenInbound?: string
}
type State = { at?: string; cards: Record<string, CardState> }

export type TickPing = { contactId: string; name: string; kind: 'callback' | 'replied' | 'link'; text: string }
export type TickResult = {
  ok: boolean
  error?: string
  pings: TickPing[]
  ari: { contactId: string; name: string; tag: string }[]
  parked: string[]
  errors: string[]
  dryRun: boolean
}

const klHour = (t: number) => new Date(t + KL).getUTCHours()
const klDay = (t: number) => new Date(t + KL).toISOString().slice(0, 10)
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const atKL = (day: string, hh: number) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00+08:00`)
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const whyOf = (title: string) => {
  const i = title.indexOf(' — ')
  return i >= 0 ? title.slice(i + 3) : ''
}

/** When to remind her, from her "Call back" choice (Kuala Lumpur time). */
export function callbackDue(choice: string | null, baseISO: string, defaultHours: number): string {
  const base = Date.parse(baseISO)
  const day = klDay(base)
  const iso = (t: number) => new Date(t).toISOString()
  switch ((choice ?? '').trim().toLowerCase()) {
    case 'in 1 hour':
      return iso(base + H)
    case 'in 3 hours':
      return iso(base + 3 * H)
    case 'tonight 8pm': {
      const t = atKL(day, 20)
      return iso(t > base ? t : atKL(addDay(day, 1), 20))
    }
    case 'tomorrow 10am':
      return iso(atKL(addDay(day, 1), 10))
    case 'tomorrow 3pm':
      return iso(atKL(addDay(day, 1), 15))
    case 'in 2 days':
      return iso(atKL(addDay(day, 2), 10))
    default:
      return iso(base + defaultHours * H)
  }
}

async function loadState(db: SupabaseClient, project: string): Promise<State> {
  const { data, error } = await db.storage.from(BUCKET).download(statePath(project))
  if (error || !data) return { cards: {} }
  try {
    const s = JSON.parse(await data.text()) as State
    return { at: s.at, cards: s.cards ?? {} }
  } catch {
    return { cards: {} }
  }
}

async function saveState(db: SupabaseClient, project: string, s: State): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(statePath(project), JSON.stringify(s), { upsert: true, contentType: 'application/json' })
  if (error) throw new Error(`hot list tick memory not saved: ${error.message}`)
}

export async function runHotListTick(args: { client: AdClient; db: SupabaseClient; now?: Date; dryRun?: boolean }): Promise<TickResult> {
  const { client } = args
  const g = client.ghl
  const cfg = g?.hotList
  const auto = cfg?.automation
  const closer = g?.followupAssignee
  const out: TickResult = { ok: false, pings: [], ari: [], parked: [], errors: [], dryRun: !!args.dryRun }
  if (!g || !cfg || !auto || !closer) return { ...out, error: 'no hot list automation configured' }
  const token = process.env[g.tokenEnv]!.trim()
  const locationId = process.env[g.locationEnv]!.trim()
  const now = (args.now ?? new Date()).getTime()
  const nowISO = new Date(now).toISOString()
  const hour = klHour(now)
  const ariHours = hour >= 9 && hour < 21 // nothing to a lead at night
  const pingHours = hour >= 8 && hour < 22

  const pipe = await pipelineByName(locationId, token, cfg.pipeline).catch((e) => {
    out.error = (e as Error).message
    return null
  })
  if (!pipe) return { ...out, error: out.error ?? `pipeline "${cfg.pipeline}" not found in GHL` }
  const name = new Map(pipe.stages.map((s) => [s.id, s.name.toLowerCase()]))
  const stageId = (n: string) => pipe.stages.find((s) => s.name.toLowerCase() === n.toLowerCase())?.id
  const open = new Set(cfg.openStages.map((s) => s.toLowerCase()))
  const parkedId = stageId('Parked')
  let cards: Card[]
  try {
    cards = (await pipelineCards(locationId, token, pipe.id)).filter((c) => c.status === 'open' && open.has(name.get(c.stageId) ?? ''))
  } catch (e) {
    return { ...out, error: (e as Error).message }
  }

  const state = await loadState(args.db, client.id)
  // Their WhatsApp messages since the last daytime tick (at most 12 hours back),
  // so a reply at 2am is still pinged at 8am.
  const since = Math.max(Date.parse(state.at ?? '') || 0, now - 12 * H)
  const inbound = new Map<string, string>()
  try {
    for (const m of await whatsappMessagesViaConversations(locationId, token, new Date(since).toISOString(), nowISO))
      if (m.direction === 'inbound' && (!inbound.has(m.contactId) || inbound.get(m.contactId)! < m.dateAdded)) inbound.set(m.contactId, m.dateAdded)
  } catch (e) {
    out.errors.push(`messages: ${(e as Error).message}`)
  }

  const nextClass = client.deal ? eventFor(client.deal, klDay(now))?.to ?? null : null
  const kept: Record<string, CardState> = {}
  const ari = (c: Card, key: keyof typeof auto.ari, st: CardState) => {
    const tag = auto.ari[key]
    if (!tag || st.did.includes(`ari:${key}`) || !ariHours) return
    out.ari.push({ contactId: c.contactId, name: c.contactName ?? 'Unnamed lead', tag })
    st.did.push(`ari:${key}`)
  }
  const ping = (c: Card, kind: TickPing['kind'], text: string) =>
    out.pings.push({ contactId: c.contactId, name: c.contactName ?? 'Unnamed lead', kind, text })

  for (const c of cards) {
    const stage = name.get(c.stageId) ?? ''
    const entry = `${c.stageId}@${c.changedAt}`
    const st: CardState = state.cards[c.id]?.entry === entry ? state.cards[c.id] : { entry, did: [] }
    kept[c.id] = st
    const who = c.contactName ?? 'Unnamed lead'
    const why = whyOf(c.title)
    const entered = Date.parse(c.changedAt)
    const age = now - entered
    const wrote = inbound.get(c.contactId)
    const repliedSince = wrote && Date.parse(wrote) > entered && st.seenInbound !== wrote

    if (stage === auto.callbackStage.toLowerCase()) {
      ari(c, 'missedCall', st)
      const choice = (cfg.callbackFieldId && c.fields[cfg.callbackFieldId]) || null
      // A new choice (or the first look) sets the clock from when the card was edited.
      if (!st.cb || st.cb.choice !== choice) {
        const base = choice ? c.updatedAt || c.changedAt : c.changedAt
        st.cb = { choice, base, due: callbackDue(choice, base, auto.defaultCallbackHours), done: false }
      }
      if (!st.cb.done && now >= Date.parse(st.cb.due) && pingHours) {
        ping(c, 'callback', `📞 <b>Call ${esc(who)} now</b> — ${choice ? `you said "${esc(choice)}"` : `${auto.defaultCallbackHours}h since the missed call`}${why ? ` · ${esc(why)}` : ''}`)
        st.cb.done = true
      }
      if (repliedSince && pingHours) {
        ping(c, 'replied', `💬 <b>${esc(who)}</b> replied on WhatsApp after your call — answer or call now`)
        st.seenInbound = wrote
      }
    } else if (stage === auto.thinkingStage.toLowerCase()) {
      st.classDate ??= nextClass ?? undefined
      if (st.classDate && klDay(now) > st.classDate) {
        // The class they were thinking about has passed.
        if (parkedId && !args.dryRun) await updateCard(token, c.id, { stageId: parkedId }).catch((e) => out.errors.push((e as Error).message))
        out.parked.push(who)
        delete kept[c.id]
        continue
      }
      if (age >= 24 * H) ari(c, 'thinking1', st)
      if (age >= 72 * H) ari(c, 'thinking3', st)
      if (st.classDate && now >= atKL(st.classDate, 0) - 2 * 864e5) ari(c, 'deadline', st)
      if (repliedSince && pingHours) {
        ping(c, 'replied', `🤔 <b>${esc(who)}</b> (thinking) replied on WhatsApp — call while it's warm`)
        st.seenInbound = wrote
      }
    } else if (stage === auto.linkStage.toLowerCase()) {
      if (age >= 24 * H && !st.did.includes('link24') && pingHours) {
        ari(c, 'linkCheck', st)
        ping(c, 'link', `💳 <b>${esc(who)}</b> got the payment link a day ago and hasn't paid — call to help them finish`)
        st.did.push('link24')
      }
      if (repliedSince && pingHours) {
        ping(c, 'replied', `💳 <b>${esc(who)}</b> (link sent) replied on WhatsApp`)
        st.seenInbound = wrote
      }
    }
  }

  if (!args.dryRun) {
    // Ari's follow-ups: re-adding a tag only fires its workflow if it isn't already on.
    for (const a of out.ari)
      try {
        await removeTags(token, a.contactId, [a.tag]).catch(() => {})
        await addTags(token, a.contactId, [a.tag])
      } catch (e) {
        out.errors.push(`Ari ${a.tag} for ${a.name}: ${(e as Error).message}`)
      }
    // Her pings: one Telegram message, plus a GHL in-app notification per lead.
    if (out.pings.length) {
      const link = (id: string) => `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${id}`
      const lines = out.pings.map((p) => `${p.text}\n   <a href="${link(p.contactId)}">open in GHL</a>`)
      const text = `⏰ <b>Your list, ${String(hour).padStart(2, '0')}:00</b>\n\n${lines.join('\n\n')}\n\n<i>Move the card when you're done: GHL → Opportunities → ${esc(cfg.pipeline)}.</i>`
      if (closer.telegramChatId) {
        const r = await sendMessage(closer.telegramChatId, text, { noPreview: true })
        if (!r.ok) out.errors.push(`Telegram: ${r.error}`)
      }
      if (auto.inApp)
        for (const p of out.pings)
          try {
            await setContactField(token, p.contactId, auto.inApp.noteFieldId, p.text.replace(/<[^>]+>/g, ''))
            await removeTags(token, p.contactId, [auto.inApp.tag]).catch(() => {})
            await addTags(token, p.contactId, [auto.inApp.tag])
          } catch (e) {
            out.errors.push(`in-app for ${p.name}: ${(e as Error).message}`)
          }
    }
    await saveState(args.db, client.id, { at: pingHours ? nowISO : state.at ?? nowISO, cards: kept }).catch((e) => out.errors.push((e as Error).message))
  }
  out.ok = true
  return out
}
