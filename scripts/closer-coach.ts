// The 9am closing coach, by hand — print it, or send it.
//
//   node --env-file-if-exists=.env scripts/closer-coach.ts                  yesterday, print only
//   node --env-file-if-exists=.env scripts/closer-coach.ts --day=2026-10-06
//   ... --send=owner     a preview to the owner's Telegram
//   ... --send=closer    the real thing (to the follow-up owner; once per day unless --force)
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { runCloserCoach } from '../lib/closer-coach-run.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const client = AD_CLIENTS.find((c) => c.deal && c.ghl?.followupAssignee)
if (!client) throw new Error('no client with a follow-up owner')
const send = arg('send')
const to = send === 'closer' ? 'closer' : send === 'owner' ? 'owner' : 'none'
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const key = process.env.ANTHROPIC_API_KEY?.trim()
const t0 = Date.now()
const r = await runCloserCoach({
  client,
  day: arg('day'),
  to,
  db,
  anthropic: key ? new Anthropic({ apiKey: key }) : null,
  force: process.argv.includes('--force'),
})
console.log(r.text ?? '')
console.log(`\n— ${r.day} · ${Math.round((Date.now() - t0) / 1000)}s · sent to ${r.sentTo.length ? r.sentTo.length + ' chat(s)' : 'nobody'}${r.skipped ? ` · skipped: ${r.skipped}` : ''}${r.error ? ` · ${r.error}` : ''}`)
