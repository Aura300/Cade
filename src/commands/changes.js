import { linked, oneMessage, request, toAsk, unlinked } from "../notify.js";
import { userNames } from "../sheet.js";
import { callSlack } from "../slack.js";
import { ROLES, loadTask, saveTask } from "../tasks.js";
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

// The pull requests of `task` once `changes` are applied.
export function prsAfter(task, changes) {
  const { add = [], remove = [] } = changes.prs ?? {};
  return [...task.prs.filter((url) => !remove.includes(url)), ...add.filter((url) => !task.prs.includes(url))];
}

// Applies `changes` to the task at `channel`/`ts` for `user` and posts what
// changed in its thread. People are changed first, so they're asked as the
// task stands; then pull requests, and the reviewers kept are asked to review
// the new ones; then the priority and due date, unless it's an
// incident; then the status, unless the task has moved on from `from` since
// the suggestion was made. Returns whether anything changed.
//
// `told` lists who the message a suggestion came from mentioned: it
// notified them already, so they aren't asked again, and the change log
// names them by their Slack name rather than mentioning them.
export async function applyChanges(env, { channel, ts }, changes, user, { from, told: mentioned = [] } = {}) {
  const task = await loadTask(env, channel, ts);
  if (!task) return false;

  // Only the roles there are now: a suggestion posted before owners were
  // called that names developers.
  const people = Object.entries(changes.people ?? {}).filter(([role]) => ROLES[role]).map(([role, { add = [], remove = [] }]) => {
    const change = {
      role,
      added: add.filter((id) => !task.people[role].includes(id)),
      removed: remove.filter((id) => task.people[role].includes(id)),
    };
    task.people[role] = [...task.people[role].filter((id) => !change.removed.includes(id)), ...change.added];
    return change;
  });
  const kept = task.people.reviewer.filter((id) => !(changes.people?.reviewer?.add ?? []).includes(id));
  const told = await namesOf(env, mentioned, people);

  const added = (changes.prs?.add ?? []).filter((url) => !task.prs.includes(url));
  const removed = (changes.prs?.remove ?? []).filter((url) => task.prs.includes(url));
  const prs = { log: [], notes: [] };
  if (added.length || removed.length) {
    task.prs = [...task.prs.filter((url) => !removed.includes(url)), ...added];
    if (added.length) prs.log.push(linked(user, added));
    if (removed.length) prs.log.push(unlinked(user, removed));
    const asked = toAsk(kept, user, told);
    if (added.length && asked.length) prs.notes.push(request(asked, "reviewer", added));
  }
  // People added are asked with the pull requests as they now are.
  const team = teamChanges(user, task, people, told);
  if (team.log.length || prs.log.length) await saveTask(env, channel, ts, task);

  const fields = Object.fromEntries(["priority", "dueDate"].filter((name) => name in changes).map((name) => [name, changes[name]]));
  const details = Object.keys(fields).length ? await detailsChange(env, channel, ts, fields, user) : null;

  const stale = from && task.status !== from;
  const moved =
    changes.status && changes.status !== task.status && !stale ? await statusChange(env, channel, ts, changes.status, user, told) : null;

  const parts = [prs, team, details, moved].filter(Boolean);
  const text = oneMessage(...parts);
  if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
  return Boolean(text);
}

// Those `mentioned` as { [id]: name }: the Slack name of each one the
// change log names, for `people`'s changes, and null for the rest, who are
// only left out of requests. A name that can't be looked up is null too, so
// the log mentions them rather than showing their ID.
async function namesOf(env, mentioned, people) {
  const named = new Set(people.flatMap(({ added, removed }) => [...added, ...removed]));
  const name = async (id) => {
    const found = named.has(id) ? await userNames(env, [id]) : id;
    return found === id ? null : found;
  };
  return Object.fromEntries(await Promise.all(mentioned.map(async (id) => [id, await name(id)])));
}
