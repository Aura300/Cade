import { mentions } from "../slack.js";
import { NOT_A_TASK, ROLES, loadTask, parseRole, saveTask } from "../tasks.js";

// `@LUMA assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way.
export default {
  name: "assign",
  description: "Assign a developer, reviewer or tester (in its thread)",
  usage: "@LUMA assign developer @person",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    if (!role) {
      const examples = Object.keys(ROLES)
        .map((name) => `\`@LUMA assign ${name} @person\``)
        .join(", ");
      return `Say which role to assign: ${examples}.`;
    }
    if (!command.mentions.length) {
      return `Mention who to assign, for example \`@LUMA assign ${role} @person\`.`;
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.people[role] = [...new Set([...task.people[role], ...command.mentions])];
    await saveTask(env, command.channel, command.threadTs, task);
    return `<@${command.user}> assigned ${mentions(command.mentions)} as ${role}.`;
  },
};
