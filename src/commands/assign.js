import { mentions } from "../slack.js";
import { NOT_A_TASK, ROLES, loadTask, parseRole, prLink, saveTask } from "../tasks.js";

// What Luma asks of people when they are assigned to each role.
const REQUESTS = {
  developer: "please start working on this.",
  tester: "please test this.",
};

// `@LUMA assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way. The reply mentions
// them with what to do next.
//
// There is nothing to review until a pull request is linked, so reviewers
// can be added ahead of time: until then the reply names no one, so they are
// not notified, and `@LUMA pr add` asks them to review once there is a PR.
export default {
  name: "assign",
  description: "Assign a developer, reviewer or tester (in its thread)",
  usage: "@LUMA assign developer @person",
  channel: ["tasks", "incidents"],
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
    if (role === "reviewer") {
      if (!task.prs.length) {
        const count = command.mentions.length === 1 ? "a reviewer" : `${command.mentions.length} reviewers`;
        return `<@${command.user}> added ${count}. They'll be asked to review when a PR is linked.`;
      }
      return `${mentions(command.mentions)}, please review ${task.prs.map(prLink).join(", ")}.`;
    }
    return `${mentions(command.mentions)} ${REQUESTS[role]}`;
  },
};
