// Print the 8am brief as it would look today, from what is already stored —
// no Adyntel search, no model call, nothing sent to Telegram.
//
//   node --env-file-if-exists=.env scripts/brief-preview.ts --client=claude-malaysia
//   ... --all      every focus project
//   ... --date=2026-09-25   treat ads first stored that day as "new this morning"
//
// Uses lib/brief-digest.ts, the code the cron runs, with the latest stored
// performance block and notes from brief_daily. The one thing it cannot show is
// the model's five-line analysis (that needs a live run).
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import {
  loadDigestProfiles,
  competitorDigest,
  operatorAlerts,
  competitorsLink,
  dayLabel,
  type FreshAdvertiser,
} from '../lib/brief-digest.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const ALL = process.argv.includes('--all')
const ID = arg('client')
const clients = ALL
  ? AD_CLIENTS.filter((c) => typeof c.rank === 'number').sort((a, b) => (a.rank as number) - (b.rank as number))
  : AD_CLIENTS.filter((c) => c.id === ID)
if (!clients.length) {
  console.error(`pass --client=<id> or --all · clients: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// "This morning" = the KL day the ads were first stored.
const day = arg('date') ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })
const from = new Date(`${day}T00:00:00+08:00`).toISOString()
const to = new Date(Date.parse(from) + 864e5).toISOString()

for (const c of clients) {
  // New this morning: on-topic ads first stored that day, by advertiser.
  const { data: newAds, error } = await db
    .from('competitor_ads')
    .select('competitor')
    .eq('client', c.id)
    .eq('on_topic', true)
    .gte('first_seen_at', from)
    .lt('first_seen_at', to)
  if (error) throw new Error(error.message)
  const { data: older } = await db
    .from('competitor_ads')
    .select('competitor')
    .eq('client', c.id)
    .lt('first_seen_at', from)
    .in('competitor', [...new Set((newAds ?? []).map((a) => a.competitor))])
  const known = new Set((older ?? []).map((a) => a.competitor))
  const freshBy = new Map<string, FreshAdvertiser>()
  for (const a of newAds ?? []) {
    const f = freshBy.get(a.competitor) ?? { competitor: a.competitor, newAds: 0, newAdvertiser: !known.has(a.competitor) }
    f.newAds++
    freshBy.set(a.competitor, f)
  }

  const { data: last } = await db
    .from('brief_daily')
    .select('date, performance_text, notes')
    .eq('project', c.id)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()
  const perfText = (last?.performance_text as string | null) ?? ''
  const notes = (last?.notes as string[] | null) ?? []

  const profiles = await loadDigestProfiles(db, c.id, [...freshBy.keys()])
  if (profiles.error) throw new Error(profiles.error)
  const digest = competitorDigest({
    title: perfText ? 'Competitors' : `${c.client ?? c.name} — competitors`,
    dateLabel: dayLabel(new Date(`${day}T12:00:00+08:00`)),
    fresh: [...freshBy.values()],
    profiles,
  })
  const alerts = operatorAlerts(notes)
  const text = [
    perfText ? esc(perfText) : '',
    digest,
    '<i>(+ at most 5 lines of AI analysis on a live run)</i>',
    competitorsLink(c.id, profiles.competitors),
    alerts.map((a) => `⚠️ ${esc(a)}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  console.log(`\n==================== ${c.id} · ${text.length} chars · notes ${last?.date ?? '—'}: ${notes.length} → ${alerts.length} alert(s)`)
  console.log(text)
}
