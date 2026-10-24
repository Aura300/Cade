// Receives task updates from the project-helper Worker and keeps two tabs of
// this spreadsheet up to date:
//   "All tasks"  one row per task, updated on every change (deleted tasks stay,
//                with the status "Deleted")
//   "Completed"  one row per task whose status is Done; removed again if the
//                task is reopened, kept if a done task is deleted
// Each request is { secret, row }, where `row` is keyed by column header and
// "Task ID" identifies the task. Set the SECRET script property to the same
// value as the Worker's SHEET_SECRET.

const ALL_TASKS = {
  name: "All tasks",
  headers: [
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
  ],
};

const COMPLETED = {
  name: "Completed",
  headers: ["Title", "Completed at", "Developer", "Reviewer", "Tester", "Task link", "Task ID"],
};

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || body.secret !== secret) return reply({ ok: false, error: "unauthorized" });

  // Two updates for the same task can arrive at once.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const row = body.row;
    upsert(ALL_TASKS, row);
    if (row.Status === "Done") {
      upsert(COMPLETED, row);
    } else if (row.Status !== "Deleted") {
      remove(COMPLETED, row["Task ID"]);
    }
    return reply({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function upsert(tab, row) {
  const sheet = sheetFor(tab);
  const values = tab.headers.map((header) => row[header] ?? "");
  const existing = findRow(sheet, tab, row["Task ID"]);
  if (existing) {
    sheet.getRange(existing, 1, 1, tab.headers.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

function remove(tab, id) {
  const sheet = sheetFor(tab);
  const existing = findRow(sheet, tab, id);
  if (existing) sheet.deleteRow(existing);
}

// Returns the row number holding the task, or 0.
function findRow(sheet, tab, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const column = tab.headers.indexOf("Task ID") + 1;
  const ids = sheet.getRange(2, column, last - 1, 1).getValues();
  const index = ids.findIndex(([value]) => value === id);
  return index === -1 ? 0 : index + 2;
}

// Creates the tab with a bold, frozen header row the first time it is used.
function sheetFor(tab) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(tab.name);
  if (!sheet) {
    sheet = book.insertSheet(tab.name);
    sheet.appendRow(tab.headers);
    sheet.getRange(1, 1, 1, tab.headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
