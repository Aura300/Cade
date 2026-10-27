import { oneMessage } from "../notify.js";
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
// dueDate }, each optional.

// Applies `changes` to the task at `channel`/`ts` for `user` and posts what
// changed in its thread. People are changed first, so they're asked as the
// task stands; then the priority and due date, where the team owns them;
// then the status, unless the task has moved on from `from` since the
// suggestion was made. Returns whether anything changed.
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
  const team = teamChanges(user, task, people);
  if (team.log.length) await saveTask(env, channel, ts, task);

  const fields = Object.fromEntries(["priority", "dueDate"].filter((name) => name in changes).map((name) => [name, changes[name]]));
  const details = Object.keys(fields).length ? await detailsChange(env, channel, ts, fields, user) : null;

  const stale = from && task.status !== from;
  const moved =
    changes.status && changes.status !== task.status && !stale ? await statusChange(env, channel, ts, changes.status, user) : null;

  const parts = [team, details, moved].filter(Boolean);
  const text = oneMessage(...parts);
  if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
  return Boolean(text);
}
