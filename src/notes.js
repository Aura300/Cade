import { findProject } from "./channels.js";
import { putTask } from "./db.js";
import { docId } from "./doc.js";
import { callGoogle, googleEnabled } from "./google.js";
import { callSlack } from "./slack.js";
import { taskMessage } from "./tasks.js";

// Each task can have a page in its project's Google Doc for the notes that
// don't fit in Slack: an empty tab of its own under the doc's Notes tab, which
// the team writes in by hand. Cade only makes it and links it: the task keeps
// the page's address (`notes` on the task, see db.js), and its card shows the
// link. A new task gets its page as it is created (see addNotes); Refresh on
// the card's menu and `/cade resync` make one for a task that has none, as
// tasks made before had none (see syncNotes). It goes through the Google web
// app (see google.js, google/Doc.gs).
export const NOTES_TAB = "Notes";

// The tab's title: the task's own, kept to a length a tab can show.
function tabTitle(task) {
  const title = task.title.replace(/\s+/g, " ").trim();
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

// Makes the task's page if it has none, and records its address in
// `task.notes` (nothing is stored here: the caller saves the task, which also
// redraws its card). A task that has one is left alone, as is a task in a
// project without a `doc`. A failure is logged, not thrown: the page is an
// extra, so it shouldn't stop the card being redrawn.
export async function syncNotes(env, channel, ts, task) {
  if (task.notes) return;
  const id = docId(findProject(env, channel)?.doc);
  if (!id || !googleEnabled(env)) return;
  try {
    const { url, tabId } = await callGoogle(env, { action: "doc.task", docId: id, parent: NOTES_TAB, title: tabTitle(task) });
    task.notes = { url, tab: tabId };
  } catch (error) {
    console.warn("Could not make the task's notes page", { ts, error: error.message });
  }
}

// For a task just posted: makes its page, then stores the link and redraws
// the card with it. Nothing changes for a project without a `doc`.
export async function addNotes(env, channel, ts, task) {
  await syncNotes(env, channel, ts, task);
  if (!task.notes) return;
  await putTask(env, channel, ts, task);
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
}
