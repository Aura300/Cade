// The web app the Cade Worker keeps each group's Google Sheet and Google Doc
// up to date through (see src/google.js): one standalone script, in no
// spreadsheet or doc, serving every group. It runs as whoever deployed it,
// so they must be able to edit each group's spreadsheet and doc.
//
// Each request is { secret, action, … }. `secret` must match SECRET, defined
// in Secret.gs next to this file, which `npm run google:create` makes along
// with the Worker's GOOGLE_SECRET. The actions:
//   sheet.row     { spreadsheetId, project, row }  → {}, a task's row (Sheet.gs)
//   sheet.create  { title }                        → { id }, a new spreadsheet
//   doc.write     { docId, tab, key, blocks }      → { url }, a section of the
//                                                    doc's tab (Doc.gs)
//   doc.task      { docId, parent, title }         → { url, tabId }, a new empty
//                                                    tab for a task's notes,
//                                                    under the parent tab
//                                                    (Doc.gs)
//   doc.export    { docId, parent, title, tabId?, text }
//                                                  → { url, tabId }, a task's
//                                                    thread as text in its tab
//                                                    under the parent tab: the
//                                                    tab `tabId` if it's still
//                                                    there, else a new one
//                                                    (Doc.gs)
//   doc.read      { docId, tab, key }              → { elements }, a section
//                                                    as it now reads
//   doc.create    { title }                        → { id }, a new doc
// New spreadsheets and docs are for `npm run group`, and are yours.

const ACTIONS = {
  "sheet.row": (body) => (recordRow(body), {}),
  "sheet.create": (body) => ({ id: createSpreadsheet(body.title) }),
  "doc.write": (body) => ({ url: write(body.docId, body.tab, body.key, body.blocks) }),
  "doc.task": (body) => addTaskTab(body.docId, body.parent, body.title),
  "doc.export": (body) => exportTab(body.docId, body.parent, body.title, body.tabId, body.text),
  "doc.read": (body) => ({ elements: read(body.docId, body.tab, body.key) }),
  "doc.create": (body) => ({ id: createDoc(body.title) }),
};

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (typeof SECRET === "undefined" || !SECRET || body.secret !== SECRET) {
    return reply({ ok: false, error: "unauthorized" });
  }
  const action = ACTIONS[body.action];
  if (!action) return reply({ ok: false, error: `unknown action ${body.action}` });
  // Two updates for the same task, or the same doc, can arrive at once.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return reply({ ok: true, ...action(body) });
  } catch (error) {
    // Such as a file that's gone, or that whoever deployed this can't edit.
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    lock.releaseLock();
  }
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Run once in the Apps Script editor after creating the script, to approve
// its access to your spreadsheets and docs; the web app can't ask for it
// itself.
function authorize() {
  Logger.log(`Authorized as ${Session.getEffectiveUser().getEmail()}.`);
}
