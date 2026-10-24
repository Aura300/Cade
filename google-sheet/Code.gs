// Receives task updates from the project-helper Worker and keeps one tab per
// channel pair up to date, named after the pair (for example "aura300" and
// "test"). Each task has one row, updated on every change; deleted tasks stay,
// with the status "Deleted". Filter the Status column to see completed tasks.
//
// Each request is { secret, project, row }: `project` is the pair's name and
// `row` is keyed by column header, with "Task ID" identifying the task. Set the
// SECRET script property to the same value as the Worker's SHEET_SECRET.

const HEADERS = [
  "Title",
  "Status",
  "Priority",
  "Due date",
  "Developer",
  "Reviewer",
  "Tester",
  "Tracked by",
  "Tracked at",
  "Completed at",
  "Task link",
  "Request link",
  "Task ID",
];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || body.secret !== secret) return reply({ ok: false, error: "unauthorized" });
  if (!body.project) return reply({ ok: false, error: "missing project" });

  // Two updates for the same task can arrive at once.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    upsert(sheetFor(body.project), body.row);
    return reply({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// Overwrites the task's row, or adds one if the task is new.
function upsert(sheet, row) {
  const values = HEADERS.map((header) => row[header] ?? "");
  const existing = findRow(sheet, row["Task ID"]);
  if (existing) {
    sheet.getRange(existing, 1, 1, HEADERS.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

// Returns the row number holding the task, or 0. The lookup is by value, so
// sorting and filtering the tab is safe.
function findRow(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const column = HEADERS.indexOf("Task ID") + 1;
  const ids = sheet.getRange(2, column, last - 1, 1).getValues();
  const index = ids.findIndex(([value]) => value === id);
  return index === -1 ? 0 : index + 2;
}

// Creates the pair's tab with a bold, frozen header row the first time it is
// used.
function sheetFor(name) {
  // A script opened from the sheet (Extensions → Apps Script) writes to that
  // sheet; a standalone script needs the SPREADSHEET_ID script property.
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  const book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error("Set the SPREADSHEET_ID script property");
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
