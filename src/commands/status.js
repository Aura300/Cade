import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, saveTask, setPinned } from "../tasks.js";

const SELECT_ACTION = "status:select";
const INFORM_ACTION = "status:inform";
const SKIP_ACTION = "status:skip";
// The external thread only needs to hear when a task leaves the open statuses
// for one of these.
const CLOSED_STATUSES = ["CLIENT_REVIEW", "DONE"];

// `@LUMA status` in a task thread replies with a menu of statuses; picking one
// updates the task and replaces the menu with a confirmation. A status can
// also be given directly, as `@LUMA status IN_PROGRESS` or `@LUMA status in
// progress`. Moving a task to DONE unpins it from the channel; moving it out
// of DONE pins it again.
//
// When a task moves from an open status to CLIENT_REVIEW or DONE, the
// confirmation asks whether Luma should tell the external thread the task was
// tracked from, or whether someone will tell them themselves.
export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "@LUMA status",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    const input = command.text.trim();
    const status = input.toUpperCase().replace(/[\s-]+/g, "_");
    if (!STATUSES[status]) {
      const prompt = input
        ? `"${escapeSlack(input)}" is not a status. Pick one:`
        : "Pick the new status:";
      return statusPicker(prompt, task.status);
    }

    const closed = await applyStatus(env, command.channel, command.threadTs, task, status);
    return confirmation(command.channel, command.threadTs, task, status, command.user, closed);
  },
  actions: {
    [SELECT_ACTION]: async (payload, context) => {
      context.waitUntil(selectStatus(payload, context.env));
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

function statusPicker(prompt, current) {
  const option = (status) => ({
    text: { ...plainText(STATUSES[status]), emoji: true },
    value: status,
  });
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        text: mrkdwn(prompt),
        accessory: {
          type: "static_select",
          action_id: SELECT_ACTION,
          placeholder: plainText("Select a status"),
          options: Object.keys(STATUSES).map(option),
          initial_option: option(current),
        },
      },
    ],
  };
}

// The picker is a reply in the task's thread, so the thread identifies the task.
async function selectStatus(payload, env) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const status = payload.actions[0].selected_option.value;

  const task = await loadTask(env, channel, ts);
  let reply = NOT_A_TASK;
  if (task) {
    const closed = await applyStatus(env, channel, ts, task, status);
    reply = confirmation(channel, ts, task, status, payload.user.id, closed);
  }
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

// Saves the new status and returns whether the task just moved from an open
// status to a closed one.
async function applyStatus(env, channel, ts, task, status) {
  const previous = task.status;
  task.status = status;
  await saveTask(env, channel, ts, task);
  if ((previous === "DONE") !== (status === "DONE")) {
    await setPinned(env, channel, ts, status !== "DONE");
  }
  return !CLOSED_STATUSES.includes(previous) && CLOSED_STATUSES.includes(status);
}

function confirmation(channel, ts, task, status, user, closed) {
  const text = changedText(user, status);
  if (!closed || !task.source) return text;

  // The buttons carry everything needed to post the announcement later.
  const value = JSON.stringify({ channel, ts, status, user });
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

async function inform(payload, env) {
  const request = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, request.channel, request.ts);

  let outcome;
  if (!task) {
    outcome = NOT_A_TASK;
  } else if (task.status !== request.status) {
    // Someone changed the status again before the button was clicked.
    outcome = `Not sent: the status is now ${STATUSES[task.status]}.`;
  } else {
    await announce(env, request.channel, request.ts, task, request.user);
    outcome = `<@${payload.user.id}> informed the external thread.`;
  }
  await resolvePrompt(payload, env, request, outcome);
}

// Replaces the buttons with the original confirmation and what was decided.
async function resolvePrompt(payload, env, request, outcome) {
  const text = `${changedText(request.user, request.status)}\n${outcome}`;
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(text),
  });
}

// Matches the "tracked a task" announcement in the external thread.
async function announce(env, channel, ts, task, user) {
  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel,
    message_ts: ts,
  });
  const text = `<@${user}> marked a task as ${STATUSES[task.status]}: <${permalink}|${escapeSlack(task.title)}>`;
  await callSlack(env, "chat.postMessage", {
    channel: task.source.channel,
    thread_ts: task.source.threadTs,
    ...asMessage(text),
  });
}

function changedText(user, status) {
  return `<@${user}> set the status to ${STATUSES[status]}.`;
}

// chat.update keeps a message's old blocks unless new ones are sent, so text
// replies are wrapped in a section.
function asMessage(reply) {
  return typeof reply === "string"
    ? { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] }
    : reply;
}
