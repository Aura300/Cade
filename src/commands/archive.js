import { markTaskArchived } from "../db.js";
import { callSlack } from "../slack.js";
import { NOT_A_TASK, loadTask, refreshSummary, setPinned, syncTask, taskMessage } from "../tasks.js";

// `@Cade archive` in a task's thread, or Archive on its card's ⋯ menu,
// puts away a task that's no longer needed. Cade stops tracking it, so it
// leaves `/cade tasks`, standups, syncups and briefs, and commands in its
// thread no longer find it; but nothing is deleted, and the summary lists
// it under Archived. Its card stays, unpinned, saying who archived it, with
// no menu; its thread stays and hears who archived it; and its Sheet row
// says Archived. `/cade remove <link>` can still delete it.
export default {
  name: "archive",
  description: "Archive the task: Cade stops tracking it, and its thread stays (in its thread)",
  usage: "@Cade archive",
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    return (await archiveTask(env, command.channel, command.threadTs, command.user)) ?? NOT_A_TASK;
  },
};

// Archives the task at `channel`/`ts` for `user`, and returns what its
// thread hears, or null if it isn't a task Cade is tracking.
export async function archiveTask(env, channel, ts, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  await markTaskArchived(env, channel, ts, user);
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task, { archivedBy: user }) });
  await setPinned(env, channel, ts, false);
  await syncTask(env, channel, ts, task, { archived: true });
  await refreshSummary(env, channel);
  console.log("Task archived", { ts, user });
  return `<@${user}> archived this task.`;
}
