import { roleOf } from "../channels.js";
import { INCIDENT_IS_FIXED, NOT_A_REQUIREMENT, findDetails, saveDetails } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, PRIORITIES, formatDueDate, pickerDate } from "../tasks.js";

const PRIORITY_ACTION = "priority:select";
const DUE_ACTION = "due:select";

// `@LUMA priority` and `@LUMA due` change a priority and due date. The client
// decides these for a requirement, so they are changed in the thread of a
// requirement started with `/luma requirement`, before and after a task is
// tracked from it. A tracked task follows the requirement, and Luma notes the
// change in the task's thread for the team. In that task's thread they cannot
// be changed. Tasks with no requirement, such as the team's own work, have no
// client, so their priority and due date are changed in the task's thread.
// Incidents are always urgent and due immediately, so theirs never change.
//
// Without a value they reply with a menu or date picker. Like the status
// menu, the picker's thread says what it changes.

// `@LUMA priority high`, or `@LUMA priority` for a menu.
export const priority = {
  name: "priority",
  description: "Change the priority (in a requirement thread, or a task thread with no requirement)",
  usage: "@LUMA priority high",
  section: "thread",
  channel: ["external", "tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const found = await findDetails(env, command.channel, command.threadTs);
    const problem = cannotChange(env, command.channel, found);
    if (problem) return problem;

    const input = command.text.trim();
    const value = Object.keys(PRIORITIES).find((name) => name.toLowerCase() === input.toLowerCase());
    if (!value) {
      const prompt = input
        ? `"${escapeSlack(input)}" is not a priority. Pick one:`
        : "Pick the new priority:";
      return priorityPicker(prompt, found.item.priority);
    }
    return change(env, found, { priority: value }, command.user);
  },
  actions: {
    [PRIORITY_ACTION]: async (payload, context) => {
      context.waitUntil(
        select(payload, context.env, { priority: payload.actions[0].selected_option.value }),
      );
    },
  },
};

// `@LUMA due 31/12/2026`, `@LUMA due none` to clear it, or `@LUMA due` for a
// date picker.
export const due = {
  name: "due",
  description: "Change the due date (in a requirement thread, or a task thread with no requirement)",
  usage: "@LUMA due 31/12/2026",
  section: "thread",
  channel: ["external", "tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const found = await findDetails(env, command.channel, command.threadTs);
    const problem = cannotChange(env, command.channel, found);
    if (problem) return problem;

    const input = command.text.trim();
    if (/^(none|clear|remove)$/i.test(input)) {
      return change(env, found, { dueDate: "" }, command.user);
    }
    const dueDate = parseDate(input);
    if (!dueDate) {
      const prompt = input
        ? `"${escapeSlack(input)}" is not a date. Use DD/MM/YYYY, or pick one:`
        : "Pick the new due date:";
      return datePicker(prompt, found.item.dueDate);
    }
    return change(env, found, { dueDate }, command.user);
  },
  actions: {
    [DUE_ACTION]: async (payload, context) => {
      context.waitUntil(
        select(payload, context.env, {
          dueDate: formatDueDate(payload.actions[0].selected_date),
        }),
      );
    },
  },
};

// Explains why the thread's priority and due date cannot be changed here, if
// they cannot.
function cannotChange(env, channel, found) {
  if (!found) return roleOf(env, channel) === "external" ? NOT_A_REQUIREMENT : NOT_A_TASK;
  if (found.kind === "incident") return INCIDENT_IS_FIXED;
  if (found.kind !== "client") return undefined;
  const thread = found.item.source.link
    ? `<${found.item.source.link}|the requirement thread>`
    : "the requirement thread";
  return `The client sets this task's priority and due date. Change them in ${thread}.`;
}

// Saves the change and returns the confirmation. A change to a requirement
// with a tracked task is also noted in the task's thread.
async function change(env, found, fields, user) {
  await saveDetails(env, found, fields);
  const text = changedText(user, fields);
  if (found.task) {
    const { permalink } = await callSlack(env, "chat.getPermalink", {
      channel: found.channel,
      message_ts: found.ts,
    });
    await callSlack(env, "chat.postMessage", {
      channel: found.task.channel,
      thread_ts: found.task.ts,
      ...asMessage(`${text.replace(/\.$/, "")} in <${permalink}|the requirement thread>.`),
    });
  }
  return text;
}

function changedText(user, { priority, dueDate }) {
  if (priority) return `<@${user}> set the priority to ${PRIORITIES[priority]} ${priority}.`;
  return dueDate
    ? `<@${user}> set the due date to ${dueDate}.`
    : `<@${user}> removed the due date.`;
}

// Applies a menu or date picker choice and replaces the picker with the
// confirmation.
async function select(payload, env, fields) {
  const channel = payload.channel.id;
  const found = await findDetails(env, channel, payload.message.thread_ts);
  const reply = cannotChange(env, channel, found) ?? (await change(env, found, fields, payload.user.id));
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

function priorityPicker(prompt, current) {
  const option = (name) => ({
    text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true },
    value: name,
  });
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        text: mrkdwn(prompt),
        accessory: {
          type: "static_select",
          action_id: PRIORITY_ACTION,
          placeholder: plainText("Select a priority"),
          options: Object.keys(PRIORITIES).map(option),
          initial_option: option(current),
        },
      },
    ],
  };
}

function datePicker(prompt, current) {
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        text: mrkdwn(prompt),
        accessory: {
          type: "datepicker",
          action_id: DUE_ACTION,
          placeholder: plainText("Select a date"),
          initial_date: pickerDate(current),
        },
      },
    ],
  };
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

// chat.update keeps a message's old blocks unless new ones are sent, so text
// replies are wrapped in a section.
function asMessage(reply) {
  return { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] };
}
