import { after } from 'next/server'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { sendMessage, sendTyping, botUsername } from '@/lib/telegram'
import { bumpDailyCounter } from '@/lib/bot-memory'
import { klToday } from '@/lib/format'
import { getProject, matchProject } from '@/lib/ad-clients'
import { activeProjects } from '@/lib/settings'
import {
  FIRSTIN5_NAME,
  answerClientQuestion,
  linkForChat,
  linkGroup,
  loadGroupLinks,
  moveGroup,
  plainText,
  tgSafe,
  unlinkGroup,
} from '@/lib/firstin5'

// FIRSTIN5 AI's webhook (owner, 2026-11-26). The client-facing bot; the design
// is in lib/firstin5.ts. It lives under /api/telegram/ so proxy.ts already lets
// Telegram reach it without the dashboard login, and it checks its OWN secret
// header (FIRSTIN5_WEBHOOK_SECRET), set with `npm run webhook:set -- <url> firstin5`.
//
// Who can do what:
//   • the owner (OWNER_CHAT_ID): /link, /unlink, /chatid in a group; /start privately lists the links;
//   • anyone in a LINKED group: @mention the bot (or reply to it) with a question
//     about that group's client, up to DAILY_CAP a day per group;
//   • anyone else, anywhere: a polite line, no model call, no data.
// In a group it only reacts when spoken to, so ordinary chat costs nothing.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BOT = 'firstin5' as const
const DAILY_CAP = 30

const owner = () => (process.env.OWNER_CHAT_ID || '').trim()
const isOwner = (id: unknown) => !!owner() && String(id) === owner()
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ok = () => Response.json({ ok: true })

// A plain "the webhook is reachable" answer, nothing about the setup.
export async function GET() {
  return ok()
}

/**
 * Telegram retries a webhook it didn't get a fast 200 for, so every update is
 * claimed once in tg_updates. Update ids are counted per bot, so Firstin5 AI's
 * are stored NEGATIVE: they can never collide with SFAiOyen's in the same table.
 */
async function isFreshUpdate(updateId: unknown): Promise<boolean> {
  if (!supabaseConfigured || updateId == null || !Number.isFinite(Number(updateId))) return true
  const { data, error } = await supabase
    .from('tg_updates')
    .upsert({ update_id: -Math.abs(Number(updateId)) }, { onConflict: 'update_id', ignoreDuplicates: true })
    .select()
  if (error) {
    console.error('[CFO] firstin5 tg_updates dedupe failed (proceeding):', error.message)
    return true // never let a dedupe hiccup drop a real message
  }
  return !!(data && data.length)
}

export async function POST(req: Request) {
  const secret = process.env.FIRSTIN5_WEBHOOK_SECRET?.trim()
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('forbidden', { status: 401 })
  }
  const update = await req.json().catch(() => ({}))
  if (!(await isFreshUpdate(update?.update_id))) return Response.json({ ok: true, deduped: true })

  if (update.my_chat_member) return handleMembership(update.my_chat_member)
  if (update.message) return handleMessage(update.message)
  return ok() // edits, button taps, reactions: nothing to do
}

const reply = (chatId: number | string, text: string, replyTo?: number) =>
  sendMessage(chatId, text, { bot: BOT, noPreview: true, replyTo })

/** "/link@Firstin5AI_bot starcity" → { name: 'link', args: 'starcity' }. A command for another bot → null. */
function parseCommand(text: string, username: string | null): { name: string; args: string } | null {
  const m = text.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i)
  if (!m) return null
  if (m[2] && (!username || m[2].toLowerCase() !== username.toLowerCase())) return null
  return { name: m[1].toLowerCase(), args: (m[3] ?? '').trim() }
}

async function clientChoices(): Promise<string> {
  const pool = await activeProjects()
  return pool.map((p) => `• <code>${esc(p.id)}</code> ${esc(p.name)}`).join('\n')
}

// ============================================================ added / removed
async function handleMembership(m: any): Promise<Response> {
  const chat = m.chat
  const status: string = m.new_chat_member?.status ?? ''
  const isGroup = chat?.type === 'group' || chat?.type === 'supergroup'
  if (!isGroup) return ok()
  const title = String(chat.title ?? 'this group')

  if (status === 'member' || status === 'administrator') {
    // Only greet when the owner added it: anyone can add a bot to a random group.
    if (!isOwner(m.from?.id)) return ok()
    const link = await linkForChat(String(chat.id)).catch(() => null)
    if (link) return ok() // re-added to a group it already knows
    const username = await botUsername(BOT)
    await reply(
      chat.id,
      `👋 Hi, I'm <b>${FIRSTIN5_NAME}</b>.\n\n` +
        `Leo, connect this group to a client by sending:\n<code>/link${username ? `@${esc(username)}` : ''} &lt;client&gt;</code>\n\n` +
        `Clients:\n${await clientChoices()}`,
    )
    return ok()
  }

  if (status === 'left' || status === 'kicked') {
    const gone = await unlinkGroup(String(chat.id)).catch(() => null)
    const o = owner()
    if (gone && o) {
      const name = getProject(gone.clientId)?.name ?? gone.clientId
      await sendMessage(
        o,
        `ℹ️ ${FIRSTIN5_NAME} was removed from <i>${esc(title)}</i>, so ${esc(name)}'s 8am numbers stop going there. ` +
          `Add it back and send /link to restart them.`,
      ).catch(() => {})
    }
  }
  return ok()
}

// ============================================================ messages
async function handleMessage(msg: any): Promise<Response> {
  const chatId = msg.chat?.id
  const type = msg.chat?.type
  const isGroup = type === 'group' || type === 'supergroup'
  const from = msg.from?.id
  const text: string = (msg.text || '').trim()

  // A group turned supergroup: same group, new id. Keep its link.
  if (msg.migrate_to_chat_id) {
    await moveGroup(String(chatId), String(msg.migrate_to_chat_id)).catch((e) =>
      console.error('[CFO] firstin5 group move failed:', e),
    )
    return ok()
  }

  if (!isGroup) return handlePrivate(msg)
  if (!text) return ok()

  const username = await botUsername(BOT)
  const cmd = parseCommand(text, username)
  const mentioned = !!username && text.toLowerCase().includes(`@${username.toLowerCase()}`)
  const repliedToMe =
    msg.reply_to_message?.from?.is_bot === true &&
    !!username &&
    String(msg.reply_to_message.from.username ?? '').toLowerCase() === username.toLowerCase()

  if (cmd) return handleCommand(msg, cmd, username)
  if (!mentioned && !repliedToMe) return ok() // not spoken to: stay quiet, spend nothing

  const link = await linkForChat(String(chatId)).catch(() => null)
  if (!link) {
    if (isOwner(from))
      await reply(chatId, `This group isn't linked to a client yet. Send <code>/link &lt;client&gt;</code>:\n${await clientChoices()}`)
    return ok()
  }
  const project = getProject(link.clientId)
  if (!project) {
    if (isOwner(from)) await reply(chatId, `This group is linked to <code>${esc(link.clientId)}</code>, which isn't a client any more. Send /link again.`)
    return ok()
  }

  // Cost guard, per group per KL day. One "that's it for today" line, then silence.
  const asked = await bumpDailyCounter(Number(chatId), 'firstin5_questions', klToday()).catch(() => 0)
  if (asked > DAILY_CAP) {
    if (asked === DAILY_CAP + 1)
      await reply(chatId, `That's ${DAILY_CAP} questions for today, so I'll pick up again tomorrow. Leo can still answer here.`, msg.message_id)
    return ok()
  }

  const question = username ? text.replace(new RegExp(`@${username}\\b`, 'ig'), '').trim() : text
  const askedBy = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Someone'
  const replyContext = repliedToMe ? String(msg.reply_to_message?.text ?? '') : undefined
  const groupTitle = String(msg.chat?.title ?? 'the group')

  // Ack fast, answer after: Telegram retries anything slower than a few seconds.
  after(async () => {
    await sendTyping(chatId, BOT).catch(() => {})
    const a = await answerClientQuestion({ project, question: question || text, askedBy, groupTitle, replyContext })
    const sent = await reply(chatId, tgSafe(a.text), msg.message_id)
    // Telegram refuses a reply with a tag it can't parse; send it plain instead.
    if (!sent.ok && /parse|entit|tag/i.test(sent.error ?? '')) await reply(chatId, plainText(a.text), msg.message_id)
    else if (!sent.ok) console.error('[CFO] firstin5 reply failed:', sent.error)
  })
  return ok()
}

async function handleCommand(msg: any, cmd: { name: string; args: string }, username: string | null): Promise<Response> {
  const chatId = msg.chat?.id
  const from = msg.from?.id
  const title = String(msg.chat?.title ?? 'this group')
  const ownerOnly = ['link', 'unlink', 'chatid']

  if (ownerOnly.includes(cmd.name) && !isOwner(from)) {
    await reply(chatId, `Only Leo can do that here.`, msg.message_id)
    return ok()
  }

  if (cmd.name === 'chatid') {
    await reply(chatId, `🆔 This ${esc(msg.chat?.type ?? 'group')} id is <code>${chatId}</code> (<i>${esc(title)}</i>).`)
    return ok()
  }

  if (cmd.name === 'link') {
    const pool = await activeProjects()
    if (!cmd.args) {
      await reply(chatId, `Which client is this group for? Send <code>/link &lt;client&gt;</code>:\n${await clientChoices()}`)
      return ok()
    }
    const { project, candidates } = matchProject(cmd.args, pool)
    if (!project) {
      const list = (candidates.length && candidates.length < pool.length ? candidates : pool)
        .map((p) => `• <code>${esc(p.id)}</code> ${esc(p.name)}`)
        .join('\n')
      await reply(chatId, `I couldn't tell which client "${esc(cmd.args)}" is. Use one of these ids:\n${list}`)
      return ok()
    }
    try {
      const { previous } = await linkGroup(String(chatId), project.id, title)
      const was = previous && previous.clientId !== project.id ? ` (it was ${esc(getProject(previous.clientId)?.name ?? previous.clientId)})` : ''
      const who = esc(project.client || project.name)
      await reply(
        chatId,
        `✅ This group is now <b>${who}</b>'s${was}.\n\n` +
          `• Every morning at about 8am I post ${who}'s ad numbers here.\n` +
          `• Anyone here can ask me about ${who}'s ads: mention me${username ? ` (@${esc(username)})` : ''} or reply to one of my messages.\n` +
          `• Questions I can't answer go straight to Leo.`,
      )
    } catch (e) {
      await reply(chatId, `⚠️ I couldn't save that link (${esc((e as Error).message)}). Nothing changed; try again in a minute.`)
    }
    return ok()
  }

  if (cmd.name === 'unlink') {
    try {
      const gone = await unlinkGroup(String(chatId))
      await reply(
        chatId,
        gone
          ? `Done. This group no longer gets ${esc(getProject(gone.clientId)?.name ?? gone.clientId)}'s numbers, and I won't answer questions here.`
          : `This group wasn't linked to a client.`,
      )
    } catch (e) {
      await reply(chatId, `⚠️ I couldn't change that (${esc((e as Error).message)}). Try again in a minute.`)
    }
    return ok()
  }

  if (cmd.name === 'start' || cmd.name === 'help') {
    const link = await linkForChat(String(chatId)).catch(() => null)
    const project = link ? getProject(link.clientId) : undefined
    if (project) {
      const who = esc(project.client || project.name)
      await reply(
        chatId,
        `🤖 <b>${FIRSTIN5_NAME}</b> for ${who}.\n\n` +
          `Every morning at about 8am I post ${who}'s ad numbers here. Ask me anything about them: mention me` +
          `${username ? ` (@${esc(username)})` : ''} or reply to one of my messages. For example:\n` +
          `• "How many leads yesterday?"\n• "What's our cost per lead this week?"\n• "Which ad is doing best?"\n\n` +
          `Anything that isn't in the numbers goes to Leo.`,
      )
    } else if (isOwner(from)) {
      await reply(chatId, `Not linked yet. Send <code>/link &lt;client&gt;</code>:\n${await clientChoices()}`)
    }
    return ok()
  }

  return ok() // some other bot's command, or one we don't have
}

async function handlePrivate(msg: any): Promise<Response> {
  const chatId = msg.chat?.id
  if (isOwner(msg.from?.id)) {
    let lines = ''
    try {
      const links = await loadGroupLinks()
      lines = links.length
        ? links.map((l) => `• ${esc(getProject(l.clientId)?.name ?? l.clientId)}: <i>${esc(l.title)}</i>`).join('\n')
        : '<i>None yet.</i>'
    } catch (e) {
      lines = `<i>Couldn't read them (${esc((e as Error).message)}).</i>`
    }
    const username = await botUsername(BOT)
    await reply(
      chatId,
      `👋 <b>${FIRSTIN5_NAME}</b>, the bot your clients see.\n\n<b>Linked groups</b>\n${lines}\n\n` +
        `<b>Add a client group</b>: create the group, add ${username ? `@${esc(username)}` : 'me'}, then send ` +
        `<code>/link &lt;client&gt;</code> in it. Its 8am numbers start the next morning.\n\n` +
        `You still get your own full brief from SFAiOyen, as before.`,
    )
    return ok()
  }
  // A client's team member, e.g. a follow-up person setting up their reminders.
  const name = esc(msg.from?.first_name ?? 'there')
  await reply(
    chatId,
    `Hi ${name}, I'm <b>${FIRSTIN5_NAME}</b>. I work inside your project's group with Leo: ask me there by mentioning me.\n\n` +
      `If Leo asked you to start me here for your follow-up list, send him this number: <code>${msg.from?.id}</code>`,
  )
  return ok()
}
