import { roleOf } from "../channels.js";
import { INCIDENT_IS_FIXED, NOT_A_REQUIREMENT, findDetails, saveDetails } from "../requirements.js";
import { acknowledge, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, PRIORITIES, formatDueDate, pickerDate } from "../tasks.js";

const PRIORITY_ACTION = "priority:select";
const DUE_ACTION = "due:select";
const PRIORITY_VIEW = "priority:form";
const DUE_VIEW = "due:form";

// `@Cade priority` and `@Cade due` change a priority and due date. The client
// decides these for a requirement, so they are changed in the thread of a
// requirement started with `/cade requirement`, before and after a task is
// tracked from it. A tracked task follows the requirement, and Cade notes the
// change in the task's thread for the team. In that task's thread they cannot
// be changed. Tasks with no requirement, such as the team's own work, have no
// client, so their priority and due date are changed in the task's thread.
// Incidents are always urgent and due immediately, so theirs never change.
//
// With a value Cade just reacts ✅ to the message; without one they reply
// with a menu or date picker, which becomes the confirmation. Like the status
// menu, the picker's thread says what it changes.

// `@Cade priority high`, or `@Cade priority` for a menu.
export const priority = {
  name: "priority",
  description: "Change the priority (in a requirement thread, or a task thread with no requirement)",
  usage: "@Cade priority high",
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
        ? `I don't know "${escapeSlack(input)}" as a priority. Which one did you mean?`
        : "Which priority should it be?";
      return priorityPicker(prompt, found.item.priority);
    }
    await change(env, found, { priority: value }, command.user);
    return acknowledge();
  },
  actions: {
    [PRIORITY_ACTION]: async (payload, context) => {
      context.waitUntil(
        select(payload, context.env, { priority: payload.actions[0].selected_option.value }),
      );
    },
  },
  views: {
    [PRIORITY_VIEW]: (payload, context) =>
      submitDetails(payload, context, { priority: payload.view.state.values.priority.value.selected_option.value }),
  },
};

// `@Cade due 31/12/2026`, `@Cade due none` to clear it, or `@Cade due` for a
// date picker.
export const due = {
  name: "due",
  description: "Change the due date (in a requirement thread, or a task thread with no requirement)",
  usage: "@Cade due 31/12/2026",
  section: "thread",
  channel: ["external", "tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const found = await findDetails(env, command.channel, command.threadTs);
    const problem = cannotChange(env, command.channel, found);
    if (problem) return problem;

    const input = command.text.trim();
    if (/^(none|clear|remove)$/i.test(input)) {
      await change(env, found, { dueDate: "" }, command.user);
      return acknowledge();
    }
    const dueDate = parseDate(input);
    if (!dueDate) {
      const prompt = input
        ? `I couldn't read "${escapeSlack(input)}" as a date. Try DD/MM/YYYY, or pick one here:`
        : "When is it due?";
      return datePicker(prompt, found.item.dueDate);
    }
    await change(env, found, { dueDate }, command.user);
    return acknowledge();
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
  views: {
    [DUE_VIEW]: (payload, context) =>
      submitDetails(payload, context, {
        dueDate: formatDueDate(payload.view.state.values.due_date.value.selected_date),
      }),
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
  return `The client owns this task's priority and due date, so they're changed in ${thread}.`;
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

// The task card menu's Change priority and Change due date forms (see
// menu.js), offered only on tasks with no requirement.
export function openPriorityForm(env, triggerId, { channel, ts, task }) {
  const option = (name) => ({
    text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true },
    value: name,
  });
  return openDetailsForm(env, triggerId, PRIORITY_VIEW, "Change priority", { channel, ts }, {
    type: "input",
    block_id: "priority",
    label: plainText(`Priority of ${task.title}`.slice(0, 2000)),
    element: {
      type: "static_select",
      action_id: "value",
      options: Object.keys(PRIORITIES).map(option),
      initial_option: PRIORITIES[task.priority] ? option(task.priority) : undefined,
    },
  });
}

export function openDueForm(env, triggerId, { channel, ts, task }) {
  return openDetailsForm(env, triggerId, DUE_VIEW, "Change due date", { channel, ts }, {
    type: "input",
    block_id: "due_date",
    // Saving with no date removes it.
    optional: true,
    label: plainText(`Due date of ${task.title}`.slice(0, 2000)),
    element: {
      type: "datepicker",
      action_id: "value",
      placeholder: plainText("Select a date"),
      initial_date: pickerDate(task.dueDate),
    },
  });
}

function openDetailsForm(env, triggerId, callbackId, title, origin, block) {
  return callSlack(env, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: callbackId,
      private_metadata: JSON.stringify(origin),
      title: plainText(title),
      submit: plainText("Save"),
      close: plainText("Cancel"),
      blocks: [block],
    },
  });
}

// Saving a form changes the task as `@Cade priority` or `@Cade due` would,
// and tells its thread who did. Saving it unchanged posts nothing, and
// anything stopping the change is said only to whoever saved it.
function submitDetails(payload, context, fields) {
  const { channel, ts } = JSON.parse(payload.view.private_metadata);
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const { env } = context;
      const found = await findDetails(env, channel, ts);
      const problem = cannotChange(env, channel, found);
      if (problem) {
        await callSlack(env, "chat.postEphemeral", { channel, user, text: problem });
        return;
      }
      if (Object.entries(fields).every(([name, value]) => (found.item[name] ?? "") === value)) return;
      const text = await change(env, found, fields, user);
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...asMessage(text) });
    })(),
  );
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
