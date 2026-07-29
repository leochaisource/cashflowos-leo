# 📊 Ad Performance Triage — my-agent.md  (Marketing · LIVE)

> The Head of Marketing's filled canvas. Every section maps 1:1 to a code knob.
> This is the first head actually turned on — it appears in `SCHEDULED`, so the
> daily cron really sweeps it.

**Name:** Ad Performance Triage
**Owner (who it works for):** The owner / the person who buys the ads
**Approver (whose YES it needs):** The owner — every single recommendation

---

## 1. WHEN does it wake up?  → knob `when` in `definition.ts`
`daily`

> Once a day, in the morning brief run (`/api/cron-daily`).

## 2. LOOK AT — what does it read?  → knob `lookAt` in `definition.ts`
> `content` records where `meta.format === 'ad'` and `meta.clicks` is at least
> `MARKETING_MIN_CLICKS` (default 20) — ads with enough traffic to actually judge.
> (`adStats(rows)` in `definition.ts`)

It derives two rates per ad and pools them into your own account baseline:
- **CTR** = `clicks / views` — did it earn attention?
- **click→lead CVR** = `leads / clicks` — did that attention mean anything?

## 3. SUGGEST — what does it draft?  → knob `suggest` in `prompt.ts`
> A ranked kill/scale list, at most `MARKETING_MAX_PROPOSALS` problems plus one
> winner. Three recommendation shapes:
>
> - **`dud`** — real clicks, zero leads. "Turn it off."
> - **`mismatch`** — above-average CTR but below-floor CVR. The expensive one:
>   attention without intent, so the fix is the landing page, not the creative.
> - **`scale`** — of the ads beating your average CVR, the one with the **most
>   leads**. The only positive recommendation, and the only one requiring 5× the
>   click threshold.
>
> Note the winner is ranked on **leads, not CVR**. Ranking on rate alone crowns a
> rounding error: on the real data it picked a 20-month-old ad with 13 leads off
> 103 clicks over one with 100 leads off 1,148. Filter on efficiency, rank on
> proven volume.

## 4. ASK-BEFORE — what must it never do without a YES?  → knob `askBefore` in `definition.ts`
> **Everything. Always.** `askBefore` returns a hard `true` with no threshold that
> can flip it. Killing or scaling a creative moves ad budget, so it never runs on
> 🟢 autopilot however confident the arithmetic looks.

---

## The autonomy dial

- 🟢 **AUTOPILOT**: (none — every recommendation touches ad budget)
- 🟡 **ASK-FIRST**: every kill, every review, every scale call
- 🔴 **NEVER**: pause/boost/edit an ad · change a budget · spend money · touch the
  ad account in any way

> **Golden rule:** the head reads your numbers and hands you one clear call.
> **You** make the change in Meta Ads Manager. It has no hands in your ad account —
> not disabled, *absent*.

---

## The three dials (env)

| Env var | Default | What it does |
|---|---|---|
| `MARKETING_MIN_CLICKS` | `20` | Ignore ads too small to judge. Raise as volume grows. |
| `MARKETING_CVR_FLOOR` | `0.5` | Flag below this fraction of your average CVR. Lower = quieter. |
| `MARKETING_MAX_PROPOSALS` | `3` | Cap per run, so Approvals stays a decision list. |

---

## The magic sentence 🎤

> **"When the morning cron runs, my robot grades every ad against my own average
> and hands me the three worst and the one best — but it asks ME before every
> single one, and it can never touch the ad account itself."**

---

## ⚠️ One thing that differs from the shipped example

The Overdue-Invoice Chaser keys its proposals on `…:${today}` because an invoice
gets **more** overdue every day, so a fresh daily ask is correct.

Ad rows are static history. The same pattern would re-propose identical
recommendations every single morning forever. So this head keys on the metrics
instead:

```
marketing-triage:<issue>:<row_id>:<Math.floor(clicks / 100)>
```

It asks **once per ad per issue**, and only raises its hand again when that ad has
accrued another 100 clicks — i.e. when there's genuinely new evidence.
