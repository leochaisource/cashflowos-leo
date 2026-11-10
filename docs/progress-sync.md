# Client progress: how it works and how to set it up

The Command Centre keeps each client's progress and to-dos current on its own, from four places:

| Where you work | How it reaches the dashboard |
|---|---|
| Claude Code (the Code tab) | claude-mem summarises each session on the laptop. A scheduled task sends the last week of summaries every 30 minutes; Claude sorts each session to a client (or to none). |
| claude.ai chats and Cowork | The "SpeakFunnels dashboard" connector. A chat logs what got done and the next to-dos when you say "log this", or at the end of client work. |
| Telegram | Text the bot "done: …" (logs progress), "tick: …" (ticks a to-do), "todo: … by Friday" (adds one). |

You see it in three places:
- the **9am Today message** on Telegram, every day, to you only;
- each client's **8am brief**, with their own lines;
- the dashboard: the **Today** band on Home, and **Next steps** plus **Progress** on each client's page.

**Rules:**
- **Clients only.** Your job hunt, LinkedIn, Firstin5, and work on the dashboard itself are skipped. Dashboard work that changes what one client gets counts for that client.
- **To-dos Claude adds** carry a "from Claude" label.
  - Claude ticks off only to-dos it added itself. For yours it asks "Looks done?" in the Today message.
  - ✕ removes any to-do (it isn't marked done), and "Show done" brings it back.
- **Old to-dos:** a Claude to-do with no date is listed on Mondays under "Still relevant?" and closes after 28 days untouched.
- **Never stored:** raw session summaries and chat text. Only the short lines are kept.

## One-time setup

1. **Vercel:**
   - In the `cashflowos-leo` project, go to Settings → Environment Variables.
   - Add `PROGRESS_SECRET` and `MCP_CONNECTOR_KEY` (Production). Copy the values from `cashflowos-leo/.env`.
   - Redeploy. An env change only reaches a new deployment.
2. **Laptop task:** in PowerShell, from the `cashflowos-leo` folder, run:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\progress-sync-task.ps1
   ```

   This creates the "SpeakFunnels progress sync" task in Task Scheduler and runs it once. To check it: in Task Scheduler, the task's **Last Run Result** should be `0x0`, and `%LOCALAPPDATA%\SpeakFunnels\progress-sync.log` gets a line every run.
3. **claude.ai connector:**
   - Go to Customize → Connectors → **+ Add** → **Add custom connector**.
   - Name: `SpeakFunnels dashboard`. URL: `https://cashflowos-leo.vercel.app/api/mcp/` followed by the `MCP_CONNECTOR_KEY` value from `.env`.
   - Authentication: **No sign-in**.
   - Open the connector and click **Allow always** for its tools.
   - Cowork uses the same connector automatically.
4. **One line in your claude.ai preferences** (Settings → your preferences), and the same in Cowork's instructions:
   > When we finish work that moves one of my clients forward, or when I say "log this", use the
   > SpeakFunnels dashboard tools to log what got done and the next to-dos.

**The connector URL is a password:** anyone who has it can add to-dos to your dashboard. If it leaks:
1. Put a new `MCP_CONNECTOR_KEY` in `.env` and Vercel.
2. Redeploy.
3. Re-add the connector.

## For Claude: commands

```
node --env-file=.env scripts/progress-sync.ts --print          # what the laptop would send (no network)
node --env-file=.env scripts/progress-sync.ts --dry --flush    # the live server sorts, writes nothing
node --env-file=.env scripts/today-preview.ts --client=<id>    # the Today message + 8am lines, not sent
```

Code: `lib/progress.ts` (log, to-dos, digest, renderers), `lib/progress-sort.ts` (the sorter, Haiku 5.5),
`lib/mcp-progress.ts` + `app/api/mcp/[key]/route.ts` (connector), `app/api/progress/route.ts`,
`app/api/cron-daily/route.ts` (Today message). Tables: `supabase/progress.sql`.
