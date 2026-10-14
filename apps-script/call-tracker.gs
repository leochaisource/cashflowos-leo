/**
 * CALL TRACKER — Hot leads tab (file "CallTracker.gs" in the sheet's Apps Script).
 * The tab has one "Call outcome" column per call (Call 1, Call 2, Call 3), each
 * right after its "Call N Attempted" column. Pick an outcome (dropdown) in any
 * of them and this script:
 *   - puts the date/time in that call's "Call N Attempted", if it's empty
 *   - adds one row to the "Call Log" tab (created automatically; never overwritten)
 * Every call is kept in Call Log, so the history survives when a lead's row
 * changes. Runs as simple onEdit / onOpen triggers: nothing to install.
 * Pasting or filling more than CT_MAX_ROWS rows at once (e.g. copying a whole
 * column) is a layout change, not calls, and logs nothing.
 * Never touches the columns CashFlowOS writes (Code.gs).
 *
 * Fixed 15 Oct 2026: with three "Call outcome" columns only the last one was
 * watched, so Call 1 and Call 2 outcomes were never logged, and copying a column
 * on 13 Oct logged 40 calls that never happened.
 */
const CT_SHEET = 'Hot leads'
const CT_LOG = 'Call Log'
const CT_OUTCOME = 'Call outcome'
const CT_OUTCOMES = ['No answer', 'Picked up - interested', 'Picked up - not interested', 'Busy - call back later', 'Asked to WhatsApp', 'Wrong number']
const CT_NOT_PICKED = ['No answer', 'Wrong number']
const CT_LOG_HEADERS = ['Called at', 'Name', 'Phone', 'Call outcome', 'Picked up (Y/N)', 'Attempt #', 'Contact ID', 'Lead key', "Ariella's status", 'Notes', 'Called by']
const CT_DATE_FMT = 'd/M/yyyy HH:mm'
const CT_MAX_ROWS = 5

function onOpen() {
  try { ctDropdowns_() } catch (err) { console.error(err) }
}

function onEdit(e) {
  try {
    const sh = e.range.getSheet()
    if (sh.getName() !== CT_SHEET) return
    const cols = ctCols_(sh)
    const calls = ctCalls_(cols)
    if (!calls.length) return
    ctDropdowns_(sh, cols) // new rows from the webhook get the dropdowns too
    const hit = calls.filter(function (k) { return k.col >= e.range.getColumn() && k.col <= e.range.getLastColumn() })
    if (!hit.length) return
    const first = Math.max(2, e.range.getRow())
    const last = e.range.getLastRow()
    if (last - first + 1 > CT_MAX_ROWS) return
    if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 && e.oldValue !== undefined && e.oldValue === e.value) return
    let user = ''
    try { user = (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() } catch (x) {}
    for (let r = first; r <= last; r++) hit.forEach(function (k) { ctLogCall_(sh, cols, r, k, user) })
  } catch (err) {
    console.error(err)
  }
}

function ctLogCall_(sh, cols, r, call, user) {
  const row = sh.getRange(r, 1, 1, sh.getLastColumn()).getValues()[0]
  const get = function (h) { return cols.one[h] ? row[cols.one[h] - 1] : '' }
  const outcome = String(row[call.col - 1]).trim()
  if (!outcome) return
  const now = new Date()
  const key = String(get('Key'))
  const contactId = key.split('|')[1] || String(get('Phone'))
  const picked = CT_NOT_PICKED.indexOf(outcome) >= 0 ? 'N' : 'Y'
  const status = get('Message Outcome') || get("Ariella's status")
  const notes = get('Remarks') || get('Notes')
  const caller = get('Caller')
  const by = user || (typeof caller === 'string' ? caller.trim() : '')

  const log = ctLog_(sh.getParent())
  log.appendRow([now, get('Name'), "'" + String(get('Phone')), outcome, picked, call.n, "'" + contactId, "'" + key, status, notes, by])
  log.getRange(log.getLastRow(), 1).setNumberFormat(CT_DATE_FMT)

  if (call.at && row[call.at - 1] === '') sh.getRange(r, call.at).setValue(now).setNumberFormat(CT_DATE_FMT)
}

function ctLog_(ss) {
  let log = ss.getSheetByName(CT_LOG)
  if (log) return log
  log = ss.insertSheet(CT_LOG)
  log.getRange('A:A').setNumberFormat(CT_DATE_FMT)
  log.getRange('C:C').setNumberFormat('@')
  log.getRange('G:H').setNumberFormat('@')
  log.getRange(1, 1, 1, CT_LOG_HEADERS.length).setValues([CT_LOG_HEADERS])
    .setFontWeight('bold').setBackground('#2b2a28').setFontColor('#ffffff').setWrap(true)
  log.setFrozenRows(1)
  return log
}

function ctDropdowns_(sh, cols) {
  sh = sh || SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CT_SHEET)
  if (!sh) return
  cols = cols || ctCols_(sh)
  const n = sh.getLastRow() - 1
  if (n < 1) return
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(CT_OUTCOMES, true).setAllowInvalid(false).build()
  ctCalls_(cols).forEach(function (k) { sh.getRange(2, k.col, n, 1).setDataValidation(rule) })
}

/** Header → column. `one` is the first column with that name, `all` every one. */
function ctCols_(sh) {
  const cols = { one: {}, all: {} }
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach(function (h, i) {
    const k = String(h).trim()
    if (!k) return
    if (!cols.one[k]) cols.one[k] = i + 1
    ;(cols.all[k] = cols.all[k] || []).push(i + 1)
  })
  return cols
}

/** One entry per call, left to right: its number, outcome column and "Call N Attempted" column. */
function ctCalls_(cols) {
  return (cols.all[CT_OUTCOME] || []).map(function (col, i) {
    return { n: i + 1, col: col, at: cols.one['Call ' + (i + 1) + ' Attempted'] || 0 }
  })
}

/**
 * Run from the editor to check the tracker. Adds a test row, picks an outcome in
 * each call column, tries a 10-row paste (must log nothing), prints what was
 * logged, then removes the test row and its Call Log lines.
 */
function ctSelfTest() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const sh = ss.getSheetByName(CT_SHEET)
  const cols = ctCols_(sh)
  const calls = ctCalls_(cols)
  const log = ctLog_(ss)
  const logBefore = log.getLastRow()
  const line = []
  for (let c = 0; c < sh.getLastColumn(); c++) line.push('')
  line[cols.one['Name'] - 1] = 'CALL TRACKER TEST'
  line[cols.one['Key'] - 1] = 'list|CT_SELF_TEST'
  sh.appendRow(line)
  const r = sh.getLastRow()
  const report = { row: r, calls: calls.map(function (k) { return 'Call ' + k.n + ' → column ' + k.col }) }
  try {
    calls.forEach(function (k, i) {
      const v = i === 0 ? 'No answer' : 'Picked up - interested'
      const cell = sh.getRange(r, k.col)
      cell.setValue(v)
      onEdit({ range: cell, value: v, user: null })
    })
    const afterSingle = log.getLastRow()
    const paste = {
      getSheet: function () { return sh },
      getColumn: function () { return calls[0].col },
      getLastColumn: function () { return calls[calls.length - 1].col },
      getRow: function () { return r },
      getLastRow: function () { return r + 9 },
      getNumRows: function () { return 10 },
      getNumColumns: function () { return calls[calls.length - 1].col - calls[0].col + 1 },
    }
    onEdit({ range: paste, user: null })
    report.loggedByPaste = log.getLastRow() - afterSingle
    report.logged = afterSingle > logBefore
      ? log.getRange(logBefore + 1, 1, afterSingle - logBefore, CT_LOG_HEADERS.length).getDisplayValues().map(function (x) {
        return 'attempt ' + x[5] + ': ' + x[3] + ' (picked up ' + x[4] + ', key ' + x[7] + ')'
      })
      : []
    const row = sh.getRange(r, 1, 1, sh.getLastColumn()).getDisplayValues()[0]
    report.stamped = calls.map(function (k) { return k.at ? 'Call ' + k.n + ' Attempted = ' + (row[k.at - 1] || '(empty)') : 'Call ' + k.n + ': no Attempted column' })
    report.dropdowns = calls.map(function (k) { return 'Call ' + k.n + ': ' + (sh.getRange(2, k.col).getDataValidation() ? 'yes' : 'NO') })
  } finally {
    sh.deleteRow(r)
    if (log.getLastRow() > logBefore) log.deleteRows(logBefore + 1, log.getLastRow() - logBefore)
  }
  console.log(JSON.stringify(report, null, 1))
}
