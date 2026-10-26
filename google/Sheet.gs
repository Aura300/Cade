// Each group's tasks, in its own spreadsheet (see Code.gs for how requests
// arrive): a "Tasks" tab, made the first time, with one row per task,
// updated on every change. Deleted tasks stay,
// with the status "Deleted". Filter the Status column to see completed
// tasks. A row is keyed by column header, with "Task ID" identifying the
// task.

const TAB = "Tasks";

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

// Records a task's row: { spreadsheetId, project, row }, `project` being
// the group's name.
function recordRow(body) {
  if (!body.project) throw new Error("missing project");
  if (!body.spreadsheetId) throw new Error("missing spreadsheetId");
  upsert(sheetFor(SpreadsheetApp.openById(body.spreadsheetId), body.project), body.row);
}

// A new spreadsheet called `title`, for `npm run group`, and its ID.
function createSpreadsheet(title) {
  return SpreadsheetApp.create(title).getId();
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

// The Tasks tab in the group's spreadsheet `book`. Tabs used to be named
// after the group, so one called `group` is renamed, keeping its rows.
// Otherwise it's made the first time, with a bold, frozen header row, and a
// new spreadsheet's empty first tab is removed then, so it holds just this
// one.
function sheetFor(book, group) {
  let sheet = book.getSheetByName(TAB);
  if (!sheet && group !== TAB) {
    sheet = book.getSheetByName(group);
    if (sheet) sheet.setName(TAB);
  }
  if (!sheet) {
    sheet = book.insertSheet(TAB);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    const others = book.getSheets().filter((other) => other.getSheetId() !== sheet.getSheetId());
    if (others.length === 1 && others[0].getLastRow() === 0 && others[0].getLastColumn() === 0) book.deleteSheet(others[0]);
  }
  return sheet;
}
