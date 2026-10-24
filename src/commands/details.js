import { tasksChannelFor } from "../channels.js";
import {
  NOT_A_REQUIREMENT,
  findDetails,
  loadDetails,
  reflectOnRequirement,
  saveDetails,
} from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, PRIORITIES, formatDueDate, loadTask, pickerDate } from "../tasks.js";

const PRIORITY_ACTION = "priority:select";
const DUE_ACTION = "due:select";
const INFORM_ACTION = "details:inform";
const SKIP_ACTION = "details:skip";

// `@LUMA priority` and `@LUMA due` change a priority and due date. In a
// task's thread in the dev channel they change the task. In the thread of a
// requirement started with `/luma requirement` they change the requirement,
// so `@LUMA track` starts with the new values; once a task is tracked from
// it, the task owns them and they can only be changed in the task's thread.
// Other external threads have no priority to change, since only Luma's own
// messages can be updated.
//
// When a task with an external thread changes, the confirmation asks whether
// Luma should tell that thread, or whether someone will tell them themselves.
// Telling a requirement thread also updates the requirement's message.
//
// Without a value they reply with a menu or date picker. The picker's block_id
// names what it changes, since in an external thread the picker's own thread
// is the requirement's, not the task's.

// `@LUMA priority high`, or `@LUMA priority` for a menu.
export const priority = {
  name: "priority",
  description: "Change the priority (in a task thread, or a requirement thread until it is tracked)",
  usage: "@LUMA priority high",
  channel: ["external", "tasks"],
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
      return priorityPicker(prompt, found);
    }
    return change(env, found, { priority: value }, command.user);
  },
  actions: {
    [PRIORITY_ACTION]: async (payload, context) => {
      context.waitUntil(
        select(payload, context.env, { priority: payload.actions[0].selected_option.value }),
      );
    },
    [INFORM_ACTION]: async (payload, context) => {
      context.waitUntil(inform(payload, context.env));
    },
    [SKIP_ACTION]: async (payload, context) => {
      const request = JSON.parse(payload.actions[0].value);
      await resolvePrompt(
        payload,
        context.env,
        request,
        `<@${payload.user.id}> will tell the external thread.`,
      );
    },
  },
};

// `@LUMA due 31/12/2026`, `@LUMA due none` to clear it, or `@LUMA due` for a
// date picker.
export const due = {
  name: "due",
  description: "Change the due date (in a task thread, or a requirement thread until it is tracked)",
  usage: "@LUMA due 31/12/2026",
  channel: ["external", "tasks"],
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
      return datePicker(prompt, found);
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

function notFound(env, channel) {
  return tasksChannelFor(env, channel) === channel ? NOT_A_TASK : NOT_A_REQUIREMENT;
}

// Explains why the thread's priority and due date cannot be changed here, if
// they cannot.
function cannotChange(env, channel, found) {
  if (!found) return notFound(env, channel);
  if (found.kind !== "tracked") return undefined;
  const { link, title } = found.item.task;
  return `This requirement is tracked as <${link}|${escapeSlack(title)}>. Change its priority and due date in the task's thread.`;
}

// Saves the change and returns the confirmation. For a task with an external
// thread, the confirmation asks whether to tell that thread.
async function change(env, found, fields, user) {
  Object.assign(found.item, fields);
  await saveDetails(env, found);
  const text = changedText(user, fields);
  if (found.kind !== "task" || !found.item.source) return text;

  // The buttons carry everything needed to post the announcement later.
  const value = JSON.stringify({ channel: found.channel, ts: found.ts, fields, user });
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(`${text}\nShould Luma tell the external thread?`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: INFORM_ACTION,
            text: plainText("Inform external thread"),
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: SKIP_ACTION,
            text: plainText("I'll tell them"),
            value,
          },
        ],
      },
    ],
  };
}

function changedText(user, fields) {
  if (fields.priority) return `<@${user}> set the priority to ${describe(fields)}.`;
  return fields.dueDate
    ? `<@${user}> set the due date to ${fields.dueDate}.`
    : `<@${user}> removed the due date.`;
}

// A priority with its emoji, or a due date ("none" when there is none).
function describe({ priority, dueDate }) {
  if (priority) return `${PRIORITIES[priority]} ${priority}`;
  return dueDate || "none";
}

// Applies a menu or date picker choice and replaces the picker with the
// confirmation.
async function select(payload, env, fields) {
  const found = await loadDetails(env, JSON.parse(payload.actions[0].block_id));
  const reply = found
    ? await change(env, found, fields, payload.user.id)
    : notFound(env, payload.channel.id);
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

async function inform(payload, env) {
  const request = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, request.channel, request.ts);
  const [field] = Object.keys(request.fields);

  let outcome;
  if (!task) {
    outcome = NOT_A_TASK;
  } else if (task[field] !== request.fields[field]) {
    // Someone changed it again before the button was clicked.
    const name = field === "priority" ? "priority" : "due date";
    outcome = `Not sent: the ${name} is now ${describe({ [field]: task[field] })}.`;
  } else {
    await announce(env, request, task);
    outcome = `<@${payload.user.id}> informed the external thread.`;
  }
  await resolvePrompt(payload, env, request, outcome);
}

// Matches the "marked a task as" announcement for status changes, and shows
// the change on the requirement's message if the task came from one.
async function announce(env, request, task) {
  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel: request.channel,
    message_ts: request.ts,
  });
  const link = `<${permalink}|${escapeSlack(task.title)}>`;
  const { priority, dueDate } = request.fields;
  let text;
  if (priority) text = `<@${request.user}> set the priority of ${link} to ${describe({ priority })}.`;
  else if (dueDate) text = `<@${request.user}> set the due date of ${link} to ${dueDate}.`;
  else text = `<@${request.user}> removed the due date of ${link}.`;
  await callSlack(env, "chat.postMessage", {
    channel: task.source.channel,
    thread_ts: task.source.threadTs,
    ...asMessage(text),
  });
  await reflectOnRequirement(env, request.ts, task, request.fields);
}

// Replaces the buttons with the original confirmation and what was decided.
async function resolvePrompt(payload, env, request, outcome) {
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(`${changedText(request.user, request.fields)}\n${outcome}`),
  });
}

function target(found) {
  return JSON.stringify({ kind: found.kind, channel: found.channel, ts: found.ts });
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
          // Requirements started before they had a priority have none.
          initial_option: PRIORITIES[found.item.priority] ? option(found.item.priority) : undefined,
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
          initial_date: pickerDate(found.item.dueDate),
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
  return typeof reply === "string"
    ? { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] }
    : reply;
}
