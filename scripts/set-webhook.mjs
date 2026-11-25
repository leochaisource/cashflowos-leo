// Set a Telegram webhook — works the same on Mac, Windows, and Linux (no curl).
// Usage:  npm run webhook:set -- https://YOUR-APP.vercel.app            (SFAiOyen, the owner's bot)
//         npm run webhook:set -- https://YOUR-APP.vercel.app firstin5   (Firstin5 AI, the clients' bot)
// Reads the bot's token + webhook secret from .env (via --env-file); never prints them.
const base = process.argv[2]
const bot = (process.argv[3] || 'oyen').toLowerCase()
const BOTS = {
  oyen: { token: 'TELEGRAM_BOT_TOKEN', secret: 'TELEGRAM_WEBHOOK_SECRET', path: '/api/telegram' },
  firstin5: { token: 'FIRSTIN5_BOT_TOKEN', secret: 'FIRSTIN5_WEBHOOK_SECRET', path: '/api/telegram/firstin5' },
}
const cfg = BOTS[bot]

if (!base || !cfg) {
  console.error('Usage: npm run webhook:set -- https://YOUR-APP.vercel.app [firstin5]')
  process.exit(1)
}
const token = process.env[cfg.token]?.trim()
const secret = process.env[cfg.secret]?.trim()
if (!token || !secret) {
  console.error(`Missing ${cfg.token} or ${cfg.secret} in .env — fill them in first.`)
  process.exit(1)
}

const url = `${base.replace(/\/+$/, '')}${cfg.path}`
const call = async (method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

// Firstin5 AI only needs messages and "I was added to / removed from a group".
const body = await call('setWebhook', {
  url,
  secret_token: secret,
  ...(bot === 'firstin5' ? { allowed_updates: ['message', 'my_chat_member'] } : {}),
})
console.log(body.ok ? `✅ Webhook set to ${url}` : `❌ Failed: ${body.description}`)
console.log(body)

if (body.ok && bot === 'firstin5') {
  // The "/" menu clients see in their group. /link and /unlink stay off it: they're Leo's.
  const menu = await call('setMyCommands', {
    commands: [{ command: 'help', description: 'What I can do in this group' }],
    scope: { type: 'all_group_chats' },
  })
  console.log(menu.ok ? '✅ Group menu set (/help)' : `⚠️ Menu not set: ${menu.description}`)
}
