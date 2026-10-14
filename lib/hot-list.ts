import type { SupabaseClient } from '@supabase/supabase-js'
// Explicit .ts extensions: shared with scripts/hot-list.ts (Node type stripping).
import type { AdClient } from './ad-clients.ts'
import type { Followups } from './followups.ts'
import { pipelineByName, pipelineCards, createCard, updateCard, contactsWithTag, contactOwner, type Card, type Pipeline } from './ghl.ts'

// THE FOLLOW-UP OWNER'S ONE LIST (owner, 2026-10-14).
//
// Ariella was told who to chase by three things that disagreed — the hot leads
// sheet, the coach's in-app nudges and the morning Telegram — each with its own
// rule, window and cap, and none knew when she'd finished with a lead. Now there
// is ONE list, in GHL: the "CM1D Hot Leads" pipeline. CashFlowOS is the only
// thing that adds cards; she moves them on her phone; every other surface reads
// the pipeline.
//
//   Hot → Contacted → Link sent          on her list
//   Paid · Not interested · Parked       off it
//
// A lead goes on the list (one card per contact) when CashFlowOS rates their
// WhatsApp chat hot, a checkout failed or is pending, or one of the enter tags
// appears (Ari's own cm1d-hot, the cart / payment tags) — never if they paid, are
// not a lead, or another teammate owns the contact. A payment moves the card to
// Paid on its own. A card she closed comes back to the first stage only if the
// lead writes again (or tries to pay again) AFTER she closed it and is hot again.
//
// Cards are created UNASSIGNED: GHL gives an assigned card's owner the contact
// too, which would change who owns the lead. Tag holders are remembered between
// runs (cfo-cache bucket), so a tag counts once — when it first appears — and an
// old tag can't put a long-cold lead back on the list.

const BUCKET = 'cfo-cache'
const seenPath = (project: string) => `hotlist/${project}.json`

const TAG_WHY: Record<string, string> = {
  'cm1d-hot': 'Ari flagged a buying signal',
  'cm1d-cart': 'Started the checkout',
  'cm1d-pay-failed': 'Payment failed',
  'payment-not-completed': 'Payment not completed',
}

export type ListCard = {
  cardId: string
  contactId: string
  name: string
  /** Why they're on the list (the card's own name, after "Name — "). */
  why: string
  stage: string
  open: boolean
  since: string
  changedAt: string
}

export type HotListSync = {
  ok: boolean
  error?: string
  /** The list after this run: open cards, in stage order then oldest first. */
  open: ListCard[]
  added: ListCard[]
  reopened: ListCard[]
  paid: ListCard[]
  /** Hot, but owned by another teammate in GHL — left off her list. */
  ownedByOthers: { name: string; ownerId: string }[]
  errors: string[]
  dryRun: boolean
}

type Candidate = { contactId: string; name: string | null; why: string; source: string; at: string }

const titleOf = (name: string, why: string) => `${name} — ${why}`.slice(0, 120)
const whyOf = (title: string) => {
  const i = title.indexOf(' — ')
  return i >= 0 ? title.slice(i + 3) : ''
}

async function loadSeen(db: SupabaseClient, project: string): Promise<Record<string, string[]> | null> {
  const { data, error } = await db.storage.from(BUCKET).download(seenPath(project))
  if (error || !data) return null
  try {
    return (JSON.parse(await data.text()) as { seen?: Record<string, string[]> }).seen ?? null
  } catch {
    return null
  }
}

async function saveSeen(db: SupabaseClient, project: string, seen: Record<string, string[]>): Promise<void> {
  const body = JSON.stringify({ seen, at: new Date().toISOString() })
  const put = () => db.storage.from(BUCKET).upload(seenPath(project), body, { upsert: true, contentType: 'application/json' })
  let { error } = await put()
  if (error && /bucket/i.test(error.message)) {
    await db.storage.createBucket(BUCKET, { public: false })
    ;({ error } = await put())
  }
  if (error) throw new Error(`hot list memory not saved: ${error.message}`)
}

/**
 * Bring the pipeline up to date from one run's follow-ups (`f`: the chats judged
 * and the unpaid checkouts) plus the enter tags. `dryRun` reads everything and
 * reports what it WOULD do, changing nothing in GHL or storage.
 */
export async function syncHotList(args: { client: AdClient; f: Followups; db: SupabaseClient | null; dryRun?: boolean }): Promise<HotListSync> {
  const { client, f } = args
  const g = client.ghl
  const cfg = g?.hotList
  const out: HotListSync = { ok: false, open: [], added: [], reopened: [], paid: [], ownedByOthers: [], errors: [], dryRun: !!args.dryRun }
  if (!g || !cfg || !g.followupAssignee) return { ...out, error: 'no hot list configured' }
  const token = process.env[g.tokenEnv]!.trim()
  const locationId = process.env[g.locationEnv]!.trim()
  const ownerId = g.followupAssignee.userId

  let pipe: Pipeline | null
  let cards: Card[]
  try {
    pipe = await pipelineByName(locationId, token, cfg.pipeline)
    if (!pipe) return { ...out, error: `pipeline "${cfg.pipeline}" not found in GHL` }
    cards = await pipelineCards(locationId, token, pipe.id)
  } catch (e) {
    return { ...out, error: (e as Error).message }
  }
  const stageId = new Map(pipe.stages.map((s) => [s.name.toLowerCase(), s.id]))
  const stageName = new Map(pipe.stages.map((s) => [s.id, s.name]))
  const idOf = (name: string) => stageId.get(name.toLowerCase())
  const firstOpen = idOf(cfg.openStages[0])
  const paidStage = idOf(cfg.paidStage)
  if (!firstOpen || !paidStage) return { ...out, error: `pipeline "${cfg.pipeline}" is missing the stage "${firstOpen ? cfg.paidStage : cfg.openStages[0]}"` }
  const openIds = new Set(cfg.openStages.map(idOf).filter(Boolean) as string[])
  const isOpen = (c: Card) => c.status === 'open' && openIds.has(c.stageId)
  const isPaidCard = (c: Card) => c.stageId === paidStage || c.status === 'won'

  // One card per contact; if a duplicate ever appears, the open one wins.
  const cardOf = new Map<string, Card>()
  for (const c of cards) {
    const had = cardOf.get(c.contactId)
    if (!had || (!isOpen(had) && isOpen(c))) cardOf.set(c.contactId, c)
  }

  const notLeads = new Set(g.notLeads ?? [])
  const notALead = new Set(f.chats.filter((c) => c.intent === 'not_a_lead').map((c) => c.contactId))
  const paidTags = new Set(cfg.paidTags)
  const paid = (contactId: string, tags: string[]) => f.paidAt.has(contactId) || tags.some((t) => paidTags.has(t))

  // ── Who should be on the list from this run ───────────────────────────────
  const cand = new Map<string, Candidate>()
  const fromTag = (c: Candidate) => c.source.startsWith('tag ')
  const put = (c: Candidate) => {
    const had = cand.get(c.contactId)
    if (!had) return void cand.set(c.contactId, c)
    const at = had.at > c.at ? had.at : c.at
    // The card reads short on a phone: a payment and a chat reason combine
    // ("Payment failed · asked which ticket"); a tag's note only stands in when
    // there's nothing better.
    if (fromTag(c)) return void cand.set(c.contactId, { ...had, at })
    if (fromTag(had)) return void cand.set(c.contactId, { ...c, at })
    cand.set(c.contactId, { ...had, why: had.why.includes(c.why) ? had.why : `${had.why} · ${c.why}`, at })
  }
  for (const u of f.unpaid)
    put({ contactId: u.contactId, name: u.name, why: `Payment ${u.status}${u.amount ? ` (RM${u.amount})` : ''}`, source: 'unpaid checkout', at: u.at })
  for (const c of f.chats)
    if (c.intent === 'hot') put({ contactId: c.contactId, name: c.name, why: c.reason ?? 'Hot WhatsApp chat', source: 'hot chat', at: c.lastInboundAt })

  // Enter tags: only a tag that appeared since the last run counts. The first
  // run ever has no memory, and tags like cm1d-hot never come off — so it takes
  // tag holders who wrote in this run and still read hot or warm, plus cart /
  // payment tag holders active in GHL in the last 3 days (a cart needs no chat).
  const seen = args.db ? await loadSeen(args.db, client.id) : null
  const nowSeen: Record<string, string[]> = {}
  const wrote = new Set(f.chats.filter((c) => c.intent === 'hot' || c.intent === 'warm').map((c) => c.contactId))
  const now = new Date().toISOString()
  const seedSince = new Date(Date.now() - 3 * 864e5).toISOString()
  const firstRunTakes = (tag: string, h: { id: string; lastActivity?: string | null }) =>
    wrote.has(h.id) || (tag !== 'cm1d-hot' && !!h.lastActivity && h.lastActivity >= seedSince)
  for (const tag of cfg.enterTags) {
    let holders: Awaited<ReturnType<typeof contactsWithTag>> = []
    try {
      holders = await contactsWithTag(locationId, token, tag)
    } catch (e) {
      out.errors.push(`tag ${tag}: ${(e as Error).message}`)
      nowSeen[tag] = seen?.[tag] ?? []
      continue
    }
    nowSeen[tag] = holders.map((h) => h.id)
    const before = new Set(seen?.[tag] ?? [])
    for (const h of holders) {
      const fresh = seen ? !before.has(h.id) : firstRunTakes(tag, h)
      if (fresh && !paid(h.id, h.tags)) put({ contactId: h.id, name: h.name, why: TAG_WHY[tag] ?? tag, source: `tag ${tag}`, at: now })
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const listCard = (c: Card, name: string, why: string, stage = c.stageId, open = isOpen(c)): ListCard => ({
    cardId: c.id,
    contactId: c.contactId,
    name,
    why,
    stage: stageName.get(stage) ?? '?',
    open,
    since: c.createdAt,
    changedAt: c.changedAt,
  })
  const work = [...cand.values()].filter((c) => !notLeads.has(c.contactId) && !notALead.has(c.contactId) && !f.paidAt.has(c.contactId))
  for (let i = 0; i < work.length; i += 5)
    await Promise.all(
      work.slice(i, i + 5).map(async (c) => {
        try {
          const card = cardOf.get(c.contactId)
          if (!card) {
            const who = await contactOwner(token, c.contactId)
            if (paid(c.contactId, who.tags)) return
            if (who.assignedTo && who.assignedTo !== ownerId) {
              out.ownedByOthers.push({ name: who.name ?? c.name ?? 'Unnamed lead', ownerId: who.assignedTo })
              return
            }
            const name = who.name ?? c.name ?? 'Unnamed lead'
            const id = args.dryRun
              ? 'dry-run'
              : await createCard(token, locationId, {
                  pipelineId: pipe!.id,
                  stageId: firstOpen,
                  contactId: c.contactId,
                  title: titleOf(name, c.why),
                  source: `CashFlowOS · ${c.source}`,
                  monetaryValue: cfg.monetaryValue,
                })
            const made: Card = { id, contactId: c.contactId, title: titleOf(name, c.why), stageId: firstOpen, status: 'open', createdAt: now, changedAt: now, contactName: name, contactTags: who.tags, assignedTo: who.assignedTo, source: c.source }
            cardOf.set(c.contactId, made)
            out.added.push(listCard(made, name, c.why))
            return
          }
          // Closed by her (not paid) and they've come back since: back to the top.
          if (!isOpen(card) && !isPaidCard(card) && c.at > card.changedAt) {
            const name = card.contactName ?? c.name ?? 'Unnamed lead'
            if (!args.dryRun) await updateCard(token, card.id, { stageId: firstOpen, status: 'open', title: titleOf(name, `back: ${c.why}`) })
            const back: Card = { ...card, stageId: firstOpen, status: 'open', title: titleOf(name, `back: ${c.why}`), changedAt: now }
            cardOf.set(c.contactId, back)
            out.reopened.push(listCard(back, name, `back: ${c.why}`))
          }
        } catch (e) {
          out.errors.push((e as Error).message)
        }
      }),
    )

  // Paid → the Paid stage, whatever stage she left it in.
  const all = [...cardOf.values()]
  for (const c of all) {
    if (isPaidCard(c) || !paid(c.contactId, c.contactTags)) continue
    try {
      if (!args.dryRun) await updateCard(token, c.id, { stageId: paidStage, status: 'won' })
      const name = c.contactName ?? 'Unnamed lead'
      out.paid.push(listCard(c, name, whyOf(c.title), paidStage, false))
      cardOf.set(c.contactId, { ...c, stageId: paidStage, status: 'won' })
    } catch (e) {
      out.errors.push((e as Error).message)
    }
  }

  const order = new Map(cfg.openStages.map((s, i) => [idOf(s) ?? s, i]))
  out.open = [...cardOf.values()]
    .filter(isOpen)
    .map((c) => listCard(c, c.contactName ?? 'Unnamed lead', whyOf(c.title)))
    .sort((a, b) => (order.get(idOf(a.stage) ?? '') ?? 9) - (order.get(idOf(b.stage) ?? '') ?? 9) || a.since.localeCompare(b.since))

  if (args.db && !args.dryRun) await saveSeen(args.db, client.id, nowSeen).catch((e) => out.errors.push((e as Error).message))
  out.ok = true
  return out
}

/** Just read the list (no changes) — for surfaces that only show it. */
export async function readHotList(client: AdClient): Promise<{ open: ListCard[]; error?: string }> {
  const g = client.ghl
  const cfg = g?.hotList
  if (!g || !cfg) return { open: [], error: 'no hot list configured' }
  try {
    const token = process.env[g.tokenEnv]!.trim()
    const locationId = process.env[g.locationEnv]!.trim()
    const pipe = await pipelineByName(locationId, token, cfg.pipeline)
    if (!pipe) return { open: [], error: `pipeline "${cfg.pipeline}" not found in GHL` }
    const names = new Map(pipe.stages.map((s) => [s.id, s.name]))
    const order = cfg.openStages.map((s) => s.toLowerCase())
    const open = (await pipelineCards(locationId, token, pipe.id))
      .filter((c) => c.status === 'open' && order.includes((names.get(c.stageId) ?? '').toLowerCase()))
      .map((c) => ({
        cardId: c.id,
        contactId: c.contactId,
        name: c.contactName ?? 'Unnamed lead',
        why: whyOf(c.title),
        stage: names.get(c.stageId) ?? '?',
        open: true,
        since: c.createdAt,
        changedAt: c.changedAt,
      }))
      .sort((a, b) => order.indexOf(a.stage.toLowerCase()) - order.indexOf(b.stage.toLowerCase()) || a.since.localeCompare(b.since))
    return { open }
  } catch (e) {
    return { open: [], error: (e as Error).message }
  }
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const ICON: Record<string, string> = { hot: '🔥', contacted: '📞', 'link sent': '💳' }
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5))

/** "12 open — Hot 5 · Contacted 4 · Link sent 3" */
export function listCounts(open: ListCard[], stages: string[]): string {
  const n = (s: string) => open.filter((c) => c.stage.toLowerCase() === s.toLowerCase()).length
  return `${open.length} open — ${stages.map((s) => `${s} ${n(s)}`).join(' · ')}`
}

/**
 * Her list as Telegram HTML, by stage, oldest first — every card, so what she
 * reads matches what GHL shows. `max` caps each stage on a phone.
 */
export function renderHotList(open: ListCard[], stages: string[], opts: { title: string; max?: number } ): string {
  const max = opts.max ?? 12
  const out = [`<b>${esc(opts.title)}</b> · ${esc(listCounts(open, stages))}`]
  if (!open.length) {
    out.push('<i>Nothing on the list right now.</i>')
    return out.join('\n')
  }
  for (const s of stages) {
    const here = open.filter((c) => c.stage.toLowerCase() === s.toLowerCase())
    if (!here.length) continue
    out.push('', `${ICON[s.toLowerCase()] ?? '•'} <b>${esc(s)}</b>`)
    for (const c of here.slice(0, max)) {
      const age = ageDays(c.since)
      out.push(`• ${esc(c.name)}${c.why ? ` — ${esc(clip(c.why, 80))}` : ''}${age ? ` <i>(${age}d)</i>` : ''}`)
    }
    if (here.length > max) out.push(`  …and ${here.length - max} more`)
  }
  return out.join('\n')
}
