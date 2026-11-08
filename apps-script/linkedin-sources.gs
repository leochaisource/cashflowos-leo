/**
 * LINKEDIN SOURCES: Leo's own material for the LinkedIn autopilot (owner, 2026-11-08:
 * "a folder ... where I will continuously upload new portraits" and "a sheet where I keep
 * adding new information or achievements").
 *
 * Lives in the sheet "My wins and stories (for LinkedIn)" (Leo's Drive → LinkedIn engine),
 * next to the folder "Photos of me (drop new ones here)". CashFlowOS can't open Leo's Drive
 * by itself, so this script, running as Leo, answers it (agents/linkedin/sources.ts).
 * POST {secret, action, ...}:
 *   wins                    → the rows of the Wins tab (columns found by header name)
 *   photos                  → the photos in the folder (and its subfolders)
 *   photo {id, px}          → one photo, shrunk by Drive to at most px on its long side
 *   add_photo {name, base64, mimeType, folder?} → copies a photo in (used once, for the
 *                             laptop library); never replaces an existing file
 * It never writes to the sheet and only ever hands out files inside the photos folder.
 *
 * Setup (once): Extensions → Apps Script → paste this file → Save → Deploy → New deployment →
 * Web app, execute as Me, access Anyone → Authorize. The secret: Project Settings → Script
 * properties → SECRET = LINKEDIN_SOURCES_SECRET (or the INLINE_SECRET line in the pasted
 * copy). After editing: Deploy → Manage deployments → ✏️ → Version: New version.
 */
const PHOTOS_FOLDER_ID = '1XLe-GiQtxTYf7HyRgwjC1113hZs0REWW'
const WINS_TAB = 'Wins'
const INLINE_SECRET = '' // the repo copy stays empty; the pasted copy may carry the secret here

function doGet() {
  return json_({ ok: true }) // nothing without the secret
}

function doPost(e) {
  let body
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}')
  } catch (err) {
    return json_({ ok: false, error: 'bad request' })
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET') || INLINE_SECRET
  if (!secret || body.secret !== secret) return json_({ ok: false, error: 'forbidden' })
  try {
    if (body.action === 'wins') return json_({ ok: true, rows: wins_() })
    if (body.action === 'photos') return json_({ ok: true, photos: photos_() })
    if (body.action === 'photo') return json_(photo_(String(body.id || ''), Number(body.px) || 1600))
    if (body.action === 'add_photo') return json_(addPhoto_(body))
    return json_({ ok: false, error: 'unknown action' })
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) })
  }
}

// ---- the Wins tab ----
function wins_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WINS_TAB)
  if (!sh) throw new Error('no "' + WINS_TAB + '" tab')
  const range = sh.getDataRange()
  const values = range.getValues()
  const shown = range.getDisplayValues()
  const head = values[0].map(function (h) { return String(h).trim().toLowerCase() })
  const col = function (start) { return head.findIndex(function (h) { return h.indexOf(start) === 0 }) }
  const c = { date: col('date'), type: col('type'), text: col('what happened'), numbers: col('numbers'), client: col('client'), use: col('use it') }
  if (c.text < 0) throw new Error('no "What happened" column in ' + WINS_TAB)
  const out = []
  for (let i = 1; i < values.length; i++) {
    const get = function (k) { return c[k] < 0 ? '' : String(shown[i][c[k]]).trim() }
    const text = get('text')
    if (!text || /^no\b/i.test(get('use'))) continue
    const d = c.date < 0 ? '' : values[i][c.date]
    out.push({
      row: i + 1,
      date: d instanceof Date ? Utilities.formatDate(d, 'Asia/Kuala_Lumpur', 'yyyy-MM-dd') : get('date'),
      type: get('type'),
      text: text,
      numbers: get('numbers'),
      client: get('client'),
    })
  }
  return out
}

// ---- the photos folder ----
function api_(path) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/' + path, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  if (res.getResponseCode() !== 200) throw new Error('Drive ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 160))
  return JSON.parse(res.getContentText())
}

function list_(q, fields) {
  const out = []
  let token = ''
  do {
    const r = api_('files?q=' + encodeURIComponent(q) + '&pageSize=500&fields=' + encodeURIComponent('nextPageToken,files(' + fields + ')') + (token ? '&pageToken=' + encodeURIComponent(token) : ''))
    ;(r.files || []).forEach(function (f) { out.push(f) })
    token = r.nextPageToken || ''
  } while (token)
  return out
}

/** The photos folder and the folders inside it (two levels). */
function folders_() {
  const ids = [PHOTOS_FOLDER_ID]
  const names = {}
  names[PHOTOS_FOLDER_ID] = ''
  let level = [PHOTOS_FOLDER_ID]
  for (let depth = 0; depth < 2 && level.length; depth++) {
    const next = []
    level.forEach(function (parent) {
      list_("'" + parent + "' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'", 'id,name').forEach(function (f) {
        ids.push(f.id)
        names[f.id] = (names[parent] ? names[parent] + '/' : '') + f.name
        next.push(f.id)
      })
    })
    level = next
  }
  return { ids: ids, names: names }
}

function photos_() {
  const fs = folders_()
  const out = []
  fs.ids.forEach(function (folder) {
    list_("'" + folder + "' in parents and trashed = false and mimeType contains 'image/'", 'id,name,mimeType,createdTime,modifiedTime,size,md5Checksum,imageMediaMetadata(width,height,rotation,time)').forEach(function (f) {
      const m = f.imageMediaMetadata || {}
      const turned = m.rotation === 1 || m.rotation === 3
      out.push({
        id: f.id,
        name: f.name,
        folder: fs.names[folder],
        mimeType: f.mimeType,
        created: f.createdTime,
        modified: f.modifiedTime,
        size: Number(f.size || 0),
        md5: f.md5Checksum || '',
        width: (turned ? m.height : m.width) || 0,
        height: (turned ? m.width : m.height) || 0,
        taken: m.time || '',
      })
    })
  })
  return out
}

function photo_(id, px) {
  if (!/^[\w-]{10,}$/.test(id)) return { ok: false, error: 'bad id' }
  const f = api_('files/' + id + '?fields=id,parents,mimeType,size,thumbnailLink,trashed')
  const inside = folders_().ids
  if (f.trashed || !(f.parents || []).some(function (p) { return inside.indexOf(p) >= 0 })) return { ok: false, error: 'not in the photos folder' }
  let blob = null
  // Drive's own preview, resized: also turns HEIC phone photos into JPEG.
  if (f.thumbnailLink) {
    const size = Math.min(Math.max(Math.round(px), 200), 2400)
    const res = UrlFetchApp.fetch(f.thumbnailLink.replace(/=s\d+$/, '') + '=s' + size, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    })
    if (res.getResponseCode() === 200 && /^image\//.test(res.getBlob().getContentType() || '')) blob = res.getBlob()
  }
  // No preview yet (a just-uploaded file): the original, if it's a plain JPEG or PNG and not huge.
  if (!blob && /^image\/(jpeg|png)$/.test(f.mimeType) && Number(f.size || 0) < 8e6) blob = DriveApp.getFileById(id).getBlob()
  if (!blob) return { ok: false, error: 'no preview yet' }
  return { ok: true, mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) }
}

function addPhoto_(b) {
  const name = String(b.name || '').replace(/[\\/]/g, '_').slice(0, 120)
  if (!name || !b.base64) return { ok: false, error: 'name and base64 needed' }
  const mime = /^image\/(jpeg|png|webp)$/.test(b.mimeType) ? b.mimeType : 'image/jpeg'
  let folder = DriveApp.getFolderById(PHOTOS_FOLDER_ID)
  if (b.folder) {
    const sub = folder.getFoldersByName(String(b.folder))
    folder = sub.hasNext() ? sub.next() : folder.createFolder(String(b.folder))
  }
  if (folder.getFilesByName(name).hasNext()) return { ok: true, skipped: 'already there' }
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.base64), mime, name))
  return { ok: true, id: file.getId() }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON)
}
