import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { PRIORITIES, parseDueDate, setPinned, taskMessage } from "../tasks.js";

const TRACK_VIEW = "track";
const OPEN_ACTION = "track:open";

// `/luma track` opens a modal; submitting it posts the task to the dev channel
// and announces it in the external channel with a link to the task's thread.
//
// Only slash commands and button clicks carry the trigger_id needed to open a
// modal, so `luma track` sent as a message (for example in a thread) replies
// with a button instead. That reply is replaced by the announcement once the
// task has been created, which keeps the announcement in the same thread.
export default {
  name: "track",
  description: "Track a new task in the dev channel",
  usage: "/luma track",
  sources: ["slash", "message"],
  channel: "EXTERNAL_CHANNEL_ID",
  async run(command, { env }) {
    if (command.source === "slash") {
      await openModal(env, command.triggerId, { channel: command.channel });
      return undefined;
    }
    const origin = { channel: command.channel, threadTs: command.threadTs ?? command.ts };
    return {
      text: "Track a new task",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: OPEN_ACTION,
              text: plainText("Track task"),
              style: "primary",
              value: JSON.stringify(origin),
            },
          ],
        },
      ],
    };
  },
  actions: {
    [OPEN_ACTION]: async (payload, { env }) => {
      const origin = JSON.parse(payload.actions[0].value);
      // The button's own message is replaced by the announcement later.
      await openModal(env, payload.trigger_id, { ...origin, promptTs: payload.message.ts });
    },
  },
  views: { [TRACK_VIEW]: submit },
};

// `origin` says where to announce the task: { channel, threadTs?, promptTs? }.
async function openModal(env, triggerId, origin) {
  await callSlack(env, "views.open", {
    trigger_id: triggerId,
    view: trackView(origin),
  });
}

function trackView(origin) {
  return {
    type: "modal",
    callback_id: TRACK_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Track task"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: plainText("Task title"),
        element: { type: "plain_text_input", action_id: "value", max_length: 150 },
      },
      {
        type: "input",
        block_id: "due_date",
        optional: true,
        label: plainText("Due date"),
        hint: plainText("MM/DD, for example 10/31"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: plainText("MM/DD"),
        },
      },
      {
        type: "input",
        block_id: "priority",
        label: plainText("Priority"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("Select a priority"),
          options: Object.keys(PRIORITIES).map((priority) => ({
            text: plainText(priority),
            value: priority,
          })),
        },
      },
    ],
  };
}

async function submit(payload, context) {
  const values = payload.view.state.values;
  const title = values.title.value.value?.trim() ?? "";
  const dueInput = values.due_date.value.value?.trim() ?? "";
  const priority = values.priority.value.selected_option?.value;
  const dueDate = dueInput ? parseDueDate(dueInput) : "";

  const errors = {};
  if (!title) errors.title = "Enter a task title.";
  if (dueDate === null) errors.due_date = "Use MM/DD, for example 10/31.";
  if (!PRIORITIES[priority]) errors.priority = "Select a priority.";
  if (Object.keys(errors).length) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  const task = {
    title,
    priority,
    status: "TODO",
    dueDate,
    assignees: [],
    createdBy: payload.user.id,
  };
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

async function createTask(env, task, origin) {
  let message;
  try {
    message = await callSlack(env, "chat.postMessage", {
      channel: env.TASK_CHANNEL_ID,
      ...taskMessage(task),
    });
  } catch (error) {
    if (origin.channel) {
      await callSlack(env, "chat.postEphemeral", {
        channel: origin.channel,
        user: task.createdBy,
        text: `Sorry, the task "${escapeSlack(task.title)}" could not be created.`,
      }).catch(() => {});
    }
    throw error;
  }
  console.log("Task created", {
    channel: message.channel,
    ts: message.ts,
    priority: task.priority,
    createdBy: task.createdBy,
  });
  await setPinned(env, message.channel, message.ts, true);
  if (!origin.channel) return;

  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel: message.channel,
    message_ts: message.ts,
  });
  const text = `<@${task.createdBy}> tracked a task: <${permalink}|${escapeSlack(task.title)}>`;
  if (origin.promptTs) {
    await callSlack(env, "chat.update", {
      channel: origin.channel,
      ts: origin.promptTs,
      text,
      blocks: [{ type: "section", text: mrkdwn(text) }],
    });
  } else {
    await callSlack(env, "chat.postMessage", {
      channel: origin.channel,
      thread_ts: origin.threadTs,
      text,
    });
  }
}
