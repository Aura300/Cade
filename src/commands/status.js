import { clientStatus, loadRequirement, reflectOnRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, saveTask, setPinned } from "../tasks.js";

const SELECT_ACTION = "status:select";
const APPROVE_ACTION = "status:approve";
const REJECT_ACTION = "status:reject";
// The external thread only needs to hear when a task reaches one of these.
const CLOSED_STATUSES = ["CLIENT_REVIEW", "DONE"];

// `@LUMA status` in a task thread replies with a menu of statuses; picking one
// updates the task and replaces the menu with a confirmation. A status can
// also be given directly, as `@LUMA status IN_PROGRESS` or `@LUMA status in
// progress`. Moving a task to DONE unpins it from the channel; moving it out
// of DONE pins it again. The same goes for the requirement it was tracked
// from, in the external channel.
//
// When a task reaches CLIENT_REVIEW or DONE, Luma tells the external thread
// it was tracked from, and the requirement it was tracked from always shows
// the current status.
//
// Only the dev channel sets statuses, and it can set Done directly. Client
// review is an optional step for work the client should check first, and
// the client decides whether that work is accepted. When a requirement's
// task moves to Client review, Luma's post in the requirement thread has
// Approve and Not approve buttons. Approve moves the task to Done; Not
// approve moves it back to In progress. Either way the task's thread is told,
// and nothing more is posted in the requirement thread, where the client just
// decided. Slack cannot tell the team
// from the client, so anyone in the external channel can click them.
export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "@LUMA status",
  section: "thread",
  channel: ["tasks", "incidents"],
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

    const reached = await applyStatus(env, command.channel, command.threadTs, task, status);
    return afterChange(env, command.channel, command.threadTs, task, status, command.user, reached);
  },
  actions: {
    [SELECT_ACTION]: async (payload, context) => {
      context.waitUntil(selectStatus(payload, context.env));
    },
    [APPROVE_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, true));
    },
    [REJECT_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, false));
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
    const reached = await applyStatus(env, channel, ts, task, status);
    reply = await afterChange(env, channel, ts, task, status, payload.user.id, reached);
  }
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

// Saves the new status and returns whether the task just reached a status
// the external thread hears about.
async function applyStatus(env, channel, ts, task, status) {
  const previous = task.status;
  task.status = status;
  if (status !== "DONE") task.completedAt = "";
  else if (previous !== "DONE") task.completedAt = new Date().toISOString();
  await saveTask(env, channel, ts, task);
  await reflectOnRequirement(env, ts, task, { status: clientStatus(status) });
  if ((previous === "DONE") !== (status === "DONE")) {
    await setPinned(env, channel, ts, status !== "DONE");
    // The requirement it was tracked from is pinned until it is Done too.
    if (task.source) {
      await setPinned(env, task.source.channel, task.source.threadTs, status !== "DONE");
    }
  }
  return status !== previous && CLOSED_STATUSES.includes(status);
}

// Tells the external thread, if the task has one and just reached Client
// review or Done, and returns the confirmation for the task's thread.
async function afterChange(env, channel, ts, task, status, user, reached) {
  const text = changedText(user, status);
  if (!reached || !task.source) return text;
  await announce(env, channel, ts, task, user);
  const told = status === "CLIENT_REVIEW"
    ? "Luma asked the client to review it in the requirement thread."
    : "Luma told the requirement thread.";
  return `${text}\n${told}`;
}

// Matches the "tracked a task" announcement in the external thread.
async function announce(env, channel, ts, task, user) {
  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel,
    message_ts: ts,
  });
  const text = `<@${user}> marked a task as ${STATUSES[task.status]}: <${permalink}|${escapeSlack(task.title)}>`;
  const asksForReview = task.status === "CLIENT_REVIEW";
  await callSlack(env, "chat.postMessage", {
    channel: task.source.channel,
    thread_ts: task.source.threadTs,
    ...(asksForReview ? await reviewPrompt(env, text, channel, ts, task) : asMessage(text)),
  });
}

// The announcement with the client's Approve and Not approve buttons,
// mentioning whoever started the requirement so they are notified. The
// buttons carry the announcement, to keep it when they are replaced.
async function reviewPrompt(env, text, channel, ts, task) {
  const requirement = await loadRequirement(env, task.source.channel, task.source.threadTs);
  const who = requirement ? `<@${requirement.createdBy}>, please` : "Please";
  const request = `${who} review it and approve it, or say what needs to change.`;
  const value = JSON.stringify({ channel, ts, text });
  return {
    // The mention is in the notification text too.
    text: `${text}\n${request}`,
    blocks: [
      { type: "section", text: mrkdwn(`${text}\n${request}`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: APPROVE_ACTION,
            text: plainText("Approve"),
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: REJECT_ACTION,
            text: plainText("Not approve"),
            value,
          },
        ],
      },
    ],
  };
}

// Applies the client's decision on a task in Client review, then replaces
// the buttons with the decision and tells the task's thread.
async function review(payload, env, approved) {
  const request = JSON.parse(payload.actions[0].value);
  const user = payload.user.id;
  const task = await loadTask(env, request.channel, request.ts);

  let outcome;
  if (!task) {
    outcome = "This task no longer exists.";
  } else if (task.status !== "CLIENT_REVIEW") {
    // The team moved the task on before anyone clicked.
    outcome = `Not applied: the task is now ${STATUSES[task.status]}.`;
  } else {
    const status = approved ? "DONE" : "IN_PROGRESS";
    await applyStatus(env, request.channel, request.ts, task, status);
    const { permalink } = await callSlack(env, "chat.getPermalink", {
      channel: payload.channel.id,
      message_ts: payload.message.ts,
    });
    const where = `in <${permalink}|the requirement thread>`;
    const text = approved
      ? `<@${user}> approved this ${where}, so it is now ${STATUSES.DONE}.`
      : `<@${user}> did not approve this ${where}, so it is back to ${STATUSES.IN_PROGRESS}. See the thread for what needs to change.`;
    await callSlack(env, "chat.postMessage", {
      channel: request.channel,
      thread_ts: request.ts,
      ...asMessage(text),
    });
    outcome = approved
      ? `<@${user}> approved it.`
      : `<@${user}> did not approve it, so the team will pick it up again.`;
  }
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(`${request.text}\n${outcome}`),
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
