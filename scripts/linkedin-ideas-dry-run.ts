// The Sunday LinkedIn Ideas check, by hand — the EXACT code the daily cron runs
// (agents/linkedin/run.ts), so what you see here is what Sunday sends.
//
//   node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts             today as the cron sees it (angles only on Sunday)
//   node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts --facts     also print the week's facts the model reads
//   node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts --sunday    pretend it's Sunday (one Claude call)
//   node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts --sunday --send [--one]
//        …and send the cards (or just the first) to YOUR Telegram as a test (keys end
//        "-test", so the real Sunday run still goes out). ✅ on a card queues it exactly like Sunday.
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { isIdeasDay, isoWeek } from '../agents/linkedin/definition.ts'
import { loadWeekFacts } from '../agents/linkedin/load.ts'
import { linkedinDrafts } from '../agents/linkedin/run.ts'

const has = (f: string) => process.argv.includes(f)
const now = new Date()
const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)
const key = process.env.ANTHROPIC_API_KEY?.trim()
const anthropic = key ? new Anthropic({ apiKey: key, timeout: 40_000, maxRetries: 0 }) : null

console.log(`Week ${isoWeek(now)} · ideas day (Sunday MYT): ${isIdeasDay(now) ? 'yes' : 'no'}${has('--sunday') ? ' · forced' : ''}`)

if (has('--facts')) {
  const f = await loadWeekFacts(db, now)
  console.log(`\n===== FACTS (${f.sections} sections${f.unavailable.length ? `, unreadable: ${f.unavailable.join('; ')}` : ''}) =====\n${f.text}\n`)
}

const t0 = Date.now()
const { drafts, notes } = await linkedinDrafts({ db, anthropic, now, forceIdeasDay: has('--sunday') })
console.log(`\n${drafts.length} card(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s${notes.length ? ` · ${notes.join(' · ')}` : ''}\n`)
for (const d of drafts) console.log(`--- ${d.idempotencyKey}\n${d.text.replace(/<[^>]+>/g, '')}\n`)

if (has('--send') && drafts.length) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const owner = process.env.OWNER_CHAT_ID?.trim()
  if (!token || !owner) throw new Error('TELEGRAM_BOT_TOKEN / OWNER_CHAT_ID missing in .env')
  let sent = 0
  // --one: a single card is enough to test the ✅ → queue round trip.
  for (const d of has('--one') ? drafts.slice(0, 1) : drafts) {
    // Same as proposeAndNotify() in lib/actions.ts: propose once, send buttons, remember the message.
    const testKey = d.idempotencyKey.replace(/^(linkedin-ideas:[^:]+)/, '$1-test')
    const { data: rows, error } = await db
      .from('agent_actions')
      .upsert(
        {
          agent_key: 'linkedin-ideas',
          idempotency_key: testKey,
          payload: d.payload,
          status: 'proposed',
          proposed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      )
      .select()
    if (error) throw new Error(`propose failed: ${error.message}`)
    const row = rows?.[0]
    if (!row) {
      console.log(`(already sent: ${testKey})`)
      continue
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: owner,
        text: `🧪 TEST\n${d.text}`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `apr:${row.id}` }, { text: '❌ Reject', callback_data: `rej:${row.id}` }]] },
      }),
    })
    const body: any = await res.json().catch(() => ({}))
    if (body?.ok) {
      await db.from('agent_actions').update({ notify_chat_id: Number(owner), notify_message_id: body.result.message_id }).eq('id', row.id)
      sent++
    } else console.log(`(card didn't send: ${body?.description ?? res.status})`)
  }
  console.log(`✅ ${sent} test card(s) sent to your Telegram.`)
}
