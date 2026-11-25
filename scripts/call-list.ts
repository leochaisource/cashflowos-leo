// Ariella's 9am "Call these first" (lib/call-list.ts), by hand.
//
//   node --env-file=.env scripts/call-list.ts                  rank live (reads her list and the candidates' chats,
//                                                               one Sonnet call, about US$0.07), print it; sends nothing, saves nothing
//   node --env-file=.env scripts/call-list.ts --no-ai          ordered by list stage only (no model call)
//   node --env-file=.env scripts/call-list.ts --candidates     just who qualifies and why the rest don't (no model call)
//   node --env-file=.env scripts/call-list.ts --send-owner     as the first line, and send it to the owner as a preview
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import { gatherCallCandidates, runCallList } from '../lib/call-list.ts'
import { claudeClient } from '../lib/claude-usage.ts'

const has = (k: string) => process.argv.includes(`--${k}`)
const client = AD_CLIENTS.find((c) => c.ghl?.callList)
if (!client) throw new Error('no client with a call list')
const db = createClient((process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''), (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(), {
  auth: { persistSession: false },
})
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

if (has('candidates')) {
  const t0 = Date.now()
  const g = await gatherCallCandidates({ client, db, chats: false })
  console.log(`${g.candidates.length} decision-makers of ${g.counts.open} on her list (staff/other ${g.counts.staff}, no role ${g.counts.noRole}, paid tag ${g.counts.paid}) in ${Date.now() - t0}ms`)
  for (const c of g.candidates) console.log(`- ${c.name} · ${c.role} · ${c.industry ?? '?'} · ${c.stage} · ${c.why}`)
  process.exit(0)
}

const key = process.env.ANTHROPIC_API_KEY?.trim()
const anthropic = !has('no-ai') && key ? claudeClient('call-list', { apiKey: key }) : null
const t0 = Date.now()
const r = await runCallList({ client, db, anthropic, to: has('send-owner') ? 'owner' : 'none', dry: true, deadline: Date.now() + 280_000 })
console.log(plain(r.text ?? ''))
console.log(`\n— ranking: ${r.ranking} · ${Date.now() - t0}ms · sent to: ${r.sentTo.length ? r.sentTo.length + ' chat(s)' : 'nobody'}${r.error ? ` · note: ${r.error}` : ''}`)
