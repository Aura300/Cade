import { assigned, noLongerIfDue, requestIfDue, unassigned } from "../notify.js";
import { acknowledge } from "../slack.js";
import { NOT_A_TASK, loadTask, parseRole, saveTask } from "../tasks.js";

// `@Cade assign owner @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way, and short words
// do too: `dev`, `review`, `test` or `qa`. Cade reacts ✅ to the command and,
// in a message of its own, asks them to do their part. Without a role and
// someone mentioned, it says what to send; the task card's ⋯ → Edit has
// every role in one form.
//
// People are only asked when there's something for them to do: reviewers
// added ahead of a PR are asked by `@Cade pr add` once there is one, and
// testers when the task moves to In testing (see notify.js).
//
// People also ask for roles in their own words, such as "@mia can you
// review this?". Then Cade asks whoever wrote it, privately (see
// suggest.js).
export default {
  name: "assign",
  description: "Assign an owner, reviewer or tester (in its thread)",
  usage: "@Cade assign owner @person",
  section: "task",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const { channel, threadTs, user } = command;
    const role = parseRole(command.text);
    if (!role || !command.mentions.length) return ASSIGN_USAGE;

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.people[role] = [...new Set([...task.people[role], ...command.mentions])];
    await saveTask(env, channel, threadTs, task);
    // The task card shows who is on it, so a ✅ says it was done; only the
    // request to them is posted.
    const { notes } = teamChanges(user, task, [{ role, added: command.mentions, removed: [] }]);
    return acknowledge(notes.join("\n") || undefined);
  },
};

const ASSIGN_USAGE = `Who, and as what? Try ${["owner", "review", "test"].map((name) => `\`@Cade assign ${name} @person\``).join(", ")}.`;

// The thread's record of `user` changing who's on the task, as { log,
// notes } for oneMessage: the change log, a line per role for who was
// assigned and who was removed, and what it means for them, a line each,
// only when there's something for them to do now (see notify.js). Shared
// with `@Cade assign` and suggestions, whose message `told` some of them
// already.
export function teamChanges(user, task, changes, told = {}) {
  const log = [];
  const notes = [];
  for (const { role, added, removed } of changes) {
    if (added.length) log.push(assigned(user, added, role, told));
    if (removed.length) log.push(unassigned(user, removed, role, told));
    notes.push(added.length && requestIfDue(task, added, role, user, told), removed.length && noLongerIfDue(task, removed, role, user, told));
  }
  return { log, notes: notes.filter(Boolean) };
}
