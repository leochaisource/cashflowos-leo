// THE FUNNEL X-RAY from the laptop (owner, 2026-10-22).
//
//   node --env-file=.env scripts/lead-journey.ts                     the current event's report (reads only)
//   node --env-file=.env scripts/lead-journey.ts --event=2           another event's report
//   node --env-file=.env scripts/lead-journey.ts --build --event=3   rebuild that cohort, reading WhatsApp
//                                                                    for every day of its window (backfill)
//   ... --build --dry                                                work it out, write nothing
//
// No AI calls. The nightly rebuild is /api/lead-journey (yesterday only).
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { journeyFor } from '../lib/funnel-config.ts'
import { eventWindows, klToday } from '../lib/funnel-data.ts'
import { funnelView } from '../lib/funnel-view.ts'
import { refreshJourney } from '../lib/lead-journey.ts'
import { sortCreatives } from '../lib/funnel-report.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const has = (k: string) => process.argv.includes(`--${k}`)
const client = AD_CLIENTS.find((c) => c.id === (arg('client') ?? 'claude-malaysia'))
if (!client || !journeyFor(client.id)) throw new Error('no journey set up for that client')
const db = createClient((process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''), (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(), {
  auth: { persistSession: false },
})
const eventNo = Number(arg('event')) || undefined
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const rm = (v: number | null) => (v === null ? '—' : `RM${Math.round(v).toLocaleString('en-MY')}`)

if (has('build')) {
  const w = (eventNo ? eventWindows(client).find((x) => x.no === eventNo) : null) ?? eventWindows(client).find((x) => x.to >= klToday())
  if (!w) throw new Error('no such event')
  const last = [w.to, new Date(Date.parse(`${klToday()}T00:00:00Z`) - 864e5).toISOString().slice(0, 10)].sort()[0]
  const days: string[] = []
  for (let d = w.from; d <= last; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) days.push(d)
  console.log(`${w.label} (${w.from} → ${w.to}): reading WhatsApp for ${days.length} days…`)
  const t0 = Date.now()
  // --skip-replies: keep the replies already stored (re-reading WhatsApp takes minutes).
  const r = await refreshJourney({ client, db, day: last, days: has('skip-replies') ? [] : days, dryRun: has('dry') })
  console.log(JSON.stringify(r, null, 1), `\n${Math.round((Date.now() - t0) / 1000)}s`)
}

const v = await funnelView(db, client, { eventNo, funnel: arg('funnel') })
if (!v) throw new Error('no view')
const r = v.report
console.log(`\n== ${v.window.label} · ${v.window.from} → ${v.window.to} · ${v.funnel} · ${v.tracked ? 'tracked' : 'archive only'}${v.error ? ` (${v.error})` : ''}`)
console.log(`spend ${rm(r.spend)} · leads ${r.leads} · customers ${r.customers} (${r.seats} seats) · revenue ${rm(r.revenue)} · ${r.roas?.toFixed(1) ?? '—'}x`)
console.log('counts', JSON.stringify(r.counts))
for (const x of r.rates)
  console.log(`  ${x.label.padEnd(20)} ${pct(x.rate).padStart(7)} vs ${pct(x.benchmark).padStart(7)} ${x.status.padEnd(6)} ${String(x.hit).padStart(5)}/${String(x.base).padEnd(5)} at stake ${rm(x.atStake)}${x.note ? ` · ${x.note}` : ''}`)
console.log('bottleneck:', r.bottleneck ? `${r.bottleneck.label} (${rm(r.bottleneck.atStake)})` : 'none', '· history:', v.history.join(', ') || 'none')
console.log('speed', JSON.stringify(r.speed))
for (const c of sortCreatives(v.creatives, 'customer').slice(0, 10))
  console.log(`  ${c.funnel.padEnd(20)} ${c.ad.slice(0, 40).padEnd(40)} ${String(c.leads).padStart(4)} leads ${String(c.customers).padStart(3)} cust ${rm(c.costPerCustomer).padStart(8)}/cust ${rm(c.cpl).padStart(6)}/lead${c.weakStage ? ` · drops at ${c.weakStage}` : ''}`)
