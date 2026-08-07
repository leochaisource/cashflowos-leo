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

> Once a day, in the morning brief run (`/api/cron-daily`). Also on demand from
> Telegram, through the same `check()`.

## 2. LOOK AT — what does it read?  → `aggregate()` in `definition.ts`
> `ad_daily` rows from the last `MARKETING_WINDOW_DAYS` (default 90), rolled up
> into one row per ad, across every project in `lib/ad-clients.ts`.
>
> The loader is `load.ts`, which reuses `loadAdRows()` from `lib/metrics.ts` — the
> same query the project dashboard runs, so the head and the dashboard can never
> disagree about what an ad spent.

## 3. SUGGEST — what does it draft?  → knob `suggest` in `prompt.ts`
> A ranked list, at most `MARKETING_MAX_PROPOSALS` problems plus one winner:
>
> - **`dud`** — spent real money, produced no lead at all.
> - **`expensive`** — produced leads, but each cost more than your average, and
>   the gap has added up to real money.
> - **`scale`** — of the ads cheaper than your average, the one with the **most
>   leads**. The only positive recommendation.

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

## ⭐ The one idea that makes this head useful

**It ranks on wasted MONEY, not on a ratio.**

A ratio-ranked head shouts about whichever ad has the ugliest CPL. That is almost
never the ad costing you the most. On the real account:

| Ad | CPL | vs RM 13.81 average | Spend | **Actually wasted** |
|---|---|---|---|---|
| `Image Ads 6 - success on paper` | RM 40.63 | **2.9×** — looks worst | RM 81 | RM 54 |
| `Image Ads 1 - Framework Ads` | RM 16.94 | 1.2× — looks fine | RM 2,186 | **RM 404** |

Ranking by ratio flags the first and never mentions the second. But the second is
the one that cost you RM 404. So the ranking key is `wastedSpend` —
`spend − leads × baselineCPL` — the money those leads cost you *above* what they
should have. `MARKETING_MIN_WASTE` is a Ringgit floor, not a percentage, for the
same reason.

The winner is picked the mirror-image way: **filter** on efficiency (must be
cheaper than your average), then **rank** on proven volume (most leads). Ranking
winners by CPL alone crowns a rounding error.

---

## The dials (env)

| Env var | Default | What it does |
|---|---|---|
| `MARKETING_WINDOW_DAYS` | `90` | How far back to look. |
| `MARKETING_MIN_SPEND` | `20` | Below this an ad is a test, not a leak. |
| `MARKETING_MIN_WASTE` | `50` | Speak up only once the gap is this many Ringgit. |
| `MARKETING_MIN_LEADS_WINNER` | `3` | A winner needs this many leads. |
| `MARKETING_MAX_PROPOSALS` | `3` | Cap per run, so Approvals stays a decision list. |

`MIN_SPEND` and `MIN_LEADS_WINNER` mirror `LOSER_MIN_SPEND` and `WINNER_MIN_LEADS`
in `lib/metrics.ts` — keep them in step.

---

## The magic sentence 🎤

> **"When the morning cron runs, my robot grades every ad against my own cost per
> lead and hands me the three biggest money leaks and the one worth scaling — but
> it asks ME before every single one, and it can never touch the ad account."**

---

## Try it without writing anything

```bash
node --env-file-if-exists=.env scripts/marketing-dry-run.ts
```

Prints the baseline, every ad ranked by leak, and the exact proposals the head
would create. It imports the same `definition.ts` and `prompt.ts` the cron uses,
so it cannot drift from the real thing. It writes nothing.

---

## ⚠️ Two things that differ from the shipped example

**1. The idempotency key.** The Overdue-Invoice Chaser keys on `…:${today}`
because an invoice gets **more** overdue every day, so a fresh daily ask is
correct. An ad's totals barely move day to day — that pattern would re-propose
identical recommendations every morning forever. So this head keys on spend:

```
marketing-triage:<issue>:<ad_id>:<Math.floor(spend / 100)>
```

It asks **once per ad per issue**, and raises its hand again only when that ad has
burned another RM100 — i.e. when there's genuinely new money at stake.

**2. `check()` is async.** `ScheduledCheck.check` now returns
`ProposalDraft[] | Promise<ProposalDraft[]>`, because this head READS `ad_daily`
before it proposes. A check is still create-only — it cannot execute anything.
That guarantee is unchanged; only the reading is new.
