import { mentions } from "../slack.js";
import { NOT_A_TASK, ROLES, loadTask, parseRole, saveTask } from "../tasks.js";

// `@LUMA unassign developer @person [@person …]` in a task thread removes
// people from that role; `@LUMA unassign @person` removes them from every role.
export default {
  name: "unassign",
  description: "Unassign people from a role, or from every role (in its thread)",
  usage: "@LUMA unassign developer @person",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    if (!command.mentions.length) {
      return "Mention who to unassign, for example `@LUMA unassign developer @person`.";
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    const role = parseRole(command.text);
    for (const name of role ? [role] : Object.keys(ROLES)) {
      task.people[name] = task.people[name].filter((id) => !command.mentions.includes(id));
    }
    await saveTask(env, command.channel, command.threadTs, task);
    const from = role ? ` as ${role}` : "";
    return `<@${command.user}> unassigned ${mentions(command.mentions)}${from}.`;
  },
};
