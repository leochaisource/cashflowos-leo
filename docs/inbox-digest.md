# 📬 Inbox Digest + 💼 Job Shortlist (runs on your laptop)

Your inbox gets ~39 threads a day and only ~1 in 65 is from a real person. This setup:

1. **Filters** the noise out of the inbox as it arrives (labels, nothing deleted).
2. **Saturday 09:00:** Claude on your laptop reads the week's Gmail (read-only) and sends **one digest** to
   your Telegram, plus a ✅/❌ card for each job worth applying to.
3. **Sunday 10:00:** Claude applies to the jobs you ✅'d, in your own Chrome, then sends what it did.

```
Gmail filters (instant)    → noise labelled + archived; people / leads / money stay in the Inbox
Sat 09:00  /inbox-digest   → reads Gmail → npm run inbox -- digest     (Telegram)
                                         → npm run inbox -- shortlist  (✅/❌ cards)
You tap ✅                  → Jarvis (your Vercel app) marks the job QUEUED — nothing is submitted
Sun 10:00  /apply-jobs     → npm run inbox -- approved → applies in Chrome → npm run inbox -- result
```

Everything uses the keys already in your project's `.env` (`TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). **No new passwords and no Vercel settings.**

After the filters, what stays in your inbox is about **6 threads a day** (was ~39; measured on 5 Jul – 3 Oct 2026):
real people, **Leads** (ABC SalesBot hand-offs, Calendly bookings), **Money** (failed payments, bills, invoices)
and **Account alerts** (new GHL admins, Meta ad-account reviews, workflow errors).

---

## One-time setup (≈15 min)

### 1 · Gmail filters
1. Gmail → ⚙️ → **See all settings** → **Filters and Blocked Addresses** → **Import filters**.
2. Choose [`docs/gmail/mailFilters.xml`](gmail/mailFilters.xml) → **Open file** → **Create filters**.
3. **Leave "Apply new filters to existing email" UNTICKED.**

Gmail creates the labels: `Jobs`, `Jobs/Action`, `Tools`, `Tools/Wordfence`, `Newsletters`, `Shopping`,
`Education-MBA`, `Social media` (archived) and `Leads` ⭐, `Money`, `Account alerts` (**kept in the inbox**).
Job replies that mention interview / assessment / next steps / offer stay in the inbox under `Jobs/Action` ⭐.
(Gmail refused filters labelled `Social` and `Promos` — they clash with its own tab names — hence `Social media` and `Shopping`.)

### 2 · Archive old noise (older than 30 days)
Paste into Gmail search → tick the select-all box → **Select all conversations that match this search** → **Archive**:
```
in:inbox older_than:30d {category:promotions category:social category:updates} -from:(abcsalesbot.com OR calendly.com OR stripe.com OR acct-mgmt.com OR claudemalaysia.com)
```
Nothing is deleted. It's all still in **All Mail**.

### 3 · Check the laptop is connected
Claude Desktop → **Code** → open your `cashflowosai` folder → say: *"pull the latest main and run `npm run inbox -- check`"*.
Every line should be ✅. Any ❌ line tells you exactly which key is missing from `.env` and where to copy it from.

### 4 · Create two Local routines
Claude Desktop → **Routines** → **New routine** → **Local**:

| | Inbox digest | Apply to jobs |
|---|---|---|
| Schedule | Weekly · **Saturday 09:00** | Weekly · **Sunday 10:00** |
| Working folder | your `cashflowosai` folder | your `cashflowosai` folder |
| Instructions | `/inbox-digest` | `/apply-jobs` |
| Permission mode | **Auto** | **Auto** |
| Chrome | not needed | **on** |

Then click **Run now** on "Inbox digest" once. When Claude asks for permission (e.g. to read Gmail), choose
**always allow**, so future Saturdays run on their own. The digest and job cards should land in Telegram.

### 5 · Keep it awake
Claude Desktop → Settings → This computer → **Keep computer awake**. Leave the laptop open and plugged in on
weekend mornings. If it's closed at 09:00, the run happens **once** the next time you open it (within 7 days).

### 6 · Before the first Sunday
- Copy [`profile/job-profile.example.md`](../profile/job-profile.example.md) to `profile/job-profile.md` and fill it in
  (it's gitignored and never committed). Claude answers application forms **only** from this file.
- Be logged in to LinkedIn, JobStreet, Indeed and Glassdoor in Chrome.
- Watch the first Sunday run. If Chrome can't connect inside the scheduled run, just type `/apply-jobs` yourself
  in a Claude Code session with Chrome on. It does the same thing.

---

## The `npm run inbox` commands

| Command | What it does |
|---|---|
| `check` | Checks the 4 `.env` keys, your bot, your chat and the database. Prints names only, never values. |
| `digest <file.json>` | `{key, title, sections:[{heading, lines[]}]}` → your Telegram. HTML-safe, split into parts if long, **sent once per `key`** (a failed send can be re-run). |
| `shortlist <file.json>` | `{jobs:[{id,title,company,location,url,source,why}]}` (≤15) → one ✅/❌ card each, valid 7 days, never sent twice for the same job. |
| `approved` | JSON list of jobs you ✅'d that haven't been applied to yet. |
| `result <id> <applied\|needs_you\|failed\|skipped> "note"` | Takes a job off the queue (once). |

Digests and job cards show up in the app under **Approvals → History**, and each run is logged in Activity.
Tapping ✅ only queues a job (*"🗓 Queued — Claude applies on Sunday…"*); nothing is submitted before Sunday.

## Changing it later
- **A noisy sender slipped through?** The digest's 🧹 section lists them. Add the sender to the right group in
  `docs/gmail/mailFilters.xml` and re-import, or use Gmail's "Filter messages like these" → Skip Inbox + label.
- **Job criteria or digest sections:** edit [`.claude/commands/inbox-digest.md`](../.claude/commands/inbox-digest.md).
- **Application rules:** edit [`.claude/commands/apply-jobs.md`](../.claude/commands/apply-jobs.md).
- **Run it any time:** type `/inbox-digest` or `/apply-jobs` in a Claude Code session in this folder.
