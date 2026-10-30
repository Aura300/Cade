import { NOT_A_TASK, loadTask, parseRole } from "../tasks.js";
import { acknowledged, changeTask } from "./changes.js";

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
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    const { channel, threadTs, user } = command;
    const role = parseRole(command.text);
    if (!role || !command.mentions.length) return ASSIGN_USAGE;

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    // The task card shows who is on it, so a ✅ says it was done; only the
    // request to them is posted.
    const changes = { people: { [role]: { add: [...new Set(command.mentions)] } } };
    return acknowledged(await changeTask(env, { channel, ts: threadTs }, changes, user));
  },
};

const ASSIGN_USAGE = `Who, and as what? Try ${["owner", "review", "test"].map((name) => `\`@Cade assign ${name} @person\``).join(", ")}.`;
