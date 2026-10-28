import { escapeSlack } from "../slack.js";
import { INCIDENT_IS_FIXED, NOT_A_TASK, PRIORITIES, loadTask } from "../tasks.js";
import { acknowledged, changeTask } from "./changes.js";

// `@Cade priority high` and `@Cade due 31/12/2026`, in a task's thread,
// change its priority and due date, and Cade reacts ✅ to the message.
// Without a value they say what to send. Incidents are always urgent and
// due immediately, so theirs never change.

// `@Cade priority high`.
export const priority = {
  name: "priority",
  description: "Change the task's priority (in its thread)",
  usage: "@Cade priority high",
  section: "task",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    const problem = cannotChange(found);
    if (problem) return problem;

    const input = command.text.trim();
    const value = Object.keys(PRIORITIES).find((name) => name.toLowerCase() === input.toLowerCase());
    if (!value) {
      const asked = input ? `I don't know "${escapeSlack(input)}" as a priority.` : "Which priority?";
      return `${asked} Try \`@Cade priority high\`: urgent, high, medium or low.`;
    }
    return acknowledged(await changeTask(env, found, { priority: value }, command.user));
  },
};

// `@Cade due 31/12/2026`, or `@Cade due none` to clear it.
export const due = {
  name: "due",
  description: "Change the task's due date (in its thread)",
  usage: "@Cade due 31/12/2026",
  section: "task",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    const problem = cannotChange(found);
    if (problem) return problem;

    const input = command.text.trim();
    if (/^(none|clear|remove)$/i.test(input)) {
      return acknowledged(await changeTask(env, found, { dueDate: "" }, command.user));
    }
    const dueDate = parseDate(input);
    if (!dueDate) {
      const asked = input ? `I couldn't read "${escapeSlack(input)}" as a date.` : "When is it due?";
      return `${asked} Try \`@Cade due 31/12/2026\`, or \`@Cade due none\` to clear it.`;
    }
    return acknowledged(await changeTask(env, found, { dueDate }, command.user));
  },
};

// The task at `channel`/`ts`, as { channel, ts, item }, or null.
async function findTask(env, channel, ts) {
  const item = await loadTask(env, channel, ts);
  return item && { channel, ts, item };
}

// Explains why the task's priority and due date cannot be changed, if they
// cannot.
function cannotChange(found) {
  if (!found) return NOT_A_TASK;
  if (found.item.incident) return INCIDENT_IS_FIXED;
  return undefined;
}

// Reads DD/MM/YYYY (or D/M/YYYY, or YYYY-MM-DD) as DD/MM/YYYY, or "" when it
// is not a real date.
export function parseDate(input) {
  let day, month, year;
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(input);
  if (match) [, day, month, year] = match;
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input))) [, year, month, day] = match;
  else return "";

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== Number(day) || date.getUTCMonth() !== month - 1) return "";
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}
