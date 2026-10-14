/**
 * HOT LEADS — a copy of Ariella's GHL list, for the team (owner, 2026-10-14).
 *
 * Her one list is the GHL pipeline "CM1D Hot Leads". CashFlowOS fills it
 * (cashflowos-leo lib/hot-list.ts) and, on every refresh, pushes every card
 * here: one row per lead (Key = "list|<contactId>"), with "Type" showing the
 * card's stage. This tab no longer decides who is hot; it shows the list.
 *
 * Columns are found BY HEADER NAME, so the team can rename, move or add its own
 * columns without breaking the feed. (On 14 Oct, moving "Remarks" pushed new
 * Keys into "Caller".) CashFlowOS writes only the AUTO columns and Key. Every
 * other column (Message Outcome, Caller, Call 1-3, Remarks …) is the team's and
 * is never written, except that a lead's FIRST list row starts with the team's
 * notes from their newest row in the archive tab.
 *
 * Same project, other files: CallTracker.gs (a call outcome → the Call Log tab)
 * and CartFeed.gs (GHL cart webhooks, now ignored: carts reach this tab through
 * the GHL list).
 *
 * Setup (once): Project Settings → Script properties → SECRET = the value of
 * SHEETS_HOTLEADS_SECRET. Deploy → Web app, execute as Me, access Anyone.
 * After editing: Deploy → Manage deployments → ✏️ → Version: New version.
 */
const SHEET_NAME = 'Hot leads'
const ARCHIVE_NAME = 'Archive (daily rows to 14 Oct)'
const AUTO = [
  'Date',
  'Type',
  'Name',
  'Phone',
  'Email',
  'Industry',
  'Role',
  'Opted in',
  'Opt-in form',
  'First touch',
  'Last message from them',
  'Interest',
  'Objection',
  "Event they're eyeing",
  'Suggested next step',
  'Paid?',
  'GHL link',
  'Assigned to',
]
const KEY = 'Key'
const DAILY_KEY = /^\d{4}-\d{2}-\d{2}\|/

function doGet() {
  return json_({ ok: true, sheet: SHEET_NAME })
}

function doPost(e) {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}')
    // GHL cart webhooks (CartFeed.gs): carts now come through the GHL list.
    if (body && body.customData && body.customData.cf_event) return json_({ ok: true, ignored: 'carts come through the GHL list now' })
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET')
    if (!secret || body.secret !== secret) return json_({ ok: false, error: 'forbidden' })
    if (body.mode !== 'list') return json_({ ok: true, ignored: 'daily rows are retired; this tab mirrors the GHL list' })

    const sh = sheet_()
    const cols = cols_(sh)
    const missing = AUTO.concat([KEY]).filter(function (h) { return !cols[h] })
    if (missing.length) return json_({ ok: false, error: 'missing columns in "' + SHEET_NAME + '": ' + missing.join(', ') })
    const width = sh.getLastColumn()
    const rows = body.rows || []

    // 1. Rows we already have: the AUTO columns only, in one read and one write.
    let index = keyIndex_(sh, cols)
    let updated = 0
    const fresh = []
    const known = rows.filter(function (r) { return index[r.Key] })
    rows.forEach(function (r) { if (!index[r.Key]) fresh.push(r) })
    if (known.length) {
      const autoCols = AUTO.map(function (h) { return cols[h] })
      const lo = Math.min.apply(null, autoCols)
      const hi = Math.max.apply(null, autoCols)
      const n = sh.getLastRow() - 1
      const block = sh.getRange(2, lo, n, hi - lo + 1)
      const values = block.getValues()
      const formulas = block.getFormulas()
      const out = values.map(function (row, i) {
        return row.map(function (v, j) { return formulas[i][j] || v })
      })
      known.forEach(function (r) {
        const i = index[r.Key] - 2
        AUTO.forEach(function (h) {
          if (r[h] !== undefined && r[h] !== null) out[i][cols[h] - lo] = r[h]
        })
        updated++
      })
      block.setValues(out)
    }

    // 2. New leads go in at the top, starting with the team's notes from the
    //    archive. Rows inserted under the header inherit its look — reset it.
    if (fresh.length) {
      const carry = archiveNotes_(sh, cols)
      const team = Object.keys(cols).filter(function (h) { return AUTO.indexOf(h) < 0 && h !== KEY })
      const block = fresh.map(function (r) {
        const line = []
        for (let c = 0; c < width; c++) line.push('')
        AUTO.forEach(function (h) { if (r[h] !== undefined && r[h] !== null) line[cols[h] - 1] = r[h] })
        line[cols[KEY] - 1] = r.Key
        const old = carry[String(r.Key).split('|')[1]]
        if (old) team.forEach(function (h) { if (old[h] !== undefined && old[h] !== '') line[cols[h] - 1] = old[h] })
        return line
      })
      sh.insertRowsAfter(1, block.length)
      sh.getRange(2, 1, block.length, width).setValues(block)
      plain_(sh, 2, block.length, cols)
      // The team's dropdowns (e.g. Message Outcome), copied from the first older row.
      if (sh.getLastRow() > block.length + 1)
        team.forEach(function (h) {
          const dv = sh.getRange(block.length + 2, cols[h]).getDataValidation()
          if (dv) sh.getRange(2, cols[h], block.length, 1).setDataValidation(dv)
        })
    }

    // 3. Contacts that turned out not to be leads (our own test contacts).
    let removed = 0
    const drop = {}
    ;(body.remove || []).forEach(function (id) { drop[id] = true })
    if (Object.keys(drop).length) {
      index = keyIndex_(sh, cols)
      Object.keys(index)
        .filter(function (key) { return drop[String(key).split('|')[1]] })
        .map(function (key) { return index[key] })
        .sort(function (a, b) { return b - a }) // bottom up, so row numbers stay valid
        .forEach(function (r) {
          sh.deleteRow(r)
          removed++
        })
    }
    return json_({ ok: true, inserted: fresh.length, updated: updated, removed: removed })
  } catch (err) {
    return json_({ ok: false, error: String(err) })
  } finally {
    lock.releaseLock()
  }
}

/** Header name → column number (first one wins when two share a name). */
function cols_(sh) {
  const map = {}
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach(function (h, i) {
    const k = String(h).trim()
    if (k && !map[k]) map[k] = i + 1
  })
  return map
}

function keyIndex_(sh, cols) {
  const last = sh.getLastRow()
  const keys = last > 1 ? sh.getRange(2, cols[KEY], last - 1, 1).getValues() : []
  const map = {}
  keys.forEach(function (k, i) { if (k[0] && !map[k[0]]) map[k[0]] = i + 2 })
  return map
}

/**
 * The team's notes from each lead's newest archived row, by contact id. The
 * archive has the 14 Oct rows whose Key landed in "Caller", so the id is read
 * from either, and a key-looking value is never carried over as a note.
 */
function archiveNotes_(sh, cols) {
  const arc = sh.getParent().getSheetByName(ARCHIVE_NAME)
  const out = {}
  if (!arc || arc.getLastRow() < 2) return out
  const head = arc.getRange(1, 1, 1, arc.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim() })
  const data = arc.getRange(2, 1, arc.getLastRow() - 1, head.length).getValues()
  const at = function (name) { return head.indexOf(name) }
  const idOf = function (row) {
    const cands = [row[at(KEY)], row[at('Caller')]]
    for (let i = 0; i < cands.length; i++) {
      const m = String(cands[i] || '').match(/^\d{4}-\d{2}-\d{2}\|(\S+)$/)
      if (m) return m[1]
    }
    return null
  }
  const team = Object.keys(cols).filter(function (h) { return AUTO.indexOf(h) < 0 && h !== KEY && at(h) >= 0 })
  data.forEach(function (row) {
    const id = idOf(row)
    if (!id || out[id]) return // newest first: the first row found wins
    const notes = {}
    let any = false
    team.forEach(function (h) {
      const v = row[at(h)]
      if (v !== '' && v !== null && !DAILY_KEY.test(String(v))) {
        notes[h] = v
        any = true
      }
    })
    if (any) out[id] = notes
  })
  return out
}

/**
 * Run ONCE from the editor (14 Oct 2026): copies the whole tab to the archive
 * tab, untouched, then empties the live tab so it holds only the GHL list.
 * Also puts back the "Date" header if it was typed over.
 */
function archiveDailyRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const sh = ss.getSheetByName(SHEET_NAME)
  if (ss.getSheetByName(ARCHIVE_NAME)) throw new Error('already archived: ' + ARCHIVE_NAME)
  const copy = sh.copyTo(ss).setName(ARCHIVE_NAME)
  ss.setActiveSheet(copy)
  ss.moveActiveSheet(ss.getNumSheets())
  if (String(sh.getRange(1, 1).getValue()).trim() !== 'Date') sh.getRange(1, 1).setValue('Date')
  const n = sh.getLastRow() - 1
  if (n > 0) sh.deleteRows(2, n)
  ss.setActiveSheet(sh)
  console.log('archived ' + n + ' rows to "' + ARCHIVE_NAME + '"')
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  let sh = ss.getSheetByName(SHEET_NAME)
  if (sh) return sh
  sh = ss.insertSheet(SHEET_NAME, 0)
  const head = AUTO.concat(['Message Outcome', 'Remarks', KEY])
  sh.getRange(1, 1, 1, head.length).setValues([head])
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#2b2a28').setFontColor('#ffffff').setWrap(true)
  sh.setFrozenRows(1)
  sh.setFrozenColumns(3)
  sh.hideColumns(head.length)
  return sh
}

// DAYTIME REFRESH (owner, 2026-10-02; 3pm and 9pm added 2026-10-14) — this asks
// CashFlowOS to judge TODAY's chats so far, bring Ariella's GHL list up to date
// and push it in here (through doPost above). Vercel's free plan can't run a
// cron this often, so the clock lives here. Google fires a daily trigger within
// about 15 minutes of the hour. Run installSyncTriggers() once to set them up.
const SYNC_URL = 'https://cashflowos-leo.vercel.app/api/hotleads-sync'
const SYNC_HOURS = [9, 12, 15, 18, 21]

function syncHotLeads() {
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET')
  const res = UrlFetchApp.fetch(SYNC_URL, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  })
  console.log(res.getResponseCode() + ' ' + res.getContentText().slice(0, 300))
}

/** Run once from the editor: (re)creates the daily triggers. */
function installSyncTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncHotLeads' })
    .forEach(function (t) { ScriptApp.deleteTrigger(t) })
  SYNC_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('syncHotLeads').timeBased().atHour(h).nearMinute(0).everyDays(1).inTimezone('Asia/Kuala_Lumpur').create()
  })
  console.log('triggers: ' + ScriptApp.getProjectTriggers().length)
}

/** New rows: plain, with the team's columns lightly tinted. */
function plain_(sh, row, n, cols) {
  sh.getRange(row, 1, n, sh.getLastColumn()).setBackground(null).setFontColor('#000000').setFontWeight('normal')
  Object.keys(cols)
    .filter(function (h) { return AUTO.indexOf(h) < 0 && h !== KEY })
    .forEach(function (h) { sh.getRange(row, cols[h], n, 1).setBackground('#fbf1ec') })
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON)
}
