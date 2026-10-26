import { NOT_A_TASK, ROLES, loadTask, parseRole, saveTask } from "../tasks.js";
import { noLonger, roleButtons } from "./assign.js";

// `@Cade unassign developer @person [@person …]` in a task thread removes
// people from that role; `@Cade unassign @person` removes them from every role.
// They're told they no longer need to do it. Without anyone mentioned it offers the same role buttons and form as
// `@Cade assign`.
export default {
  name: "unassign",
  description: "Unassign people from a role, or from every role (in its thread)",
  usage: "@Cade unassign dev @person",
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    if (!command.mentions.length) return roleButtons(role ? [role] : Object.keys(ROLES));

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    const removed = new Set();
    for (const name of role ? [role] : Object.keys(ROLES)) {
      for (const id of task.people[name]) if (command.mentions.includes(id)) removed.add(id);
      task.people[name] = task.people[name].filter((id) => !command.mentions.includes(id));
    }
    if (!removed.size) {
      const as = role ? ` as ${ROLES[role].toLowerCase()}` : "";
      return `Looks like ${command.mentions.length === 1 ? "they aren't" : "none of them are"} assigned to this task${as}.`;
    }
    await saveTask(env, command.channel, command.threadTs, task);
    return noLonger([...removed], role);
  },
};
