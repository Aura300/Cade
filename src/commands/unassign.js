import { mentions } from "../slack.js";
import { NOT_A_TASK, loadTask, saveTask } from "../tasks.js";

// `@LUMA unassign @person [@person …]` in a task thread removes people from the
// task.
export default {
  name: "unassign",
  description: "Unassign people from the task (in its thread)",
  usage: "@LUMA unassign @person",
  channel: "TASK_CHANNEL_ID",
  inThread: true,
  async run(command, { env }) {
    if (!command.mentions.length) {
      return "Mention who to unassign, for example `@LUMA unassign @person`.";
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.assignees = task.assignees.filter((id) => !command.mentions.includes(id));
    await saveTask(env, command.channel, command.threadTs, task);
    return `<@${command.user}> unassigned ${mentions(command.mentions)}.`;
  },
};
