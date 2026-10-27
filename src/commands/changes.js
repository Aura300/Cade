import { linked, oneMessage, request, unlinked } from "../notify.js";
import { callSlack } from "../slack.js";
import { loadTask, saveTask } from "../tasks.js";
import { teamChanges } from "./assign.js";
import { detailsChange } from "./details.js";
import { statusChange } from "./status.js";

// Suggestions work in three steps:
//   1. detecting what a message asks to change, by its phrases (suggest.js)
//      or with AI (ai-suggest.js), each asking whoever wrote it, privately,
//      in its own way;
//   2. once confirmed, applying the changes, here;
//   3. telling the thread, as one message: the change log, then what it
//      means for the people it names (see notify.js).
// Changes are { people: { [role]: { add, remove } }, status, priority,
// dueDate, prs: { add, remove } }, each optional; pull requests are links.

// Linking a pull request means the work is ready for review (see pr.js).
const BEFORE_REVIEW = ["TODO", "IN_PROGRESS"];

// Applies `changes` to the task at `channel`/`ts` for `user` and posts what
// changed in its thread. People are changed first, so they're asked as the
// task stands; then pull requests, which move a task not yet in review to In
// review unless the status is changed too, and the reviewers kept are asked
// to review the new ones; then the priority and due date, unless it's an
// incident; then the status, unless the task has moved on from `from` since
// the suggestion was made. Returns whether anything changed.
export async function applyChanges(env, { channel, ts }, changes, user, { from } = {}) {
  const task = await loadTask(env, channel, ts);
  if (!task) return false;

  const people = Object.entries(changes.people ?? {}).map(([role, { add = [], remove = [] }]) => {
    const change = {
      role,
      added: add.filter((id) => !task.people[role].includes(id)),
      removed: remove.filter((id) => task.people[role].includes(id)),
    };
    task.people[role] = [...task.people[role].filter((id) => !change.removed.includes(id)), ...change.added];
    return change;
  });
  const kept = task.people.reviewer.filter((id) => !(changes.people?.reviewer?.add ?? []).includes(id));

  const added = (changes.prs?.add ?? []).filter((url) => !task.prs.includes(url));
  const removed = (changes.prs?.remove ?? []).filter((url) => task.prs.includes(url));
  const prs = { log: [], notes: [] };
  if (added.length || removed.length) {
    task.prs = [...task.prs.filter((url) => !removed.includes(url)), ...added];
    const moved = added.length > 0 && !changes.status && BEFORE_REVIEW.includes(task.status);
    if (moved) task.status = "IN_REVIEW";
    if (added.length) prs.log.push(linked(user, added, moved));
    if (removed.length) prs.log.push(unlinked(user, removed));
    if (added.length && kept.length) prs.notes.push(request(kept, "reviewer", added));
  }
  // People added are asked with the pull requests as they now are.
  const team = teamChanges(user, task, people);
  if (team.log.length || prs.log.length) await saveTask(env, channel, ts, task);

  const fields = Object.fromEntries(["priority", "dueDate"].filter((name) => name in changes).map((name) => [name, changes[name]]));
  const details = Object.keys(fields).length ? await detailsChange(env, channel, ts, fields, user) : null;

  const stale = from && task.status !== from;
  const moved =
    changes.status && changes.status !== task.status && !stale ? await statusChange(env, channel, ts, changes.status, user) : null;

  const parts = [prs, team, details, moved].filter(Boolean);
  const text = oneMessage(...parts);
  if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
  return Boolean(text);
}
