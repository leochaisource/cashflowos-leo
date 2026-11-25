// Check a Telegram webhook's health. Usage: npm run webhook:info [-- firstin5]
// Look at "last_error_message" — that's what tells you WHY the bot is silent.
const bot = (process.argv[2] || 'oyen').toLowerCase()
const envName = bot === 'firstin5' ? 'FIRSTIN5_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'
const token = process.env[envName]?.trim()
if (!token) {
  console.error(`Missing ${envName} in .env.`)
  process.exit(1)
}
const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
const body = await res.json()
console.log(JSON.stringify(body.result ?? body, null, 2))
if (body.result?.last_error_message) {
  console.log(`\n⚠️ Last error: ${body.result.last_error_message}`)
}
