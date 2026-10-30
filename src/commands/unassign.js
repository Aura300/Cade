import { NOT_A_TASK, ROLES, loadTask, parseRole } from "../tasks.js";
import { acknowledged, changeTask } from "./changes.js";

// `@Cade unassign owner @person [@person …]` in a task thread removes
// people from that role; `@Cade unassign @person` removes them from every role.
// Cade reacts ✅ to the command and, if they'd been asked to, tells them
// there's no need to do it anymore (see notify.js).
// Without anyone mentioned it says what to send.
export default {
  name: "unassign",
  description: "Unassign people from a role, or from every role (in its thread)",
  usage: "@Cade unassign owner @person",
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    if (!command.mentions.length) return "Who? Try `@Cade unassign owner @person`, or `@Cade unassign @person` for every role.";

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    const roles = role ? [role] : Object.keys(ROLES);
    const people = Object.fromEntries(roles.map((name) => [name, { remove: command.mentions }]));
    if (!roles.some((name) => task.people[name].some((id) => command.mentions.includes(id)))) {
      const as = role ? ` as ${ROLES[role].toLowerCase()}` : "";
      return `Looks like ${command.mentions.length === 1 ? "they aren't" : "none of them are"} assigned to this task${as}.`;
    }
    return acknowledged(await changeTask(env, { channel: command.channel, ts: command.threadTs }, { people }, command.user));
  },
};
