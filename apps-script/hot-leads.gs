/**
 * HOT LEADS — receives each morning's hot leads from the CashFlowOS 8am run
 * (cashflowos-leo: lib/hot-leads-sheet.ts) and keeps them in the "Hot leads" tab.
 *
 * Setup (once): Project Settings → Script properties → add SECRET = the value
 * of SHEETS_HOTLEADS_SECRET. Deploy → New deployment → Web app, execute as
 * Me, access Anyone. Requests without the secret are refused.
 *
 * One row per lead per day (key = date|contactId). Re-sending a day updates
 * the auto-filled columns only — "Ariella's status" and "Notes" belong to the
 * team and are never overwritten. Newest days are inserted at the top.
 */
const SHEET_NAME = 'Hot leads'
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
const MANUAL = ["Ariella's status", 'Notes']
const KEY = 'Key'
const HEADERS = AUTO.concat(MANUAL, [KEY])
const STATUSES = ['Contacted', 'Replied', 'Paid', 'Not interested', 'No reply']

function doGet() {
  return json_({ ok: true, sheet: SHEET_NAME })
}

function doPost(e) {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}')
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET')
    if (!secret || body.secret !== secret) return json_({ ok: false, error: 'forbidden' })

    const sh = sheet_()
    const keyCol = HEADERS.indexOf(KEY) + 1
    const paidCol = HEADERS.indexOf('Paid?') + 1
    const keyIndex = () => {
      const last = sh.getLastRow()
      const keys = last > 1 ? sh.getRange(2, keyCol, last - 1, 1).getValues() : []
      const map = {}
      keys.forEach(function (k, i) {
        if (k[0]) map[k[0]] = i + 2
      })
      return map
    }

    // 1. Update rows we already have (auto columns only).
    let index = keyIndex()
    let updated = 0
    const fresh = []
    ;(body.rows || []).forEach(function (row) {
      const values = AUTO.map(function (h) {
        return row[h] === undefined || row[h] === null ? '' : row[h]
      })
      if (index[row.Key]) {
        sh.getRange(index[row.Key], 1, 1, AUTO.length).setValues([values])
        updated++
      } else {
        fresh.push(values.concat(['', '', row.Key]))
      }
    })

    // 2. New rows go in at the top, newest first. Rows inserted under the
    //    header inherit its dark fill and bold — reset them to plain.
    if (fresh.length) {
      sh.insertRowsAfter(1, fresh.length)
      sh.getRange(2, 1, fresh.length, HEADERS.length).setValues(fresh)
      sh.getRange(2, AUTO.length + 1, fresh.length, 1).setDataValidation(statusRule_())
      plain_(sh, 2, fresh.length)
    }
    if (body.restyle && sh.getLastRow() > 1) plain_(sh, 2, sh.getLastRow() - 1)

    // 2b. Contacts that turned out not to be leads (our own test contacts): drop every row of theirs.
    let removed = 0
    const drop = {}
    ;(body.remove || []).forEach(function (id) {
      drop[id] = true
    })
    if (Object.keys(drop).length) {
      index = keyIndex()
      Object.keys(index)
        .filter(function (key) {
          return drop[String(key).split('|')[1]]
        })
        .map(function (key) {
          return index[key]
        })
        .sort(function (a, b) {
          return b - a // bottom up, so row numbers stay valid
        })
        .forEach(function (r) {
          sh.deleteRow(r)
          removed++
        })
    }

    // 3. Leads who have paid since: mark every row of theirs.
    let paidMarked = 0
    const paid = {}
    ;(body.paid || []).forEach(function (p) {
      paid[p.contactId] = p.paidAt
    })
    if (Object.keys(paid).length && sh.getLastRow() > 1) {
      index = keyIndex()
      Object.keys(index).forEach(function (key) {
        const contactId = String(key).split('|')[1]
        if (!paid[contactId]) return
        const cell = sh.getRange(index[key], paidCol)
        if (String(cell.getValue()).indexOf('Paid') !== 0) {
          cell.setValue('Paid ✅ ' + paid[contactId])
          paidMarked++
        }
      })
    }
    return json_({ ok: true, inserted: fresh.length, updated: updated, paidMarked: paidMarked, removed: removed })
  } catch (err) {
    return json_({ ok: false, error: String(err) })
  } finally {
    lock.releaseLock()
  }
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  let sh = ss.getSheetByName(SHEET_NAME)
  if (sh) return sh
  sh = ss.insertSheet(SHEET_NAME, 0)
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#2b2a28').setFontColor('#ffffff').setWrap(true)
  sh.setFrozenRows(1)
  sh.setFrozenColumns(3)
  const widths = { Date: 90, Type: 150, Name: 170, Phone: 120, Email: 190, Industry: 140, Role: 140, 'Opted in': 90, 'Opt-in form': 150,
    'First touch': 90, 'Last message from them': 130, Interest: 260, Objection: 240, "Event they're eyeing": 120, 'Suggested next step': 260,
    'Paid?': 120, 'GHL link': 110, 'Assigned to': 90, "Ariella's status": 130, Notes: 220 }
  HEADERS.forEach(function (h, i) {
    if (widths[h]) sh.setColumnWidth(i + 1, widths[h])
  })
  ;['Interest', 'Objection', 'Suggested next step', 'Notes'].forEach(function (h) {
    sh.getRange(1, HEADERS.indexOf(h) + 1, sh.getMaxRows(), 1).setWrap(true)
  })
  sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setVerticalAlignment('top').setFontFamily('Arial').setFontSize(10)
  sh.getRange(1, AUTO.length + 1, 1, MANUAL.length).setBackground('#b5573a') // the team's columns
  sh.hideColumns(HEADERS.indexOf(KEY) + 1)
  return sh
}

function plain_(sh, row, n) {
  sh.getRange(row, 1, n, HEADERS.length).setBackground(null).setFontColor('#000000').setFontWeight('normal')
  sh.getRange(row, AUTO.length + 1, n, MANUAL.length).setBackground('#fbf1ec') // the team's columns, lightly tinted
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build()
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON)
}
