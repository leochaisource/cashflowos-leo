// Build the Competitors tab: one profile per real competitor, per project.
//
//   node --env-file-if-exists=.env scripts/competitor-profiles.ts --client=claude-malaysia
//   ... --all                 every focus project (ranked 1–3)
//   ... --usp                 also write missing USPs with the model (uses Anthropic credit)
//   ... --usp=40              ...but at most 40 of them this run
//   ... --export=path.json    dump the dossiers of advertisers with no USP yet, to write them elsewhere
//   ... --import=path.json    store USPs from a file: [{ "project"?, "competitor", "usp", "offer", "is_competitor" }]
//   ... --source=<label>      who wrote the imported USPs (default "claude-session")
//
// The 8am run keeps profiles current for the advertisers it sees each morning
// and fills a few missing USPs per run; this script is for the first build and
// for catching up (e.g. after relevance terms change, or credit is topped up).
//
// Uses lib/competitor-profiles.ts — the code the cron runs — so a profile built
// here is identical to one built at 8am.
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { AD_CLIENTS } from '../lib/ad-clients.ts'
import {
  loadProfileAds,
  byCompetitor,
  buildProfile,
  dossierFor,
  refreshProfiles,
  saveUsps,
  type UspResult,
} from '../lib/competitor-profiles.ts'

const arg = (k: string) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : ''
}
const ID = arg('client')
const ALL = arg('all') !== undefined
const USP = arg('usp')
const EXPORT = arg('export')
const IMPORT = arg('import')
const SOURCE = arg('source') || 'claude-session'

const clients = ALL
  ? AD_CLIENTS.filter((c) => typeof c.rank === 'number').sort((a, b) => (a.rank as number) - (b.rank as number))
  : AD_CLIENTS.filter((c) => c.id === ID)
if (!clients.length) {
  console.error(`pass --client=<id> or --all · clients: ${AD_CLIENTS.map((c) => c.id).join(', ')}`)
  process.exit(1)
}

const db = createClient(
  (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  { auth: { persistSession: false } },
)

// ---------------------------------------------------------------- import
if (IMPORT !== undefined) {
  const items = JSON.parse(fs.readFileSync(IMPORT, 'utf8')) as (UspResult & { project?: string })[]
  for (const c of clients) {
    const mine = items.filter((i) => !i.project || i.project === c.id)
    if (!mine.length) continue
    // The profiles must exist first — the USP is written onto them.
    const r = await refreshProfiles(db, c)
    if (r.note) {
      console.error(`${c.id}: ${r.note}`)
      continue
    }
    const saved = await saveUsps(
      db,
      c.id,
      mine.map((i) => ({ competitor: i.competitor, usp: i.usp, offer: i.offer || null, is_competitor: i.is_competitor ?? null })),
      SOURCE,
    )
    console.log(`${c.id}: ${r.built} profiles built · ${saved} of ${mine.length} USPs stored (source: ${SOURCE})`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------- export
if (EXPORT !== undefined) {
  const out: { project: string; competitor: string; ads: number; active: number; dossier: string }[] = []
  for (const c of clients) {
    const { ads, scored } = await loadProfileAds(db, c)
    const groups = byCompetitor(ads)
    // Skip advertisers that already have a USP, when the table exists.
    const have = new Set<string>()
    const probe = await db.from('competitor_profiles').select('competitor').eq('project', c.id).not('usp', 'is', null)
    if (!probe.error) for (const r of probe.data as { competitor: string }[]) have.add(r.competitor)
    for (const [name, list] of groups) {
      if (have.has(name)) continue
      const p = buildProfile(c.id, name, list)
      out.push({ project: c.id, competitor: name, ads: p.ads, active: p.active_ads, dossier: dossierFor(name, list, p.landings) })
    }
    console.log(`${c.id}: ${ads.length} on-topic ads (${scored}) · ${groups.size} competitors · ${groups.size - have.size} without a USP`)
  }
  out.sort((a, b) => a.project.localeCompare(b.project) || b.active - a.active || b.ads - a.ads)
  fs.writeFileSync(EXPORT, JSON.stringify(out, null, 1))
  console.log(`wrote ${out.length} dossier(s) to ${EXPORT}`)
  process.exit(0)
}

// ---------------------------------------------------------------- build (+ optional USPs)
const anthropic = USP !== undefined ? new Anthropic() : null
const maxUsp = USP === undefined ? 0 : USP === '' ? 10_000 : Math.max(0, Number(USP) || 0)
for (const c of clients) {
  const r = await refreshProfiles(db, c, { anthropic, maxUsp })
  console.log(
    `${c.id}: ${r.built} profile(s) built · ${r.uspWritten} USP(s) written · ${r.uspPending} still without a USP` +
      (r.note ? `\n  ⚠ ${r.note}` : ''),
  )
}
