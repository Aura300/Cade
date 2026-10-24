import { mentions } from "../slack.js";
import { NOT_A_TASK, loadTask, saveTask } from "../tasks.js";

// `@LUMA assign @person [@person …]` in a task thread adds people to the task.
export default {
  name: "assign",
  description: "Assign people to the task (in its thread)",
  usage: "@LUMA assign @person",
  channel: "TASK_CHANNEL_ID",
  inThread: true,
  async run(command, { env }) {
    if (!command.mentions.length) {
      return "Mention who to assign, for example `@LUMA assign @person`.";
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.assignees = [...new Set([...task.assignees, ...command.mentions])];
    await saveTask(env, command.channel, command.threadTs, task);
    return `<@${command.user}> assigned ${mentions(command.mentions)}.`;
  },
};
