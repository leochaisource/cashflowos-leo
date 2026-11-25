# Firstin5 AI: the bot your clients see

Built 2026-11-26. SFAiOyen (@SFAiOyen_bot) stays your own bot: Jarvis, your briefs, Claude Malaysia's
group and Ariella. **Firstin5 AI** is a second Telegram bot in the same app, for every other client's
group. It runs on the same data, so it needs no new database, no new Vercel project and no new cron.

## What it does in a client's group

1. **8am numbers.** Each morning it posts that client's numbers block: spend, leads, cost per lead and
   sales or registrations, funnel by funnel. It's the same "numbers and nothing else" block Claude
   Malaysia's group gets. Competitor research, your share and internal notes never go to the group. You
   still get your own full brief from SFAiOyen, as before.
2. **Answers questions.** Anyone in the group can mention it (`@<bot> how many leads yesterday?`) or
   reply to one of its messages. It answers about that client only, from the same ad numbers Jarvis
   reads, in the language the question was asked (Traditional Chinese stays Traditional). It won't
   give advice on budgets or strategy. Anything it can't answer, it passes to you on SFAiOyen ("❓
   Starcity asked…") and tells the group it did. It answers up to 30 questions per group per day.
3. **Follow-ups.** A client with `bot: 'firstin5'` in `lib/ad-clients.ts` (Starcity and Mr Money Academy
   now) sends its follow-up person's messages (the hot list, the 9am call list, the coach, webinar
   reminders) from Firstin5 AI. Your copies still come from SFAiOyen. This needs the client's GHL
   follow-up setup first (see "Still to set up" below).

## What a group can never see

- Another client's data. Every tool call is fixed to the group's client in code, and a result naming
  another project is thrown away.
- Competitors, people's names and phone numbers, your share, your records, invoices or tasks.
- Raw errors. If something breaks, the group gets one short line and you get the question.

## One-time setup (Leo)

1. **Create the bot.** In Telegram, open @BotFather → `/newbot` → name `Firstin5 AI` → pick a username
   ending in `bot` (for example `Firstin5AI_bot`). Copy the token.
2. **Add two values** to `cashflowos-leo/.env` and to Vercel (Settings → Environment Variables):
   - `FIRSTIN5_BOT_TOKEN`: the token from step 1.
   - `FIRSTIN5_WEBHOOK_SECRET`: a long random string you invent (not the SFAiOyen one).
   Then redeploy.
3. **Point Telegram at the app:**
   `npm --prefix cashflowos-leo run webhook:set -- https://cashflowos-leo.vercel.app firstin5`
   It should print `✅ Webhook set` and `✅ Group menu set`. Check it any time with
   `npm --prefix cashflowos-leo run webhook:info -- firstin5`.
4. **Message the bot privately** and send `/start`. It should list "Linked groups: None yet."

## Adding a client group

1. Create the Telegram group with the client's people and add Firstin5 AI.
2. It greets you with the command to send. Send `/link@<bot> starcity-global` (or the client's id from
   the list it shows). It confirms: "This group is now Starcity Global's."
3. The numbers start the next morning at 8am. Only you can `/link` or `/unlink`; a client who tries
   gets "Only Leo can do that here."

If the group is later upgraded to a supergroup (Telegram does this on its own for big groups), the bot
moves the link to the new id. If someone removes the bot, the link is dropped and SFAiOyen tells you.
If a morning's numbers fail to reach a group, the 9am watchdog says which group.

## Still to set up, per client

- **Mr Money Academy:** no ad account is connected yet, so there are no numbers to post. The group
  will start getting them once `MRMONEY_META_ACCESS_TOKEN` and `MRMONEY_META_AD_ACCOUNT_ID` are set.
- **The Nuggets Academy (Sandra):** not an ad client yet. It needs an entry in `lib/ad-clients.ts` (its
  Meta ad account, lead event and, if it uses GHL, its funnels) and a place on the focus list (the 8am
  brief runs only for focus clients).
- **Hot-lead follow-ups for any of them:** the client's follow-up person (name, GHL user id), their GHL
  pipeline, and their Telegram id. They message Firstin5 AI privately and it tells them the number to
  send you. Claude Malaysia's `ghl.followupAssignee` and `hotList` are the model to copy.

## Files

| What | Where |
|---|---|
| Group links, client Q&A, safety rules | `lib/firstin5.ts` |
| Webhook (`/link`, `/unlink`, questions) | `app/api/telegram/firstin5/route.ts` |
| Two-bot Telegram helper | `lib/telegram.ts` (`bot: 'firstin5'`) |
| 8am numbers to linked groups | `app/api/cron-ads/route.ts` (`firstin5GroupsFor`) |
| Which bot a client's people hear from | `lib/ad-clients.ts` (`bot`) |
| Where the links are stored | `records` row, category `_setting`, title `firstin5_groups` |
