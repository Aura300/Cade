import { changeMessage, changeRequests } from "../notify.js";
import { acknowledge, callSlack } from "../slack.js";
import { ROLES, loadTask, saveTask } from "../tasks.js";
import { afterStatusChange, setStatusFields } from "./status.js";

// Suggestions work in three steps:
//   1. detecting what a message asks to change, by its phrases (suggest.js)
//      or with AI (ai-suggest.js), each asking whoever wrote it, privately,
//      in its own way;
//   2. once confirmed, applying the changes, here;
//   3. telling the thread, as one message made from what actually changed:
//      the change log, then what it means for the people it names (see
//      notify.js). A typed command shows its change on the task card, so it
//      acknowledges with a ✅ and posts only the second part (see
//      acknowledged).
// Changes are { people: { [role]: { add, remove } }, status, priority,
// dueDate, prs: { add, remove } }, each optional; pull requests are links.

// The pull requests of `task` once `changes` are applied.
export function prsAfter(task, changes) {
  const { add = [], remove = [] } = changes.prs ?? {};
  return [...task.prs.filter((url) => !remove.includes(url)), ...add.filter((url) => !task.prs.includes(url))];
}

// Applies `changes` to the task at `channel`/`ts` for `user`, and posts what
// changed in its thread. Returns whether anything changed.
//
// `told` lists who the message a suggestion came from mentioned: it
// notified them already, so they aren't asked again; the change log still
// mentions them.
export async function applyChanges(env, where, changes, user, options) {
  const change = await changeTask(env, where, changes, user, options);
  const text = change && changeMessage(change);
  if (text) await callSlack(env, "chat.postMessage", { channel: where.channel, thread_ts: where.ts, text });
  return Boolean(text);
}

// Applies `changes` to the task at `channel`/`ts` for `user`, all to the one
// task, saved once, and returns what actually changed, as notify.js reads
// it, or null when nothing did or the task is gone. Only what differs is a
// change: someone already an owner isn't added again, nor a status set
// that it has. The priority and due date of an incident never change, and
// the status is left alone when the task has moved on from `from` since a
// suggestion was made. Telling the thread is left to the caller.
export async function changeTask(env, { channel, ts }, changes, user, { from, told: mentioned = [] } = {}) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  // Left out of requests, not of the change log, which still mentions them.
  const told = Object.fromEntries(mentioned.map((id) => [id, null]));
  const change = { user, told, task, people: [], prs: null, priority: null, dueDate: null, status: null };

  // Only the roles there are now: a suggestion posted before owners were
  // called that names developers.
  for (const [role, { add = [], remove = [] }] of Object.entries(changes.people ?? {})) {
    if (!ROLES[role]) continue;
    const added = add.filter((id) => !task.people[role].includes(id));
    const removed = remove.filter((id) => task.people[role].includes(id));
    task.people[role] = [...task.people[role].filter((id) => !removed.includes(id)), ...added];
    if (added.length || removed.length) change.people.push({ role, added, removed });
  }

  const added = (changes.prs?.add ?? []).filter((url) => !task.prs.includes(url));
  const removed = (changes.prs?.remove ?? []).filter((url) => task.prs.includes(url));
  if (added.length || removed.length) {
    task.prs = [...task.prs.filter((url) => !removed.includes(url)), ...added];
    change.prs = { added, removed };
  }

  for (const name of task.incident ? [] : ["priority", "dueDate"]) {
    if (name in changes && (task[name] ?? "") !== changes[name]) {
      change[name] = { from: task[name], to: changes[name] };
      task[name] = changes[name];
    }
  }

  const stale = from && task.status !== from;
  if (changes.status && changes.status !== task.status && !stale) {
    change.status = { from: task.status, to: changes.status };
    setStatusFields(task, changes.status);
  }

  if (!change.people.length && !change.prs && !change.priority && !change.dueDate && !change.status) return null;
  await saveTask(env, channel, ts, task);
  if (change.status) await afterStatusChange(env, channel, ts, change.status, user);
  return change;
}

// The reply to a typed command that made `change` (see changeTask): a ✅ on
// the command, and the requests the change means for people, if any.
export function acknowledged(change) {
  const notes = change ? changeRequests(change) : [];
  return acknowledge(notes.join("\n") || undefined);
}
