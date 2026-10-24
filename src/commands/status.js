import { clientStatus, loadRequirement, reflectOnRequirement } from "../requirements.js";
import { acknowledge, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, prLink, saveTask, setPinned } from "../tasks.js";

const SELECT_ACTION = "status:select";
const APPROVE_ACTION = "status:approve";
const REJECT_ACTION = "status:reject";
// The external thread only needs to hear when a task reaches one of these.
const CLOSED_STATUSES = ["CLIENT_REVIEW", "DONE"];

// `@Cade status` in a task thread replies with a menu of statuses; picking one
// updates the task and replaces the menu with a confirmation. A status can
// also be given directly, as `@Cade status IN_PROGRESS` or `@Cade status in
// progress`; then Cade just reacts ✅ to the message. Moving a task to DONE unpins it from the channel; moving it out
// of DONE pins it again. The same goes for the requirement it was tracked
// from, in the external channel.
//
// When a task reaches CLIENT_REVIEW or DONE, Cade tells the external thread
// it was tracked from, and the requirement it was tracked from always shows
// the current status.
//
// Only the dev channel sets statuses, and it can set Done directly. Client
// review is an optional step for work the client should check first, and
// the client decides whether that work is accepted. When a requirement's
// task moves to Client review, Cade's post in the requirement thread has
// Approve and Not approve buttons. Approve moves the task to Done; Not
// approve moves it back to In progress. Either way the task's thread is told,
// and nothing more is posted in the requirement thread, where the client just
// decided. Slack cannot tell the team
// from the client, so anyone in the external channel can click them.
export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "@Cade status",
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
    // A status typed in the command needs only a ✅, since the task card shows
    // it, plus a note when the requirement thread was told.
    const { told } = await afterChange(
      env,
      command.channel,
      command.threadTs,
      task,
      status,
      command.user,
      reached,
    );
    return acknowledge(told);
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

// A status menu's option.
export function statusOption(status) {
  return { text: { ...plainText(STATUSES[status]), emoji: true }, value: status };
}

function statusPicker(prompt, current) {
  const option = statusOption;
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
  const reply = (await setStatus(env, channel, ts, status, payload.user.id)) ?? NOT_A_TASK;
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

// Sets the task's status as the picker does, for `user`, and returns what the
// picker then says: who set it, and whether the requirement thread was told.
// Null if it isn't a task. Shared with `/cade standup`.
export async function setStatus(env, channel, ts, status, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  const reached = await applyStatus(env, channel, ts, task, status);
  const { text, told } = await afterChange(env, channel, ts, task, status, user, reached);
  return told ? `${text}\n${told}` : text;
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

// Tells the requirement thread, if the task has one and just reached Client
// review or Done. Returns the confirmation for the task's thread, `text`, and
// `told`, the line saying the requirement thread was told, when it was.
async function afterChange(env, channel, ts, task, status, user, reached) {
  const text = changedText(user, status);
  if (!reached || !task.source) return { text, told: null };
  await announce(env, channel, ts, task, user);
  // The client isn't mentioned here, so they aren't notified twice.
  const thread = task.source.link ? `<${task.source.link}|the requirement thread>` : "the requirement thread";
  const told = status === "CLIENT_REVIEW"
    ? `Cade asked the client to review it in ${thread}.`
    : `Cade told ${thread} it's ${STATUSES.DONE}.`;
  return { text, told };
}

// Tells the requirement thread the task reached Client review or Done. The
// thread is the requirement, and the client has no use for the team's task,
// so neither message links to it. Client review says the work is ready for
// the client, with its PRs and their Approve and Not approve buttons.
async function announce(env, channel, ts, task, user) {
  const done = task.status === "DONE";
  const text = done ? `<@${user}> marked this as ${STATUSES.DONE}.` : `<@${user}> marked this as ready to review.`;
  await callSlack(env, "chat.postMessage", {
    channel: task.source.channel,
    thread_ts: task.source.threadTs,
    ...(done ? asMessage(text) : await reviewPrompt(env, text, channel, ts, task)),
  });
}

// The announcement with the task's linked pull requests, for the client to
// look at, and the client's Approve and Not approve buttons, mentioning
// whoever started the requirement so they are notified. The buttons carry
// the announcement, PRs included, to keep it when they are replaced.
async function reviewPrompt(env, text, channel, ts, task) {
  const requirement = await loadRequirement(env, task.source.channel, task.source.threadTs);
  const who = requirement ? `<@${requirement.createdBy}>, please` : "Please";
  const request = `${who} review it and approve it, or say what needs to change.`;
  const announced = task.prs.length ? `${text}\n*PRs:* ${task.prs.map(prLink).join(", ")}` : text;
  const value = JSON.stringify({ channel, ts, text: announced });
  return {
    // The mention is in the notification text too.
    text: `${announced}\n${request}`,
    blocks: [
      { type: "section", text: mrkdwn(`${announced}\n${request}`) },
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
