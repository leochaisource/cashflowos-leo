#!/usr/bin/env bash
# CLOUD SESSION START (Leo, 2026-11-28). Run by the SessionStart hook in
# .claude/settings.json. On the laptop it does nothing: CLAUDE_CODE_REMOTE is
# "true" only inside a Claude Code cloud session.
#
# A cloud session is a fresh clone, so it lacks two things the laptop set up once:
#   1. the git hooks. The laptop runs `git config core.hooksPath scripts/git-hooks`
#      in its own git config, which a clone doesn't copy. Without it, pushes skip
#      scripts/check.mjs.
#   2. node_modules. npm ci runs again only when package-lock.json has changed.
#
# What it prints reaches Claude as context. It never fails the session: a
# problem is reported, and the session goes on.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 0

echo "Cloud session: work on your own branch and open a pull request. Never push to main: it deploys to Vercel production. See \"Cloud sessions\" in CLAUDE.md."

if git config core.hooksPath scripts/git-hooks; then
  echo "Cloud session: git hooks are on, so every push runs scripts/check.mjs."
else
  echo "Cloud session: couldn't switch on the git hooks. Run 'git config core.hooksPath scripts/git-hooks' before any push."
fi

stamp=node_modules/.package-lock.sha256
want=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)
log=/tmp/cloud-session-npm-ci.log
if [ -n "$want" ] && [ -d node_modules ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
  echo "Cloud session: packages already installed."
elif npm ci --no-audit --no-fund --loglevel=error >"$log" 2>&1; then
  [ -n "$want" ] && echo "$want" >"$stamp"
  echo "Cloud session: packages installed (npm ci)."
else
  echo "Cloud session: npm ci failed, so builds and type checks won't work yet. Last lines of $log:"
  tail -n 20 "$log"
fi

exit 0
