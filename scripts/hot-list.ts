// Ariella's GHL hot list (lib/hot-list.ts), by hand.
//
//   node --env-file=.env scripts/hot-list.ts                 preview: what the last 3 days would put on the list (changes nothing)
//   node --env-file=.env scripts/hot-list.ts --days=2        … over 2 days (today counts as one)
//   node --env-file=.env scripts/hot-list.ts --apply         do it: create / reopen / mark-paid cards in GHL
//   node --env-file=.env scripts/hot-list.ts --show          just print the list as it stands in GHL
//
// The days' chats are judged with the verdict cache, so chats already rated by
// today's runs aren't sent to the model again. The latest verdict per lead wins.
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { dayBounds } from '../lib/ghl.ts'
import { eventFor } from '../lib/deal.ts'
import { buildFollowups, type Followups } from '../lib/followups.ts'
import { syncHotList, readHotList, renderHotList } from '../lib/hot-list.ts'
import { localDay } from '../lib/hot-leads-sync.ts'
import { claudeClient } from '../lib/claude-usage.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const has = (k: string) => process.argv.includes(`--${k}`)
const client = AD_CLIENTS.find((c) => c.ghl?.hotList)
if (!client?.ghl?.hotList || !client.deal) throw new Error('no client with a hot list')
const g = client.ghl
const cfg = client.ghl.hotList
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

if (has('show')) {
  const l = await readHotList(client)
  console.log(l.error ?? plain(renderHotList(l.open, cfg.openStages, { title: 'Hot list in GHL', max: 50 })))
  process.exit(0)
}

const db = createClient((process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''), (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(), {
  auth: { persistSession: false },
})
const tz = g.timeZone ?? 'Asia/Kuala_Lumpur'
const today = localDay(tz)
const days = Number(arg('days') ?? 3)
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const key = process.env.ANTHROPIC_API_KEY?.trim()

const runs: Followups[] = []
for (let i = days - 1; i >= 0; i--) {
  const day = addDay(today, -i)
  const next = eventFor(client.deal, addDay(day, 1))
  if (!next) continue
  const { start, end } = dayBounds(day, tz)
  const until = i === 0 ? new Date().toISOString() : end
  const f = await buildFollowups({
    locationId: process.env[g.locationEnv]!.trim(),
    token: process.env[g.tokenEnv]!.trim(),
    day,
    dayStartISO: start,
    dayEndISO: until,
    salesSinceISO: dayBounds(next.from, tz).start,
    asOfISO: until,
    includeSources: g.includeOrderSources ?? [],
    product:
      `${client.client ?? client.name} one-day Claude AI workshop on ${next.to}, tickets ` +
      `RM${client.deal.ticketPrices.general} General / RM${client.deal.ticketPrices.vip} VIP`,
    anthropic: key ? claudeClient('script-hot-list', { apiKey: key }) : null,
    notLeads: g.notLeads,
    db,
    cacheKey: client.id,
  })
  console.log(`${day}: ${f.chats.length} chats (${f.chats.filter((c) => c.intent === 'hot').length} hot) · ${f.unpaid.length} unpaid · judged ${f.intentStats?.judged ?? '?'}, reused ${f.intentStats?.reused ?? '?'}`)
  runs.push(f)
}

// One view of the days: the latest verdict per lead, every unpaid checkout, every payment.
const latest = new Map<string, Followups['chats'][number]>()
for (const f of runs) for (const c of f.chats) if (!latest.has(c.contactId) || latest.get(c.contactId)!.lastInboundAt < c.lastInboundAt) latest.set(c.contactId, c)
const merged: Followups = {
  ...runs[runs.length - 1],
  chats: [...latest.values()],
  unpaid: [...new Map(runs.flatMap((f) => f.unpaid).map((u) => [u.contactId, u])).values()],
  paidAt: new Map(runs.flatMap((f) => [...f.paidAt])),
}

const s = await syncHotList({ client, f: merged, db, dryRun: !has('apply') })
if (!s.ok) throw new Error(s.error)
const line = (c: { name: string; why: string; stage: string }) => `  ${c.name} — ${c.why} [${c.stage}]`
console.log(`\n${s.dryRun ? 'PREVIEW (nothing changed)' : 'APPLIED'}`)
console.log(`Would add / added (${s.added.length}):\n${s.added.map(line).join('\n') || '  none'}`)
console.log(`Back on the list (${s.reopened.length}):\n${s.reopened.map(line).join('\n') || '  none'}`)
console.log(`Moved to Paid (${s.paid.length}):\n${s.paid.map(line).join('\n') || '  none'}`)
console.log(`Owned by another teammate — left off (${s.ownedByOthers.length}): ${s.ownedByOthers.map((o) => `${o.name} (${o.ownerId})`).join(', ') || 'none'}`)
if (s.errors.length) console.log(`Errors (${s.errors.length}): ${s.errors.slice(0, 5).join(' | ')}`)
if (!s.dryRun) console.log('\n' + plain(renderHotList(s.open, cfg.openStages, { title: 'Hot list in GHL', max: 50 })))
