// Receives task updates from the Cade Worker and keeps one tab per
// channel pair up to date, named after the pair (for example "acme" and
// "test"). Each task has one row, updated on every change; deleted tasks stay,
// with the status "Deleted". Filter the Status column to see completed tasks.
//
// `npm run group` can also ask it for a new spreadsheet, owned by you:
// { secret, action: "create", title } → { ok, id }.
//
// Each other request is { secret, project, spreadsheetId, row }: `project` is the
// pair's name, `spreadsheetId` the pair's own spreadsheet, and `row` is keyed
// by column header, with "Task ID" identifying the task. It is a standalone
// script, in no spreadsheet, serving every pair; it runs as whoever deployed
// it, so they must be able to edit each pair's spreadsheet.
// `secret` must match SECRET, defined in Secret.gs next to this file, which
// `npm run sheet:create` makes along with the Worker's SHEET_SECRET.

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
  if (typeof SECRET === "undefined" || !SECRET || body.secret !== SECRET) {
    return reply({ ok: false, error: "unauthorized" });
  }
  if (body.action === "create") return reply({ ok: true, id: SpreadsheetApp.create(body.title).getId() });
  if (!body.project) return reply({ ok: false, error: "missing project" });
  if (!body.spreadsheetId) return reply({ ok: false, error: "missing spreadsheetId" });

  // Two updates for the same task can arrive at once.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    upsert(sheetFor(SpreadsheetApp.openById(body.spreadsheetId), body.project), body.row);
    return reply({ ok: true });
  } catch (error) {
    // Such as a spreadsheet that's gone, or that whoever deployed this can't
    // edit.
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
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

// Creates the pair's tab in `book` with a bold, frozen header row the first
// time it is used. A new spreadsheet's empty first tab is removed then, so
// the pair's own spreadsheet holds just its tab.
function sheetFor(book, name) {
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    const others = book.getSheets().filter((other) => other.getSheetId() !== sheet.getSheetId());
    if (others.length === 1 && others[0].getLastRow() === 0 && others[0].getLastColumn() === 0) book.deleteSheet(others[0]);
  }
  return sheet;
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

// Run once in the Apps Script editor after creating the script, to approve
// its access to your spreadsheets; the web app can't ask for it itself.
function authorize() {
  Logger.log(`Authorized as ${Session.getEffectiveUser().getEmail()}.`);
}
