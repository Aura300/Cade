import { CLOSE_ALL, acknowledge, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { INCIDENT_IS_FIXED, NOT_A_TASK, PRIORITIES, formatDueDate, loadTask, pickerDate, saveTask } from "../tasks.js";

const PRIORITY_ACTION = "priority:select";
const DUE_ACTION = "due:select";
const PRIORITY_VIEW = "priority:form";
const DUE_VIEW = "due:form";

// `@Cade priority` and `@Cade due`, in a task's thread, change its priority
// and due date. Incidents are always urgent and due immediately, so theirs
// never change.
//
// With a value Cade just reacts ✅ to the message; without one they reply
// with a menu or date picker, which becomes the confirmation. Like the status
// menu, the picker's thread says what it changes.

// `@Cade priority high`, or `@Cade priority` for a menu.
export const priority = {
  name: "priority",
  description: "Change the task's priority (in its thread)",
  usage: "@Cade priority high",
  section: "thread",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    const problem = cannotChange(found);
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
  description: "Change the task's due date (in its thread)",
  usage: "@Cade due 31/12/2026",
  section: "thread",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const found = await findTask(env, command.channel, command.threadTs);
    const problem = cannotChange(found);
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

// Changes the priority or due date, or both, of the task at `channel`/`ts`
// for `user`, and returns the change log, as { log, notes } (see oneMessage
// in notify.js), or null when they can't be changed (see cannotChange).
// Shared with suggestions.
export async function detailsChange(env, channel, ts, fields, user) {
  const found = await findTask(env, channel, ts);
  if (cannotChange(found)) return null;
  const log = [];
  for (const [name, value] of Object.entries(fields)) {
    if ((found.item[name] ?? "") !== value) log.push(await change(env, found, { [name]: value }, user));
  }
  return { log, notes: [] };
}

// Saves the change and returns the confirmation.
async function change(env, found, fields, user) {
  Object.assign(found.item, fields);
  await saveTask(env, found.channel, found.ts, found.item);
  return changedText(user, fields);
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
  const found = await findTask(env, channel, payload.message.thread_ts);
  const reply = cannotChange(found) ?? (await change(env, found, fields, payload.user.id));
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
// menu.js), from cards posted before the Edit form.
export function priorityForm(origin, task) {
  const option = (name) => ({
    text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true },
    value: name,
  });
  return detailsForm(PRIORITY_VIEW, "Change priority", origin, {
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

export function dueForm(origin, task) {
  return detailsForm(DUE_VIEW, "Change due date", origin, {
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

function detailsForm(callbackId, title, { channel, ts }, block) {
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: JSON.stringify({ channel, ts }),
    title: plainText(title),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [block],
  };
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
      const found = await findTask(env, channel, ts);
      const problem = cannotChange(found);
      if (problem) {
        await callSlack(env, "chat.postEphemeral", { channel, user, text: problem });
        return;
      }
      if (Object.entries(fields).every(([name, value]) => (found.item[name] ?? "") === value)) return;
      const text = await change(env, found, fields, user);
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...asMessage(text) });
    })(),
  );
  return CLOSE_ALL;
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
