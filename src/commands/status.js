import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, saveTask, setPinned } from "../tasks.js";

const SELECT_ACTION = "status:select";

// `luma status` in a task thread replies with a menu of statuses; picking one
// updates the task and replaces the menu with a confirmation. A status can
// also be given directly, as `luma status IN_PROGRESS` or `luma status in
// progress`. Moving a task to DONE unpins it from the channel; moving it out
// of DONE pins it again.
export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "luma status",
  sources: ["message"],
  channel: "TASK_CHANNEL_ID",
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

    await applyStatus(env, command.channel, command.threadTs, task, status);
    return `<@${command.user}> set the status to ${STATUSES[status]}.`;
  },
  actions: {
    [SELECT_ACTION]: async (payload, context) => {
      context.waitUntil(selectStatus(payload, context.env));
    },
  },
};

function statusPicker(prompt, current) {
  const option = (status) => ({ text: plainText(stripEmoji(STATUSES[status])), value: status });
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
  const text = task
    ? `<@${payload.user.id}> set the status to ${STATUSES[status]}.`
    : NOT_A_TASK;
  if (task) await applyStatus(env, channel, ts, task, status);

  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}

async function applyStatus(env, channel, ts, task, status) {
  const wasDone = task.status === "DONE";
  task.status = status;
  await saveTask(env, channel, ts, task);
  if (wasDone !== (status === "DONE")) {
    await setPinned(env, channel, ts, status !== "DONE");
  }
}

// Menu options are plain text, so the leading emoji code is dropped.
function stripEmoji(label) {
  return label.replace(/^:[a-z0-9_+-]+:\s*/, "");
}
