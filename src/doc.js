// Each group's executive summaries are kept in its Google Doc (its `doc` in
// CHANNEL_PAIRS), shared with the client and gone through on calls with
// them: a section per summary in its Summary tab, newest first. After a
// call, `/cade import` reads the section back to find what was added. The
// doc's Apps Script web app (google-doc/Code.gs) writes sections and reads
// them back. It is separate from the Google Sheet, and works without it. It
// needs DOC_URL and DOC_SECRET.
export function docsEnabled(env) {
  return Boolean(env.DOC_URL && env.DOC_SECRET);
}

// The tab summaries are written in, made if the doc has none.
export const SUMMARY_TAB = "Summary";

// Sends `request` ({ action, … }) to the web app and returns its reply, or
// throws. Apps Script runs doPost before answering, then redirects to a
// page that holds its reply, which is followed here, since the reply is
// needed.
async function callDoc(env, request) {
  const response = await fetch(env.DOC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.DOC_SECRET, ...request }),
    redirect: "manual",
  });
  const reply = response.status === 302 ? await fetch(response.headers.get("location")) : response;
  if (!reply.ok) throw new Error(`Google Doc web app returned HTTP ${reply.status}`);
  const result = await reply.json();
  if (!result.ok) throw new Error(`Google Doc web app refused ${request.action}: ${result.error}`);
  return result;
}

// Writes a section in the doc's Summary tab, making the tab if there is
// none: in place of the section with the same `key`, or at the top. A block
// is one of:
//   { type: "heading", level: 2 | 3, text }   level 2 starts the section
//   { type: "paragraph", text, italic? }
//   { type: "item", level: 0 | 1, parts: [{ text, link? }, …] }   a bullet
// Returns the tab's address.
export async function writeSection(env, docId, key, blocks) {
  const { url } = await callDoc(env, { action: "write", docId, tab: SUMMARY_TAB, key, blocks });
  return url;
}

// The section `key` as it now reads, as a list of { type: "heading" |
// "paragraph" | "item", level, text, links }, `links` being the addresses
// linked from it, or null if the section is gone.
export async function readSection(env, docId, key) {
  const { elements } = await callDoc(env, { action: "read", docId, tab: SUMMARY_TAB, key });
  return elements ?? null;
}

// The doc's ID in its address (…/document/d/<id>/…), or `value` itself if it
// is an ID already, or "" if it is neither.
export function docId(value) {
  const match = /\/document\/d\/([\w-]{20,})/.exec(value ?? "") ?? /^([\w-]{20,})$/.exec(value ?? "");
  return match ? match[1] : "";
}
