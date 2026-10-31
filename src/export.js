import { findProject } from "./channels.js";
import { putTask } from "./db.js";
import { docId } from "./doc.js";
import { callGoogle, googleEnabled } from "./google.js";
import { formatTime } from "./sheet.js";
import { callSlack } from "./slack.js";

// "Export thread" on a task card's ⋯ menu (see menu.js): the task's thread as
// plain text, in a page of its own in its project's Google Doc, to give to
// whatever summarizes it. Like a task's notes page (see notes.js) it is a tab
// under a tab of the Doc, here Export, but Cade
// writes this one. The task keeps the page's address (`export` on the task,
// see db.js): exporting again writes the same page over, and makes a new one
// only if it was deleted. It goes through the Google web app (see google.js,
// google/Doc.gs).
export const EXPORT_TAB = "Export";

// The tab's title: the task's own, then " (thread)", as the title of a tab
// must be unique in the whole doc and the task's notes page (see notes.js) has
// the task's own. Kept to the 50 characters Google Docs allows in one (longer
// ones make addDocumentTab fail).
const TAB_TITLE_MAX = 50;
const TAB_SUFFIX = " (thread)";
const PAGE = 200;
const MAX_PAGES = 5;

export function tabTitle(task) {
  const room = TAB_TITLE_MAX - TAB_SUFFIX.length;
  const title = task.title.replace(/\s+/g, " ").trim();
  return `${title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title}${TAB_SUFFIX}`;
}

async function readThread(env, channel, ts) {
  const messages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await callSlack(env, "conversations.replies", { channel, ts, limit: PAGE, cursor });
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return messages;
}

// Display names for the Slack user IDs, looked up once each, as a Map. For an
// ID that can't be (no users:read scope, or one Slack doesn't know) the ID
// itself stands in.
async function nameMap(env, ids) {
  const names = new Map();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const { user } = await callSlack(env, "users.info", { user: id });
        names.set(id, user.profile?.display_name || user.real_name || user.name || id);
      } catch (error) {
        console.warn("Could not look up user", { id, error: error.message });
        names.set(id, id);
      }
    }),
  );
  return names;
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Slack's markup as plain text: mentions and channels by name, links as
// "label (address)", and the escaped &, < and > as themselves.
export function plain(text, names) {
  return text
    .replace(MENTION, (_, id) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The thread as text: its task's title, then a block per message, "Name ·
// time" and its text.
export async function threadText(env, channel, ts, task) {
  const messages = await readThread(env, channel, ts);
  const ids = new Set();
  for (const message of messages) {
    if (message.user) ids.add(message.user);
    for (const [, id] of (message.text ?? "").matchAll(MENTION)) ids.add(id);
  }
  const names = await nameMap(env, ids);
  const blocks = messages.map((message) => {
    const who = message.user ? names.get(message.user) : (message.username ?? message.bot_profile?.name ?? "Someone");
    const when = formatTime(env, new Date(Number(message.ts) * 1000));
    let text = plain(message.text ?? "", names);
    if (message.files?.length) text += `${text ? "\n" : ""}(attachment: ${message.files.map((file) => (file.permalink ? `${file.name} ${file.permalink}` : file.name)).join(", ")})`;
    return `${who} · ${when}\n${text || "(no text)"}`;
  });
  return `Thread: ${task.title}\n\n${blocks.join("\n\n")}`;
}

// Writes the task's thread to its page in the project's Doc, making the page
// if it has none, saves the task with its address and returns it. Returns
// null for a project without a `doc`, or without the Google web app. Throws
// if Slack or Google fails.
export async function exportThread(env, channel, ts, task) {
  const id = docId(findProject(env, channel)?.doc);
  if (!id || !googleEnabled(env)) return null;
  const text = await threadText(env, channel, ts, task);
  const { url, tabId } = await callGoogle(env, {
    action: "doc.export",
    docId: id,
    parent: EXPORT_TAB,
    title: tabTitle(task),
    tabId: task.export?.tab,
    text,
  });
  task.export = { url, tab: tabId };
  await putTask(env, channel, ts, task);
  return url;
}
