# SOP: Job hunting from the email inbox (scan → shortlist → approve → apply)

**Owner:** Leo Chai
**Handed over:** 8 Oct 2026, from the CashFlowOS assistant to the job-hunting bot
**Status:** CashFlowOS no longer shortlists or applies to jobs. This document is everything it did, so the job bot can take over without gaps.

---

## 0. What the job is, in one paragraph

Once a week, read Leo's Gmail (read-only), collect the job alerts and recruiter emails from the past 7 days, keep only roles that fit Leo's targets (§3), remove duplicates, and show Leo a short list (at most 10) with one approve/reject choice per job. Leo approves jobs one by one. Then apply to the approved jobs only, in Leo's own logged-in browser, using only facts from Leo's job profile, and report back what happened to each job. Interview and assessment emails are surfaced to Leo straight away; they are never answered by the bot.

```
Gmail (read-only) ─▶ find job emails ─▶ extract roles ─▶ filter + de-dup ─▶ ≤10 cards ─▶ Leo ✅/❌
                                                                                       │
                       report: applied / needs_you / failed / skipped ◀─ apply (approved only) ◀┘
```

---

## 1. Hard rules (never break these)

1. **Gmail is read-only.** Search and read only. Never send, reply, forward, draft, delete, trash, archive, mark as spam, mark read/unread or change labels.
2. **Never click links inside emails** while scanning. Take the job posting URL and open it later, only when applying.
3. **Never apply without Leo's explicit approval** for that specific job. Approval is per job; it doesn't carry over to other jobs.
4. **Answer application forms only from Leo's job profile** (§6). Never invent or stretch experience, titles, dates, salary, notice period, work authorisation, degrees or references. If something isn't in the profile, stop on that job and ask Leo (`needs_you`).
5. **Never pay for anything, never message recruiters, never edit Leo's profile on any site, never accept terms beyond the standard apply terms.**
6. **Privacy in anything you send Leo:** no phone numbers, no other people's email addresses, no passwords, codes or card numbers. Company names and first names are fine.
7. **Interview, assessment, "next steps" and offer emails are Leo's to answer.** Surface them with their deadline; never reply to them.

---

## 2. Where the job emails are (Gmail)

Leo's Gmail has filters that label job mail as it arrives (import file: `docs/gmail/mailFilters.xml` in the CashFlowOS repo). Two labels matter:

| Label | What's in it | Inbox? |
|---|---|---|
| `Jobs` | Job alerts and job-board mail, **except** subjects mentioning interview / assessment / next steps / shortlisted / invitation / offer | Archived (skips the inbox) |
| `Jobs/Action` ⭐ | Mail from applicant-tracking systems and recruiters (Workday, iCIMS, Greenhouse, SuccessFactors, Recruitee, Michael Page, Shopee/Grab/Singtel HR, LinkedIn recruiter replies) | Stays in the inbox, starred |

**Search used each week:** `newer_than:7d`, then page through all results. For jobs specifically:

- `label:Jobs newer_than:7d` (the alerts to pick roles from)
- `label:Jobs/Action newer_than:7d` (replies Leo must see)

**Job-alert senders** (in case the labels are missing): `jobalerts-noreply@linkedin.com`, `jobs-noreply@linkedin.com`, `jobs-listings@linkedin.com`, `hit-reply@linkedin.com`, `glassdoor.com`, `jobstreet.com`, `indeed.com`, `jobleads.com`, `flexjobs.com`, `michaelpage.com.sg`, `jobs2web.com`, `hiredly.com`, `ajobthing.email`, `randstad.com.sg`, `talentbank.group`, `wise.jobs`, plus company career sites (`careers.grab.com`, `hr.shopee.com`, `hr.singtel.com`, `jobalerts.abbott.com`, `recruitment.americanexpress.com`, …).

**Reading:** subject and sender are enough to classify most mail. Open the full thread (plain text) only for job alerts you take roles from and for `Jobs/Action` threads.

---

## 3. Shortlisting rules

From the week's job alerts (LinkedIn, JobStreet, Indeed, Glassdoor, JobLeads, company career sites), keep a role only if it matches **all three**:

1. **The role:** senior marketing or growth leadership (manager, head, lead or director of marketing, growth, brand, performance, digital or go-to-market), **or** an AI / automation / martech role where Leo's Claude, GoHighLevel and automation work is the selling point.
2. **Location:** Malaysia (Kuala Lumpur / Selangor) or Singapore.
3. **Recency:** posted within the last 14 days.

Then:

- **De-duplicate** the same role across sites (same company + same title, even if worded slightly differently). Keep the most direct posting. Mention the duplicate in `why` (e.g. "Also on Indeed").
- **At most 10 jobs per week.** If more qualify, keep the most senior and most AI-relevant first.
- Skip roles Leo has already been shown (same stable `id`, §4).

**Why these rules:** Leo runs a Malaysian ads agency and teaches Claude AI workshops (Claude Malaysia). His strongest pitch is hands-on AI / automation (Claude, AI agents, GoHighLevel, Meta Ads) on top of senior marketing leadership. Examples that qualified on 5 Oct 2026: Head of Marketing SEA at Cereal Partners Worldwide (PJ), Growth Lead SEA at OpenAI (SG), Field Marketing Manager APAC at Anthropic (SG), Marketing & Brand Director APJ at VISEO ASIA (PJ), Associate Director of Marketing at Mastercard (Selangor), Lead, Digital Growth, AI & Marketing Technology at OCBC (SG).

---

## 4. The shortlist: one card per job

Every job gets these fields:

| Field | Rule |
|---|---|
| `id` | Stable, so the same job is never shown twice: `<site>:<job id from the URL>`, e.g. `linkedin:4454506970`, `indeed:b15f5d5dc4ce792f`, `glassdoor:1010269976578` |
| `title` | The job title as posted |
| `company` | The employer (not the job board) |
| `location` | City, country |
| `url` | The **https** URL of the posting itself. Strip tracking redirects when you can, e.g. `https://www.linkedin.com/jobs/view/<id>/` |
| `source` | LinkedIn / Indeed / Glassdoor / JobStreet / company site |
| `why` | One line naming which criteria it matches, e.g. "Head of marketing for SEA, based in PJ. Also on Indeed." |

**Card shown to Leo** (one message per job, with ✅ Approve / ❌ Reject):

```
💼 <title> — <company>
<location> · <source>
<why>
<url>

Approve = applied for you on <apply day>, in your browser. Nothing is sent before then.
```

- A card is valid for **7 days**; unanswered cards expire.
- Never send the same `id` twice.
- **Approving only queues the job.** Nothing is submitted at that moment.

**Weekly summary line** for Leo: "<N> job alerts this week, <M> cards sent", plus every `Jobs/Action` email (interview, assessment, next steps, offer) with its deadline, at the top.

---

## 5. Applying (approved jobs only)

**Before starting:** have Leo's job profile (§6), the list of approved jobs not yet applied to, and Leo's real browser (Chrome) with him logged in to LinkedIn, JobStreet, Indeed and Glassdoor. If any of these is missing, stop and say which.

**Rules, in priority order:**

1. **Only approved jobs. At most 10 per run**, oldest approval first.
2. Use the site's own apply flow: LinkedIn Easy Apply, or the employer's portal (Workday, iCIMS, Greenhouse…). **One application at a time**, and wait **60–90 seconds** between submissions.
3. **Answer only from the job profile.** If a required question isn't covered, needs a login you don't have, or asks for a test, video or extra cover letter, **don't submit**. Mark it `needs_you` with the exact question and move on.
4. Upload the CV at the path in the profile. A short "why me" may be tailored to the role, truthfully, using only facts in the profile.
5. Never pay, never message recruiters, never change Leo's profile on any site, never accept anything beyond standard apply terms.

**Report each job right after finishing it**, with exactly one outcome:

| Outcome | When | Note example |
|---|---|---|
| `applied` | Submitted | "Easy Apply, CV attached" |
| `needs_you` | Stopped before submitting | "Asks: expected salary in SGD" |
| `failed` | Couldn't apply | "Posting closed" |
| `skipped` | Deliberately not done | "Over the 10-per-week limit" |

**Finish with one summary to Leo**, three sections: ✅ Applied · 🙋 Needs you (with the exact question) · ⚠️ Failed / skipped. One line per job: `title — company — note`.

**Risk note for Leo:** LinkedIn, Indeed and JobStreet restrict automated applying. Applying only to jobs he approved, at most 10 a week, in his real browser, lowers the risk of an account restriction but doesn't remove it. Watch the first run.

---

## 6. Leo's job profile: the only source of answers

Applications are answered **only** from this profile. Anything not in it becomes `needs_you`; never guess. As of 8 Oct 2026 it had **not been filled in yet**: only the blank template existed. Fill it in with Leo before the first apply run.

```markdown
## Basics
- Full name / Email for applications / Phone (with country code)
- Location (city, country) / LinkedIn URL / Portfolio or website
- CV file (path, PDF)

## Work rights
- Malaysia: citizen / PR / needs pass
- Singapore: citizen / PR / needs EP / willing to relocate?
- Willing to relocate to / Remote, hybrid or on-site preference

## Targets
- Titles I want / Titles I do NOT want
- Minimum salary (MYR / SGD, monthly) / Expected-salary answer to give
- Notice period / earliest start date

## Experience (facts only; may be quoted)
- Current role & company / Years of marketing experience
- Key results (numbers) / Tools (GoHighLevel, Meta Ads, Claude / AI agents, …)
- Languages / Highest education

## Standard answers
- Why are you interested in this role? (2–3 sentence template)
- Willing to undergo background checks? / Require sponsorship (MY / SG)?
- How did you hear about us? (default)

## Never answer automatically
- e.g. diversity questions, references, anything about current salary
```

---

## 7. Hand-over: jobs in flight on 8 Oct 2026

**Approved by Leo, not yet applied (apply this first):**

| Job | Company | Location | URL |
|---|---|---|---|
| Lead, Digital Growth, AI & Marketing Technology | OCBC | Singapore | https://www.linkedin.com/jobs/view/4455259225/ |

**Shortlisted on 5 Oct, never answered by Leo.** Their cards in CashFlowOS have been closed. Re-show them to Leo only if the postings are still open and still fit:

| Job | Company | Location | URL |
|---|---|---|---|
| Field Marketing Manager, APAC | Anthropic | Singapore | https://www.linkedin.com/jobs/view/4455415567/ |
| Growth Lead, SEA | OpenAI | Singapore | https://www.linkedin.com/jobs/view/4472119087/ |
| Growth & AI Initiatives Manager | OKX | Singapore | https://www.linkedin.com/jobs/view/4388688599/ (also listed as job 4435218479) |
| GTM Manager, AI | MiAO AI | Singapore | https://www.linkedin.com/jobs/view/4472520525/ |
| Head of Marketing, CPW Southeast Asia Cluster | Cereal Partners Worldwide (Nestlé & General Mills) | Petaling Jaya | https://my.indeed.com/viewjob?jk=b15f5d5dc4ce792f |
| Marketing and Brand Director, APJ | VISEO ASIA | Petaling Jaya | https://www.linkedin.com/jobs/view/4473738680/ |
| Head, Marketing and Commercial | Eagle Eye Center Malaysia | Petaling Jaya | https://www.linkedin.com/jobs/view/4473726601/ |
| Associate Director - Marketing | Mastercard | Selangor | https://www.glassdoor.com/job-listing/index.htm?jl=1010269976578 (also on Indeed) |
| Unit Head, Marcomm (Convergence, Postpaid & Fibre) | CelcomDigi | Petaling Jaya | https://www.linkedin.com/jobs/view/4454506970/ |

---

## 8. Weekly schedule (as it ran before the hand-over)

| When | Step |
|---|---|
| Saturday 09:00 (MYT) | Scan the week's Gmail → shortlist → send cards + weekly summary |
| Any time during the week | Leo approves / rejects cards |
| Sunday 10:00 (MYT) | Apply to approved jobs → report each → send the summary |

The laptop has to be awake for a laptop-run bot. If it was asleep at the scheduled time, run it once when it next wakes.
