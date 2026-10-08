# ✍️ LinkedIn Ideas: the four knobs

| Knob | Setting | Where |
|---|---|---|
| 👉 **WHEN** | Swept by the daily 9am cron. Angles go out on **Sunday (MYT)** only; a failed-post alert can go out any day | `definition.ts` → `IDEAS_WEEKDAY` |
| 👉 **LOOK AT** | The last 7 days: morning ads briefs, event sales vs target, agent recommendations you approved or rejected, agent run counts, and new competitor positioning. Failed posts are read from your own GHL sub-account | `load.ts` |
| 👉 **SUGGEST** | Up to 5 angles (a hook plus one line), each passing the hook gate (a number and a visual), each a different hook type, and flagged when built on client data | `prompt.ts` |
| 👉 **ASK-BEFORE** | Always 🟡. ✅ only **queues** an angle; nothing is written or posted from here | `definition.ts` → `askBefore` |

## The loop

1. **Sunday 9am:** 3–5 cards arrive on Telegram. Tap ✅ on the ones worth writing.
2. **On your laptop:** run `/linkedin-posts` and pick Mode E. It reads the queue (`npm run linkedin -- ideas`), drafts 3 versions of each angle in your voice, and you approve them.
3. **The skill schedules them** for Tue/Wed/Thu 09:00 through your own GHL (`npm run linkedin -- schedule …`).
4. **If a post fails to publish**, a ⚠️ card arrives the next morning.

## Try it without waiting for Sunday

```bash
node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts --sunday --facts
node --env-file-if-exists=.env scripts/linkedin-ideas-dry-run.ts --sunday --send --one
```
