---
description: "Saturday inbox digest — read the week's Gmail (read-only), post one summary + job cards to your Telegram."
---

# /inbox-digest — the week in one Telegram message

You are running on the owner's laptop, inside their CashFlowOS folder, usually from the
Saturday "Inbox digest" routine. Read the last 7 days of Gmail, write ONE digest, pick the
jobs worth applying to, and send both with `npm run inbox`.

## Hard rules
- **Gmail is read-only.** Only search and read. Never send, reply, forward, draft, trash,
  archive, mark as spam or change labels. Never click or open links inside emails.
- Never put phone numbers, other people's email addresses, passwords, codes or card
  numbers in the digest. First names and company names are fine.
- If the Gmail connector isn't available, stop and say so (log in to Claude with your
  subscription account; connectors load automatically).

## 1 · Read the week
Use the Gmail connector's thread search with `newer_than:7d` (page through all results).
Subject + sender is enough for most mail. Open full threads (plain text) only for:
- inbox threads from real people (not automated senders);
- `label:Leads`, `label:Money`, `label:"Account alerts"`, `label:Jobs/Action`;
- the job-alert emails you take jobs from, and `label:Education-MBA`.

## 2 · Write the digest
One line per item, newest first, ≤160 characters each. These sections, in this order:
1. **🔴 Needs you**: real people waiting on a reply (who, what they want, how many days);
   ABC SalesBot hand-offs (the lead's first name + their question); Calendly bookings or
   cancellations; failed or declined payments; bills or invoices due; account and security
   changes (new admins, disabled ad accounts, workflow errors, unexpected logins). If none:
   "Nothing urgent 🎉".
2. **💼 Jobs**: "<N> alerts this week, <M> cards sent below", plus any `Jobs/Action` replies
   (interview, assessment, next steps) with their deadlines.
3. **🎓 MBA & programmes**: the owner IS looking. Programmes, intakes, deadlines, fee waivers,
   info sessions, grouped by school, with dates.
4. **🛠 Tools**: counts per tool, plus anything that ISN'T marketing (an error, an expiry, a
   price change). "GHL marketing: N emails, nothing to act on" is fine.
5. **📰 Newsletters**: the 3 most useful ideas across all newsletters this week, with source.
6. **🛍 Promos & social**: counts only, plus a genuinely good deal if there is one.
7. **🧹 New noisy senders**: automated senders that landed in the INBOX this week with ≥2
   emails and no label. Suggest a label for each, so `docs/gmail/mailFilters.xml` can be
   updated.

## 3 · Pick the jobs (max 10)
From this week's job alerts (LinkedIn, JobStreet, Indeed, Glassdoor, JobLeads, company
career sites), de-duplicate the same role across sites and keep only roles that match ALL of:
- senior marketing / growth leadership (manager, head, lead, director: marketing, growth,
  brand, performance, digital, GTM), **or** an AI / automation / martech role where Claude,
  GoHighLevel and automation work is the selling point;
- based in Malaysia (KL / Selangor) or Singapore;
- posted within the last 14 days.

For each job: a stable `id` (e.g. `linkedin:<job id from the URL>`), `title`, `company`,
`location`, the https `url` of the posting itself (avoid tracking redirects when you can),
`source`, and a one-line `why` naming the criteria it matches.

## 4 · Send
Create the folder `.inbox/` if it's missing (it's gitignored). Write:
- `.inbox/digest.json` → `{"key":"<ISO year>-W<ISO week>","title":"Inbox · week of <d Mon>","sections":[{"heading":"🔴 Needs you","lines":["…"]}, …]}`
- `.inbox/jobs.json` → `{"jobs":[{"id":"…","title":"…","company":"…","location":"…","url":"https://…","source":"…","why":"…"}]}`

Then run:
```
npm run inbox -- digest .inbox/digest.json
npm run inbox -- shortlist .inbox/jobs.json
```
Skip `shortlist` if there are no jobs. Finish with one short line per command saying what
happened. If a command fails, show its message as-is (it explains what to fix) and retry
at most once.
