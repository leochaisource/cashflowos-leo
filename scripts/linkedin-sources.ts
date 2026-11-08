// Leo's own LinkedIn material, by hand: his wins sheet and his photos folder in Google
// Drive (agents/linkedin/sources.ts + photos.ts), the same calls the 9am cron makes.
//
//   node --env-file-if-exists=.env --env-file-if-exists=../.env scripts/linkedin-sources.ts <command>
//     wins                 the Wins rows the autopilot will read (client names hidden)
//     photos               every photo in the folder, with what the catalogue says about it
//     upload               copy the laptop library (linkedin/photos/*.jpg) into the folder's
//                          "Older photos (from the laptop)" subfolder; files already there are skipped
//     catalogue [--max N]  look at new photos now and save what they show (REAL: writes
//                          linkedin_photos; the cron does this on quiet mornings anyway)
//
// Needs LINKEDIN_SOURCES_URL and LINKEDIN_SOURCES_SECRET in .env (the sheet's Apps Script).
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const { fetchWins, listPhotos, addPhoto } = await import('../agents/linkedin/sources.ts')
const { cataloguePhotos } = await import('../agents/linkedin/photos.ts')

const [cmd = 'wins'] = process.argv.slice(2)
const arg = (f: string) => (process.argv.indexOf(f) > -1 ? process.argv[process.argv.indexOf(f) + 1] : undefined)
const db = () =>
  createClient(
    (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v\d+$/i, ''),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    { auth: { persistSession: false } },
  )

if (cmd === 'wins') {
  const wins = await fetchWins()
  console.log(`${wins.length} note(s) in the Wins tab`)
  for (const w of wins) console.log(`  [${w.id}] ${w.date || 'undated'} ${w.type || ''}: ${w.text}${w.numbers ? ` (numbers: ${w.numbers})` : ''}${w.client ? ' · client: (private)' : ''}`)
} else if (cmd === 'photos') {
  const photos = await listPhotos()
  const { data } = await db().from('linkedin_photos').select('drive_id, usable, cover_ok, scene, reject_reason, used_count')
  const known = new Map((data ?? []).map((r: any) => [r.drive_id, r]))
  console.log(`${photos.length} photo(s) in the folder · ${known.size} in the catalogue`)
  for (const p of photos) {
    const k: any = known.get(p.id)
    const verdict = !k ? 'not sorted yet' : !k.usable ? `skip: ${k.reject_reason}` : `${k.cover_ok ? 'cover ok' : 'not as a cover'} · ${k.scene}${k.used_count ? ` · used ${k.used_count}×` : ''}`
    console.log(`  ${p.folder ? `${p.folder}/` : ''}${p.name} (${p.width}×${p.height}) — ${verdict}`)
  }
} else if (cmd === 'upload') {
  const dir = resolve(process.cwd(), '..', 'linkedin', 'photos')
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
  console.log(`${files.length} photo(s) in ${dir}`)
  let added = 0
  for (const f of files) {
    const base64 = readFileSync(join(dir, f)).toString('base64')
    const r = await addPhoto(f, base64, /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', 'Older photos (from the laptop)')
    if (r === 'added') added++
    console.log(`  ${r === 'added' ? '+' : '='} ${f}`)
  }
  console.log(`${added} added, ${files.length - added} already there`)
} else if (cmd === 'catalogue') {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key) throw new Error('ANTHROPIC_API_KEY missing in .env')
  const { claudeClient } = await import('../lib/claude-usage.ts')
  const anthropic = claudeClient('script-linkedin-photos', { apiKey: key, timeout: 120_000, maxRetries: 1 })
  const r = await cataloguePhotos({ db: db(), anthropic, budgetMs: 30 * 60_000, max: Number(arg('--max')) || 100, log: (s) => console.log(`  ${s}`) })
  console.log(`${r.added} sorted, ${r.waiting} still waiting`)
  for (const n of r.notes) console.log(`  ! ${n}`)
} else {
  console.error('commands: wins | photos | upload | catalogue [--max N]')
  process.exit(1)
}
