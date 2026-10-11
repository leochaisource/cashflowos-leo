// The T-5 webinar hype-up reminder, by hand.
//
//   node --env-file-if-exists=.env scripts/webinar-reminder.ts                   today: would it send? (prints only)
//   node --env-file-if-exists=.env scripts/webinar-reminder.ts --today=2026-10-08  as if it were that morning
//   ... --send=owner     a preview to the owner's Telegram
//   ... --send=closer    the real thing (to the follow-up owner + the owner's copy; once per webinar unless --force)
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { runWebinarReminder } from '../lib/webinar-reminder.ts'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const client = AD_CLIENTS.find((c) => c.deal && c.ghl?.followupAssignee)
if (!client) throw new Error('no client with a follow-up owner')
const send = arg('send')
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const r = await runWebinarReminder({
  client,
  db,
  to: send === 'closer' ? 'closer' : send === 'owner' ? 'owner' : 'none',
  today: arg('today'),
  force: process.argv.includes('--force'),
})
if (r.text) console.log(r.text)
console.log(`\n— webinar ${r.webinar ?? '?'} · ${r.skipped ? `skipped: ${r.skipped}` : `sent to ${r.sentTo.length} chat(s)`}${r.error ? ` · ${r.error}` : ''}`)
