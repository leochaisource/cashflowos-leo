// 👉 LEO'S OWN MATERIAL — what he keeps adding himself (owner, 2026-11-08), read from
// his Google Drive folder "LinkedIn engine":
//   • the sheet "My wins and stories (for LinkedIn)", tab Wins: new results, stories,
//     lessons and opinions. He wrote each row, so the autopilot treats them as approved
//     facts, beside the fixed list in kit.ts.
//   • the folder "Photos of me (drop new ones here)": his photos, catalogued in
//     photos.ts and used as a post cover when one fits.
// A server can't open his Drive, so the sheet's own Apps Script (apps-script/
// linkedin-sources.gs), running as Leo, answers for it. Settings: LINKEDIN_SOURCES_URL
// (the web app link) and LINKEDIN_SOURCES_SECRET (the key the script checks).
//
// ⚠️ KEEP THIS FILE RUNTIME-IMPORT-FREE (the dry-run scripts run it under plain node).
import { createHash } from 'node:crypto'

/** One row of the Wins tab. `id` stays the same while the words do, wherever the row moves. */
export type Win = { id: string; row: number; date: string; type: string; text: string; numbers: string; client: string }

export type DrivePhoto = {
  id: string
  name: string
  folder: string
  mimeType: string
  created: string
  modified: string
  size: number
  md5: string
  width: number
  height: number
  taken: string
}

/** Is Leo's sheet + folder connected on this machine (or on Vercel)? */
export const sourcesConfigured = () => !!(process.env.LINKEDIN_SOURCES_URL?.trim() && process.env.LINKEDIN_SOURCES_SECRET?.trim())

async function call<T>(action: string, extra: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  const url = process.env.LINKEDIN_SOURCES_URL?.trim()
  const secret = process.env.LINKEDIN_SOURCES_SECRET?.trim()
  if (!url || !secret) throw new Error('your wins sheet and photos folder are not connected yet (LINKEDIN_SOURCES_URL / _SECRET)')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, action, ...extra }),
    redirect: 'follow', // Apps Script answers via a redirect to googleusercontent.com
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`the sheet's script answered HTTP ${res.status} without data (is it deployed for "Anyone"?)`)
  }
  if (!body?.ok) throw new Error(`the sheet's script said: ${body?.error ?? 'unknown error'}`)
  return body as T
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8)

/** Leo's Wins rows, newest first (rows marked "Use it? No" are already left out by the script). */
export async function fetchWins(): Promise<Win[]> {
  const { rows } = await call<{ rows: Omit<Win, 'id'>[] }>('wins')
  return rows
    .map((r) => ({ ...r, id: `W${hash(`${r.text}|${r.numbers}`.toLowerCase().replace(/\s+/g, ' ').trim())}` }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.row - a.row)
}

/** Every photo in the folder and its subfolders. */
export async function listPhotos(): Promise<DrivePhoto[]> {
  const { photos } = await call<{ photos: DrivePhoto[] }>('photos')
  return photos
}

/** One photo as Drive's resized JPEG (at most `px` on the long side). */
export async function photoData(id: string, px: number): Promise<{ base64: string; mimeType: string; dataUri: string }> {
  const r = await call<{ base64: string; mimeType: string }>('photo', { id, px }, 90_000)
  const mimeType = (r.mimeType || 'image/jpeg').split(';')[0]
  return { base64: r.base64, mimeType, dataUri: `data:${mimeType};base64,${r.base64}` }
}

/** Copy one photo into the folder (the laptop library, once). Never replaces a file of the same name. */
export async function addPhoto(name: string, base64: string, mimeType: string, folder?: string): Promise<'added' | 'already there'> {
  const r = await call<{ id?: string; skipped?: string }>('add_photo', { name, base64, mimeType, folder }, 120_000)
  return r.skipped ? 'already there' : 'added'
}
