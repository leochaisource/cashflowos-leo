# CashFlowOS: build notes for Claude

Lessons from building this app. Each one cost real time once. Read before changing code here. Workspace
rules (shared working tree, a push to `main` deploys to Vercel production, never touch secrets) are in
the root `CLAUDE.md`. For crons, briefs, bots and pre-deploy reviews, also load the
`automation-builder-rules` skill.

## Before designing anything

- **Look for the house procedure first.** This repo documents how to extend itself: `docs/` (for
  example `docs/add-a-tab-prompt.md`: a new tab means the page plus BOTH navs, `Nav.tsx` and
  `BottomNav.tsx`) and the header comments of the files you're about to edit. Follow those over your own
  approach, and say where the task departs from them.
- **Written descriptions of a live account go stale.** Comments and config text about a client's
  situation ("never spent", "the offer is X", the client's niche) were written from a snapshot. One
  went wrong for a month and aimed competitor research at the wrong market. Before research or planning
  that relies on such text, check it against live data (current campaigns, current spend). Treat a
  mismatch as something to fix first, not a footnote, and prefer reading the facts from live data over
  storing them as prose.

## Pages and static files

- **New files in `public/` hit the login gate.** `proxy.ts` sends every path not on its matcher
  exclusion list to `/login`. An image there gets the login page back and renders as a blank box, with
  no console error and no 404. Put new assets under a path already excluded (for example `/icons/`).
  Changing the matcher is a security change: it needs Leo's OK and its own commit.
- **Check the asset loaded, not just the markup.** In the browser:
  `Array.from(document.images).filter(i => i.currentSrc).map(i => [i.currentSrc, i.complete && i.naturalWidth > 0])`.
  Any `false` is a broken asset. The filter skips lazy images that haven't loaded yet, so scroll your
  new image into view first. Or confirm the request returned an image content type, not `text/html`.

## Text, time and data

- **Shorten third-party text with `clip()` from `lib/format.ts`, never `.slice()`.** Ad copy uses
  "fancy" bold letters that take two storage units each. A plain slice can cut one in half, which causes
  a hydration error on the page and a rejected request when the text goes to the model.
- **Show dates and times with the helpers in `lib/format.ts`.** They pin `Asia/Kuala_Lumpur`; Vercel
  runs in UTC, so a bare `toLocaleString()` is eight hours off in production while looking right on the
  laptop. "Today" means the same calendar date in KL, not "within 24 hours". Test a new date helper
  under UTC too: from the repo root, both of these must print `22 Oct 2026`:
  `node -e "import('./lib/format.ts').then(m => console.log(m.dateLong('2026-10-21T16:30:00Z')))"`
  and the same line with `TZ=UTC` in front.
- **Page every bulk read.** Supabase returns at most 1,000 rows per request, with no error. Loop with
  `.range(from, from + 999)` until a short page (see `scripts/adyntel-rescore.ts`), and have scripts
  print how many rows they processed next to the table's real count.
- **Measure every cohort the same way before colouring it against a benchmark.** A funnel stage showed
  red (71% vs 88%) only because the live cohort counted undated GHL tags while the past cohort counted
  dated payment attempts. Measured on the same dated source, it was 91%. Define each stage on a source
  every cohort has, dated; let a past cohort set the benchmark only for stages it recorded; treat
  undated state (tags, AI intent labels that are rewritten daily) as "seen this morning", for live
  cohorts only. Re-check any red against its definition before showing it.

## Committing in the shared working tree

Other sessions leave uncommitted edits here, sometimes in the same file as yours, and they commit
mid-task. `git add -p` is interactive and unavailable. To commit only your change:

1. Re-check `git status` and `git log` right before staging.
2. Build your version of each file from the committed base plus only your edits (start from
   `git show HEAD:<path>`), never from the file on disk.
3. Stage that content without touching the working tree:
   `BLOB=$(git hash-object -w --stdin --path=<path> < mine.txt)` then
   `git update-index --cacheinfo 100644,$BLOB,<path>`. Afterwards `git diff --cached` shows only your
   change, and `git diff` still shows the other session's.

To prove the commit builds without disturbing anyone's dev server, build it in a separate
`git worktree` on D: and run `npm ci` inside it. A `node_modules` junction is fine for `tsc` but
breaks the build: Turbopack refuses it, and webpack can't resolve across drives. If you did use a
junction, remove it NON-recursively before deleting the worktree, or the delete follows it into the
real packages. If deleting fails with "Filename too long", empty the folder in PowerShell with
`robocopy <empty-dir> <worktree-dir> /MIR` (exit codes below 8 mean success), then
`git worktree prune`. If `next start` leaves a process holding the port, check its command line,
then stop it by port.

## Before every push

A push ships every commit between the remote and HEAD, not just yours. Other sessions here commit
and hold work for Leo's OK, and one push on 2026-10-22 shipped four such commits by accident. So,
immediately before `git push`, as part of the same step: run `git fetch`, then
`git log --oneline origin/main..HEAD`. If any listed commit isn't yours, stop and ask Leo before
pushing. A check run earlier in the session goes stale.

A hook enforces this: `scripts/git-hooks/pre-push`, switched on for this checkout with
`git config core.hooksPath scripts/git-hooks`. Every push prints the commits it ships, and a push of
more than one commit stops until you run it again with `PUSH_OK=<n> git push` (in PowerShell,
`$env:PUSH_OK='<n>'` first). Give `PUSH_OK` only after reading the list, and never pass
`--no-verify` to get past the hook.

## Competitor research (Adyntel)

- **Tune filters offline, for free.** Every ad's raw data is stored, so test keyword and relevance
  changes with `scripts/adyntel-rescore.ts` (`--off` lists off-topic advertisers, `--why=<name>` shows
  which term matched or which exclusion fired). Re-pull with paid credits only once the off-topic list
  is truly off-topic and no known competitor is rejected.
- **Write relevance terms as products or proper nouns.** A bare country name isn't a market signal (in
  HK, 馬來西亞 mostly labels furniture, SIM cards and tours); use the city, district or scheme name.
  Chinese and Japanese terms match as substrings: the exclusion 保险 also rejected 保险库 (a vault, a KL
  condo selling point). Exclude the product (保險公司, 人壽), never a two-character noun.
- **Searching a brand's name doesn't fetch the brand's ads.** Keyword search answers "who is in this
  market?". To see what one brand runs, use its page id (`watchPages` in `lib/ad-clients.ts`). Test any
  data-source claim with one live call before recommending it.
- **A keyword filter is not a competitor judgement.** When collected ads become a list a person reads,
  judge each advertiser (`is_competitor` in `lib/competitor-profiles.ts`) and keep the ruled-out rows,
  hidden behind a filter, as evidence. Don't delete them.
