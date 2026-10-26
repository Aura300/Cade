import { callGoogle, googleEnabled } from "./google.js";

// Each group's executive summaries are kept in its Google Doc (its `doc` in
// CHANNEL_PAIRS), shared with the client and gone through on calls with
// them: a section per summary in its Summary tab, newest first. After a
// call, `/cade debrief` reads the section back to find what was added. They
// are written and read through the Google web app (see google.js).
export const docsEnabled = googleEnabled;

// The tab summaries are written in, made if the doc has none.
export const SUMMARY_TAB = "Summary";

// Writes a section in the doc's Summary tab, making the tab if there is
// none: in place of the section with the same `key`, or at the top. A block
// is one of:
//   { type: "heading", level: 2 | 3, text }   level 2 starts the section
//   { type: "paragraph", text, italic? }
//   { type: "item", level: 0 | 1, parts: [{ text, link? }, …] }   a bullet
// Returns the tab's address.
export async function writeSection(env, docId, key, blocks) {
  const { url } = await callGoogle(env, { action: "doc.write", docId, tab: SUMMARY_TAB, key, blocks });
  return url;
}

// The section `key` as it now reads, as a list of { type: "heading" |
// "paragraph" | "item", level, text, links }, `links` being the addresses
// linked from it, or null if the section is gone.
export async function readSection(env, docId, key) {
  const { elements } = await callGoogle(env, { action: "doc.read", docId, tab: SUMMARY_TAB, key });
  return elements ?? null;
}

// The doc's ID in its address (…/document/d/<id>/…), or `value` itself if it
// is an ID already, or "" if it is neither.
export function docId(value) {
  const match = /\/document\/d\/([\w-]{20,})/.exec(value ?? "") ?? /^([\w-]{20,})$/.exec(value ?? "");
  return match ? match[1] : "";
}
