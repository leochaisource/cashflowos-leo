// 🔒 Don't edit — this keeps your robot safe.
// Minimal Telegram helpers. Read the bot token from env at call time (never
// inline it on a command line). Safe to call even before the token is set — they
// just no-op with a warning so the app doesn't crash.

const api = (method: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  return token ? `https://api.telegram.org/bot${token}/${method}` : null
}

const TIMEOUT_MS = 15000

// Every Bot API call goes through here: a 15s limit and two retries. Without
// them a Telegram hiccup at 8am silently lost that message, and a hung call held
// the whole cron until Vercel's limit. Retries happen only when Telegram did not
// act: a 429 (wait the retry_after it asks for, up to 10s), a 5xx, or a
// connection that never opened. A timeout is NOT retried: the message may have
// landed, and a brief sent twice to a client's group is worse than a logged miss.
// Never throws.
async function call(method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
  const url = api(method)
  if (!url) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  let error = 'unknown'
  let wait = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok) return { ok: true, result: body.result }
      error = String(body.description || res.status)
      // A bad chat id or a bot removed from the group fails the same way again.
      wait = res.status === 429 ? Number(body.parameters?.retry_after ?? 1) * 1000 : res.status >= 500 ? 1000 * 2 ** (attempt + 1) : 0
      if (!wait || wait > 10_000) return { ok: false, error }
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') return { ok: false, error: `timed out after ${TIMEOUT_MS / 1000}s` }
      error = (e as Error).message
      wait = 1000 * 2 ** (attempt + 1)
    }
  }
  return { ok: false, error }
}

// ------------------------------------------------------------
// getFilePath() — step 1 of downloading a Telegram file (photo/PDF the user sent).
// Telegram gives you a file_id in the update; you ask getFile for a temporary
// file_path, then download it (step 2) — that path expires in ~1 hour, so the
// Vault pipeline downloads immediately. Returns null (never throws) so the caller
// can reply calmly if the token isn't set or Telegram says no.
// ------------------------------------------------------------
export async function getFilePath(
  fileId: string,
): Promise<{ file_path: string; file_size?: number } | null> {
  if (!api('getFile')) return null
  const r = await call('getFile', { file_id: fileId })
  if (!r.ok || !r.result?.file_path) {
    console.error('[CFO] getFile failed:', r.error ?? 'no file_path')
    return null
  }
  return { file_path: r.result.file_path, file_size: r.result.file_size }
}

// ------------------------------------------------------------
// downloadFileBytes() — step 2: pull the actual bytes for a file_path from getFile.
// Returns a Buffer (or null on any error). Used by the Vault agent to hash + read +
// upload the receipt. Never throws.
// ------------------------------------------------------------
export async function downloadFileBytes(filePath: string): Promise<Buffer | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) {
      console.error('[CFO] file download failed:', res.status)
      return null
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    console.error('[CFO] file download threw:', e)
    return null
  }
}

// A single inline-keyboard button. `callback_data` is what the webhook receives
// when the user taps it — e.g. "apr:42" (approve action 42) / "rej:42".
export type InlineButton = { text: string; callback_data: string }
export type InlineKeyboard = InlineButton[][]

/**
 * The bot's own @username, fetched once and kept for the life of the instance.
 * Needed to tell "someone mentioned me in a group" from ordinary chatter; a
 * getMe call per message would be a round trip for a value that never changes.
 */
let cachedUsername: string | null | undefined
export async function botUsername(): Promise<string | null> {
  if (cachedUsername !== undefined) return cachedUsername
  const url = api('getMe')
  if (!url) return (cachedUsername = null)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } }
    cachedUsername = json.ok && json.result?.username ? json.result.username : null
  } catch {
    cachedUsername = null // a failed lookup must not block a message
  }
  return cachedUsername
}

/**
 * Send one message. Returns whether it actually landed.
 *
 * It used to swallow failures into a console log, which is fine for a chat reply
 * and quietly wrong for a scheduled brief: a bot removed from a group, or a
 * mistyped group id, would produce a run that reported "sent" while nobody
 * received anything. The caller now gets the truth and can say so.
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  // A link to the dashboard would otherwise unfurl into a preview of the login page.
  opts: { noPreview?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!api('sendMessage')) {
    console.warn('[CFO] TELEGRAM_BOT_TOKEN not set yet — skipping sendMessage.')
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  }
  const r = await call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(opts.noPreview ? { link_preview_options: { is_disabled: true } } : {}),
  })
  if (!r.ok) {
    console.error('[CFO] Telegram sendMessage failed:', r.error)
    return { ok: false, error: r.error }
  }
  return { ok: true }
}

// Send a message with Approve/Reject (or any) inline buttons. RETURNS the sent
// message_id so the caller can store it on the agent_actions row — the in-app
// approve path needs it to strip these same buttons via editMessageReplyMarkup.
// Returns null if the send failed or the token isn't set (caller degrades calmly).
export async function sendWithButtons(
  chatId: string | number,
  text: string,
  inlineKeyboard: InlineKeyboard,
): Promise<number | null> {
  if (!api('sendMessage')) {
    console.warn('[CFO] TELEGRAM_BOT_TOKEN not set yet — skipping sendWithButtons.')
    return null
  }
  const r = await call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inlineKeyboard },
  })
  if (!r.ok) {
    console.error('[CFO] Telegram sendWithButtons failed:', r.error)
    return null
  }
  return r.result?.message_id ?? null
}

// Acknowledge a button tap so Telegram stops the little spinner on the user's
// button. Optional toast text. Never throws.
export async function answerCallbackQuery(callbackId: string, text?: string) {
  if (!api('answerCallbackQuery')) return
  const r = await call('answerCallbackQuery', { callback_query_id: callbackId, text: text ?? '' })
  if (!r.ok) console.error('[CFO] answerCallbackQuery failed:', r.error)
}

// Strip (or replace) the inline buttons on an already-sent message. Pass no
// keyboard to remove them entirely — used after an action is decided so the same
// message can't be tapped twice. UX only; the CAS claim is the real guarantee.
export async function editMessageReplyMarkup(
  chatId: string | number,
  messageId: number,
  keyboard?: InlineKeyboard,
) {
  if (!api('editMessageReplyMarkup')) return
  const r = await call('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : {},
  })
  // "message is not modified" = the buttons were already gone, which is the goal.
  if (!r.ok && !/not modified/i.test(r.error ?? '')) console.error('[CFO] editMessageReplyMarkup failed:', r.error)
}
