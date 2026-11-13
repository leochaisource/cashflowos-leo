#!/usr/bin/env node
// PRE-PUSH CHECK (Leo, 2026-11-13). Lessons from CLAUDE.md written as rules that
// stop a push, instead of notes a session has to remember. The pre-push hook
// (scripts/git-hooks/pre-push) runs it on every push from this checkout.
//
//   npm run check                          the commits not on origin/main yet
//   node scripts/check.mjs <base> <head>   any range (the hook passes the pushed one)
//
// It reads the COMMITS being pushed (git objects), never the working tree, so
// another session's uncommitted files can't block your push, and can't sneak
// past it either.
//
// Two kinds of rule:
//   • Whole tree, at the pushed head (these must always hold): the login gate,
//     public files, secret files and script imports.
//   • Added lines only, a ratchet (old lines are left alone, new ones must be
//     right): times without the KL time zone, and secret-looking values.
// An added line that is right despite a rule carries `check-ok: <reason>` in a
// comment. The summary counts them, so they stay visible.
//
// A NEW LESSON: if the mistake can be spotted in the code, add a rule here (a
// function that calls problem()), prove it on a commit that had the mistake,
// and add a line under "Before every push" in CLAUDE.md.
//
// Exit 0 = passed, 1 = problems found, 2 = the check itself failed. The hook
// stops the push on anything but 0. There is no skip switch, on purpose.

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const GIT = ['-c', 'core.quotePath=false']
const git = (args, input) =>
  execFileSync('git', [...GIT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, input, stdio: ['pipe', 'pipe', 'pipe'] })

const problems = []
const notes = []
const problem = (rule, where, what, why, fix) => problems.push({ rule, where, what, why, fix })

// ── Which commits ────────────────────────────────────────────────────────────
function commit(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
  } catch {
    throw new Error(`can't find the commit "${ref}"`)
  }
}
function originMain() {
  try {
    return commit('origin/main')
  } catch {
    return null
  }
}

function main(argBase, argHead) {
  const head = commit(argHead ?? 'HEAD')
  let base = null
  if (argBase && !/^0+$/.test(argBase)) base = commit(argBase)
  else {
    const om = originMain()
    if (om) base = git(['merge-base', head, om]).trim()
  }
  if (!base) notes.push('No base commit to compare with, so only the whole-tree rules ran.')

  // ── Read the pushed head ───────────────────────────────────────────────────
  const tree = git(['ls-tree', '-r', '-z', '--name-only', head]).split('\0').filter(Boolean)
  const CODE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|gs)$/i
  const files = readBlobs(head, tree.filter((p) => (CODE.test(p) || p === 'vercel.json') && !p.startsWith('node_modules/')))
  const added = base ? addedLines(base, head) : []
  const okLines = added.filter((l) => /(\/\/|\/\*|#|<!--)\s*check-ok:\s*\S.{2,}/.test(l.text)) // only in a comment
  const checked = added.filter((l) => !okLines.includes(l))

  // ── Rules ──────────────────────────────────────────────────────────────────
  const gate = readGate(files)
  loginGate(tree, files, gate)
  publicFiles(tree, gate)
  klTime(checked, files)
  secrets(checked, tree)
  scriptImports(tree, files)

  // ── Report ─────────────────────────────────────────────────────────────────
  const range = base ? `${base.slice(0, 7)}..${head.slice(0, 7)}` : head.slice(0, 7)
  for (const p of problems) {
    console.error(`\n✗ ${p.rule} · ${p.where}`)
    console.error(`  ${p.what}`)
    console.error(`  Why: ${p.why}`)
    console.error(`  Fix: ${p.fix}`)
  }
  for (const n of notes) console.error(`\n· ${n}`)
  const extra = `${checked.length} added line(s) checked` + (okLines.length ? `, ${okLines.length} marked check-ok` : '')
  if (problems.length) {
    console.error(
      `\n✗ Pre-push check (${range}): ${problems.length} problem(s), so the push is stopped. Fix them, commit, and push again.` +
        `\n  The rules are in scripts/check.mjs; "Before every push" in CLAUDE.md explains them. (${extra})`,
    )
    process.exit(1)
  }
  console.error(`✓ Pre-push check passed (${range}): login gate, public files, KL time, secrets, script imports. ${extra}.`)
  process.exit(0)
}

// ── Git helpers ──────────────────────────────────────────────────────────────
function readBlobs(rev, paths) {
  const map = new Map()
  if (!paths.length) return map
  const out = execFileSync('git', [...GIT, 'cat-file', '--batch'], {
    input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n',
    maxBuffer: 1 << 29,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let i = 0
  for (const p of paths) {
    const nl = out.indexOf(10, i)
    const header = out.subarray(i, nl).toString()
    if (/ missing$/.test(header)) {
      i = nl + 1
      continue
    }
    const size = Number(header.split(' ')[2])
    map.set(p, out.subarray(nl + 1, nl + 1 + size).toString('utf8').replace(/\r\n/g, '\n'))
    i = nl + 1 + size + 1
  }
  return map
}

/** Lines the range adds, with their line number in the new file. */
function addedLines(base, head) {
  const out = git(['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U0', '--diff-filter=ACMR', base, head])
  const lines = []
  let file = null
  let n = 0
  for (const raw of out.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/\t$/, '').replace(/^"(.*)"$/, '$1')
      file = p === '/dev/null' ? null : p.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('@@')) {
      n = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0)
      continue
    }
    if (raw.startsWith('+') && file) {
      lines.push({ file, line: n, text: raw.slice(1).replace(/\r$/, '') })
      n++
    }
  }
  return lines
}

// ── Rule 1: the login gate ───────────────────────────────────────────────────
// proxy.ts sends every path its matcher covers to /login. Anything called
// without a login cookie (Vercel's crons, the sheet's Apps Script, a server
// calling itself, a laptop script, Telegram) must be outside the matcher, and
// anything outside it must guard itself.

function readGate(files) {
  const file = ['proxy.ts', 'middleware.ts', 'src/proxy.ts', 'src/middleware.ts'].find((f) => files.has(f))
  if (!file) {
    problem(
      'Login gate',
      'proxy.ts',
      "proxy.ts is missing, so there's no login gate: every page is open to anyone.",
      'The gate is what keeps the dashboard private.',
      'Put proxy.ts back. Removing the gate is a security change: ask Leo first.',
    )
    return { file: null, gated: () => false }
  }
  const src = files.get(file)
  const m = /matcher\s*:\s*(\[[\s\S]*?\]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/.exec(src)
  if (!m) return { file, gated: () => true } // no matcher: the gate runs on every path
  const strings = [...m[1].matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)].map((x) =>
    (x[1] ?? x[2]).replace(/\\(.)/g, '$1'),
  )
  if (!strings.length) throw new Error(`couldn't read the matcher in ${file}; update readGate() in scripts/check.mjs`)
  const res = strings.map((s) => new RegExp(`^${s}$`))
  return { file, gated: (url) => res.some((r) => r.test(url)) }
}

/** app/api/mcp/[key]/route.ts → /api/mcp/x */
function routeUrl(file) {
  const segs = file
    .replace(/^(src\/)?app\//, '')
    .replace(/\/route\.(ts|tsx|js|mjs)$/, '')
    .split('/')
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (/^\[.*\]$/.test(s) ? 'x' : s))
  return '/' + segs.join('/')
}

function guards(src, url) {
  const bearer = /headers\.get\(\s*['"]authorization['"]\s*\)/i.test(src) && /Bearer \$\{/.test(src)
  const tgHeader = /x-telegram-bot-api-secret-token/i.test(src)
  const urlToken = /searchParams\.get\(\s*['"](token|key|secret)['"]\s*\)/.test(src) && /process\.env\./.test(src)
  const pathKey = /\/x(\/|$)/.test(url) && /timingSafeEqual/.test(src) && /process\.env\./.test(src)
  const compare = /timingSafeEqual/.test(src) && /process\.env\./.test(src) // e.g. the login passcode
  const marker = /(\/\/|\/\*)\s*check-ok:\s*public\b/.test(src)
  const machine = bearer || tgHeader || urlToken || pathKey
  return { machine, any: machine || compare || marker }
}

function loginGate(tree, files, gate) {
  if (!gate.file) return
  const routes = tree.filter((p) => /^(src\/)?app\/api\/.+\/route\.(ts|tsx|js|mjs)$/.test(p))
  const urls = new Map(routes.map((f) => [routeUrl(f), f]))
  const fix = (url) =>
    `add ${url.slice(1).replace(/\/x$/, '')} to the matcher's exclusion list in ${gate.file}. That's a security change: ask Leo, and commit it on its own.`

  for (const f of routes) {
    const url = routeUrl(f)
    const g = guards(files.get(f) ?? '', url)
    if (g.machine && gate.gated(url))
      problem(
        'Login gate',
        f,
        `It checks a secret, so something calls it without a login, but ${gate.file} sends ${url} to the login page.`,
        "Those calls get the login page instead of running. It looks fine on the laptop, where the gate is usually open.",
        fix(url),
      )
    if (!gate.gated(url) && !g.any)
      problem(
        'Login gate',
        f,
        `${url} is outside the login gate, and the route doesn't check a secret of its own.`,
        'Anyone on the internet can call it.',
        "Make it check a secret (like the cron routes' Bearer check), or put it back behind the gate. If it's meant to be public, add a comment `check-ok: public - <why>` in the route.",
      )
  }

  // Callers that never carry the login cookie.
  const callers = []
  const vj = files.get('vercel.json')
  if (vj) for (const m of vj.matchAll(/"path"\s*:\s*"(\/api\/[^"?]+)/g)) callers.push({ url: m[1], where: 'vercel.json', who: "Vercel's cron", must: true })
  for (const [f, src] of files) {
    const lines = src.split('\n')
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*|#)/.test(text)) return
      const where = `${f}:${i + 1}`
      if (f.endsWith('.gs')) {
        for (const m of text.matchAll(/['"`][^'"`]*?(\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)/gi)) callers.push({ url: m[1], where, who: "The sheet's Apps Script", must: true })
      } else {
        for (const m of text.matchAll(/\$\{[^}]+\}(\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)/gi)) callers.push({ url: m[1], where, who: 'The app itself', must: false })
        if (/^scripts\//.test(f))
          for (const m of text.matchAll(/['"`][^'"`]*?(\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)/gi)) callers.push({ url: m[1], where, who: 'A laptop script', must: false })
      }
    })
  }
  const seen = new Set()
  for (const c of callers) {
    const key = c.url + '|' + c.where
    if (seen.has(key)) continue
    seen.add(key)
    const route = urls.get(c.url) ?? [...urls].find(([u]) => u.startsWith(c.url + '/'))?.[1]
    if (!route) {
      if (c.must)
        problem(
          'Login gate',
          c.where,
          `${c.who} calls ${c.url}, but there's no such route in app/api.`,
          'The call fails every time it runs, and nothing tells you.',
          'Point the caller at the right route, or put the route back.',
        )
      continue
    }
    if (gate.gated(c.url))
      problem(
        'Login gate',
        c.where,
        `${c.who} calls ${c.url} without a login, but ${gate.file} sends that path to the login page.`,
        'The call gets the login page instead of running.',
        fix(c.url),
      )
  }
}

// ── Rule 2: public files ─────────────────────────────────────────────────────
function publicFiles(tree, gate) {
  if (!gate.file) return
  const served = []
  for (const f of tree) {
    if (f.startsWith('public/')) served.push({ f, url: '/' + f.slice('public/'.length) })
    const m = /^(?:src\/)?app\/((?:icon|apple-icon|favicon|opengraph-image|twitter-image)\d*\.[a-z]+)$/.exec(f)
    if (m) served.push({ f, url: '/' + m[1] })
    if (/^(?:src\/)?app\/manifest\.(ts|js|json|webmanifest)$/.test(f)) served.push({ f, url: '/manifest.webmanifest' })
  }
  for (const { f, url } of served)
    if (gate.gated(url))
      problem(
        'Public file',
        f,
        `${url} is behind the login gate.`,
        "Browsers get the login page instead, so it shows as a blank box, with no error and no 404.",
        `Move it under a folder the gate already lets through (for example public/icons/). Changing the matcher in ${gate.file} is a security change: ask Leo.`,
      )
}

// ── Rule 3: KL time (added lines) ────────────────────────────────────────────
function callArgs(text, open) {
  let depth = 0
  for (let i = open; i < text.length && i < open + 600; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1, open + 600)
}

function klTime(lines, files) {
  for (const l of lines) {
    if (!/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(l.file)) continue
    if (/^\s*(\/\/|\*)/.test(l.text)) continue
    const src = files.get(l.file)
    const rest = src ? src.split('\n').slice(l.line - 1, l.line + 5).join('\n') : l.text
    for (const m of rest.split('\n')[0].matchAll(/\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\(|\bIntl\.DateTimeFormat\(/g)) {
      const call = m[1] ?? 'Intl.DateTimeFormat'
      if (call === 'toLocaleString') {
        const before = l.text.slice(0, m.index)
        const dateish =
          /new Date\((?:[^()]|\([^()]*\))*\)\s*$/.test(before) || /[\w$]*(date|Date|time|Time|At|_at|when|When)\s*\)?\s*$/.test(before)
        if (!dateish) continue // numbers (RM 1,234) are fine
      }
      const args = callArgs(rest, m.index + m[0].length - 1)
      if (/timeZone/.test(args)) continue
      if (/,\s*[A-Za-z_$][\w$.]*\s*$/.test(args.trim())) continue // options passed in a variable: can't tell
      problem(
        'KL time',
        `${l.file}:${l.line}`,
        `${call}() shows a date or time without the KL time zone.`,
        'Vercel runs in UTC, so this is 8 hours off in production while it looks right on the laptop.',
        "Use a helper from lib/format.ts (whenShort, dateLong, klToday, workDay), or add timeZone: 'Asia/Kuala_Lumpur'. If it really must be another zone, add `check-ok: <why>` on the line.",
      )
    }
  }
}

// ── Rule 4: secrets ──────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['a Meta access token', /EAA[A-Za-z0-9]{60,}/],
  ['a GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS key', /AKIA[0-9A-Z]{16}/],
  ['a GoHighLevel private token', /pit-[0-9a-f]{8}-[0-9a-f]{4}/],
  ['a Telegram bot token', /[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ['a Supabase key (JWT)', /eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/],
  ['a Supabase secret key', /sb_secret_[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /xox[bpa]-[A-Za-z0-9-]{20,}/],
]

function secrets(lines, tree) {
  for (const l of lines)
    for (const [kind, re] of SECRET_PATTERNS)
      if (re.test(l.text))
        problem(
          'Secret',
          `${l.file}:${l.line}`,
          `This line contains what looks like ${kind}. (The value isn't printed here.)`,
          'The GitHub repo is public, and git history keeps a value even after it is deleted.',
          'Read the value from process.env and keep it in .env and on Vercel. If it was a real key, tell Leo so he can replace it.',
        )
  for (const f of tree) {
    const b = path.posix.basename(f)
    if ((/^\.env(\..+)?$/.test(b) && b !== '.env.example') || /\.(pem|key|p12|pfx)$/i.test(b) || /^id_(rsa|ed25519|ecdsa|dsa)$/.test(b))
      problem(
        'Secret',
        f,
        'This kind of file holds secrets, and it is in the commit.',
        'The GitHub repo is public, so everything committed can be read by anyone.',
        `Remove it from the commit (git rm --cached ${f}) and keep it out with .gitignore. If it held real keys, tell Leo.`,
      )
  }
}

// ── Rule 5: script imports ───────────────────────────────────────────────────
// Scripts run with plain Node, which can't resolve Next's "@/…" shortcut, throws
// on 'server-only', and needs the exact file ending on relative imports.
// Already broken when this rule was added (a33a36e, 2026-11-13). Fix one, then
// delete its line here.
const SCRIPT_BASELINE = new Set([])

function imports(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out = []
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) if (!m[2]) out.push(m[3])
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

function scriptImports(tree, files) {
  const inTree = new Set(tree)
  const entries = tree.filter((f) => /^scripts\/.+\.(ts|mts|mjs|js)$/.test(f) && !f.startsWith('scripts/git-hooks/'))
  const reported = new Set()
  for (const entry of entries) {
    const from = new Map([[entry, null]])
    const queue = [entry]
    while (queue.length) {
      const f = queue.shift()
      const src = files.get(f)
      if (src == null) continue
      for (const spec of imports(src)) {
        let what = null
        if (spec.startsWith('@/')) what = `imports "${spec}", a shortcut only Next understands, so Node can't find it.`
        else if (spec === 'server-only') what = `imports "server-only", which throws outside Next.`
        else if (spec.startsWith('./') || spec.startsWith('../')) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))
          if (!path.posix.extname(target)) what = `imports "${spec}" without its file ending (.ts), so Node can't find it.`
          else if (!inTree.has(target)) what = `imports "${spec}", which isn't in the commit.`
          else if (/\.(ts|mts|mjs|js)$/.test(target) && !from.has(target)) {
            from.set(target, f)
            queue.push(target)
          }
        }
        if (!what) continue
        const key = `${f} ${spec}`
        if (SCRIPT_BASELINE.has(key) || reported.has(key)) continue
        reported.add(key)
        const chain = []
        for (let x = f; x; x = from.get(x)) chain.unshift(x)
        problem(
          'Script import',
          chain.join(' → '),
          `${f} ${what}`,
          `"${entry}" runs with plain Node and stops with an error before it does anything.`,
          'Use a relative import with the .ts ending, and pass the Supabase client in as a parameter instead of importing the app\'s one (see lib/heartbeat.ts).',
        )
      }
    }
  }
}

// ── Run (last, so every rule above is defined) ───────────────────────────────
try {
  main(...process.argv.slice(2))
} catch (e) {
  console.error(
    `\n✗ The pre-push check itself failed: ${e?.message ?? e}` +
      `\n  Nothing was pushed. Run "npm run check" to see it again, and fix scripts/check.mjs (or ask Leo).` +
      `\n  Don't get past it with --no-verify.`,
  )
  process.exit(2)
}
