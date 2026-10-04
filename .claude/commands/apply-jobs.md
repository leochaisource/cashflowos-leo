---
description: "Sunday job applying — apply ONLY to the jobs you ✅'d in Telegram, in your own Chrome, then report back."
---

# /apply-jobs — apply to the jobs you approved

You are running on the owner's laptop, inside their CashFlowOS folder, usually from the
Sunday "Apply to jobs" routine, with Chrome enabled. The owner approved these jobs one by
one in Telegram. Apply to those and nothing else.

## Before you start
1. Read `profile/job-profile.md`. If it doesn't exist, stop and say: *"Copy
   profile/job-profile.example.md to profile/job-profile.md and fill it in first."*
2. Run `npm run inbox -- approved`. It prints `{"jobs":[…]}`, each with an `action_id`.
   If the list is empty, say "No approved jobs this week" and stop.
3. If Chrome isn't connected, stop and say so. The owner can run `/apply-jobs` by hand with
   Chrome on.

## Rules (in priority order)
1. **Only jobs from that list. At most 10 per run**, oldest first.
2. Use the site's own apply flow (LinkedIn Easy Apply, or the employer's careers portal:
   Workday, iCIMS, Greenhouse…). Do one application at a time. Wait **60–90 seconds** between
   submissions.
3. **Answer only from `profile/job-profile.md`.** Never invent or stretch experience, titles,
   dates, salary, notice period, work authorisation, degrees or references. If a required
   question isn't covered by the profile, needs a login you don't have, or asks for a test,
   video or extra cover letter: **don't submit**. Report `needs_you` with the exact question
   and move on.
4. Upload the CV from the path in the profile. A short "why me" may be tailored to the role,
   truthfully, using only facts in the profile.
5. Never pay for anything, never message recruiters, never change the owner's profile on any
   site, never accept anything beyond the standard apply terms.

## Report each job (right after you finish it)
```
npm run inbox -- result <action_id> applied "Easy Apply, CV attached"
npm run inbox -- result <action_id> needs_you "Asks: expected salary in SGD"
npm run inbox -- result <action_id> failed "Posting closed"
npm run inbox -- result <action_id> skipped "Over the 10-per-week limit"
```

## Finish
Write `.inbox/applied.json` and run `npm run inbox -- digest .inbox/applied.json` with
`{"key":"job-apply-<YYYY-MM-DD>","title":"Jobs applied · <date>","sections":[{"heading":"✅ Applied","lines":[…]},{"heading":"🙋 Needs you","lines":[…]},{"heading":"⚠️ Failed / skipped","lines":[…]}]}`.
One line per job: `title — company — note`. Under "Needs you", give the exact question.

**Note for the owner:** LinkedIn, Indeed and JobStreet restrict automated applying. Keeping
it to jobs you approved, at most 10 a week, in your real browser, lowers the risk of an
account restriction but doesn't remove it. Watch the first run.
