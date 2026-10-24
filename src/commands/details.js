import { tasksChannelFor } from "../channels.js";
import { NOT_A_TRACKED_REQUIREMENT, findTask, saveTaskDetails } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, PRIORITIES, formatDueDate, loadTask } from "../tasks.js";

const PRIORITY_ACTION = "priority:select";
const DUE_ACTION = "due:select";

// `@LUMA priority` and `@LUMA due` change a task's priority and due date.
// They work in the task's thread in the dev channel, and in the thread of a
// requirement started with `/luma requirement` once a task is tracked from
// it. Either way both root messages are updated, and a change made in the
// external thread is also noted in the task's thread for the team.
//
// Without a value they reply with a menu or date picker. The picker's block_id
// names the task, since in an external thread the picker's own thread is the
// requirement's, not the task's.

// `@LUMA priority high`, or `@LUMA priority` for a menu.
export const priority = {
  name: "priority",
  description: "Change the task's priority (in its thread, or its requirement thread)",
  usage: "@LUMA priority high",
  channel: ["external", "tasks"],
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    if (!found) return notFound(env, command.channel);

    const input = command.text.trim();
    const value = Object.keys(PRIORITIES).find((name) => name.toLowerCase() === input.toLowerCase());
    if (!value) {
      const prompt = input
        ? `"${escapeSlack(input)}" is not a priority. Pick one:`
        : "Pick the new priority:";
      return priorityPicker(prompt, found);
    }
    return change(env, found, { priority: value }, command.user, command.channel);
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
  description: "Change the task's due date (in its thread, or its requirement thread)",
  usage: "@LUMA due 31/12/2026",
  channel: ["external", "tasks"],
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    if (!found) return notFound(env, command.channel);

    const input = command.text.trim();
    if (/^(none|clear|remove)$/i.test(input)) {
      return change(env, found, { dueDate: "" }, command.user, command.channel);
    }
    const dueDate = parseDate(input);
    if (!dueDate) {
      const prompt = input
        ? `"${escapeSlack(input)}" is not a date. Use DD/MM/YYYY, or pick one:`
        : "Pick the new due date:";
      return datePicker(prompt, found);
    }
    return change(env, found, { dueDate }, command.user, command.channel);
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

function notFound(env, channel) {
  return tasksChannelFor(env, channel) === channel ? NOT_A_TASK : NOT_A_TRACKED_REQUIREMENT;
}

// Saves the change and returns the confirmation for the thread it was made
// in. A change from the external thread is also noted in the task's thread.
async function change(env, found, fields, user, channel) {
  Object.assign(found.task, fields);
  await saveTaskDetails(env, found);
  const text = changedText(user, fields);
  if (channel !== found.channel) {
    const from = found.task.source?.link
      ? ` from <${found.task.source.link}|the requirement thread>`
      : " from the requirement thread";
    await callSlack(env, "chat.postMessage", {
      channel: found.channel,
      thread_ts: found.ts,
      ...asMessage(`${text.replace(/\.$/, "")}${from}.`),
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
  const target = JSON.parse(payload.actions[0].block_id);
  const task = await loadTask(env, target.channel, target.ts);
  const reply = task
    ? await change(env, { ...target, task }, fields, payload.user.id, payload.channel.id)
    : NOT_A_TASK;
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

function target(found) {
  return JSON.stringify({ channel: found.channel, ts: found.ts });
}

function priorityPicker(prompt, found) {
  const option = (name) => ({
    text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true },
    value: name,
  });
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        block_id: target(found),
        text: mrkdwn(prompt),
        accessory: {
          type: "static_select",
          action_id: PRIORITY_ACTION,
          placeholder: plainText("Select a priority"),
          options: Object.keys(PRIORITIES).map(option),
          initial_option: option(found.task.priority),
        },
      },
    ],
  };
}

function datePicker(prompt, found) {
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        block_id: target(found),
        text: mrkdwn(prompt),
        accessory: {
          type: "datepicker",
          action_id: DUE_ACTION,
          placeholder: plainText("Select a date"),
          initial_date: pickerDate(found.task.dueDate),
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

// The date picker wants YYYY-MM-DD.
function pickerDate(dueDate) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

// chat.update keeps a message's old blocks unless new ones are sent, so text
// replies are wrapped in a section.
function asMessage(reply) {
  return { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] };
}
