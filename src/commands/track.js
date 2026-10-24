import { tasksChannelFor } from "../channels.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { PRIORITIES, formatDueDate, noPeople, setPinned, taskMessage } from "../tasks.js";

const TRACK_VIEW = "track";
const OPEN_ACTION = "track:open";

// `@LUMA track` replies with a Track task button, because only a click carries
// the trigger_id Slack needs to open a modal. Submitting the modal posts the
// task to the tasks channel and replaces the button with an announcement
// linking to the task's thread.
//
// Sent in an external channel (usually in a request thread), the task goes to
// the paired tasks channel and remembers that thread, so later updates can be
// shared there. Sent in a tasks channel, for the team's own work, the task is
// created in that channel with no external thread.
export default {
  name: "track",
  description: "Track a new task (from a request thread, or in the dev channel for your own work)",
  usage: "@LUMA track",
  channel: ["external", "tasks"],
  async run(command) {
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

// `origin` says where to announce the task: { channel, threadTs, promptTs }.
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
        element: {
          type: "datepicker",
          action_id: "value",
          placeholder: plainText("Select a date"),
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
            text: { ...plainText(`${PRIORITIES[priority]} ${priority}`), emoji: true },
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
  // The date picker gives YYYY-MM-DD, or null when no date was chosen.
  const dueDate = formatDueDate(values.due_date.value.selected_date);
  const priority = values.priority.value.selected_option?.value;

  const errors = {};
  if (!title) errors.title = "Enter a task title.";
  if (!PRIORITIES[priority]) errors.priority = "Select a priority.";
  if (Object.keys(errors).length) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  const task = {
    title,
    priority,
    status: "TODO",
    dueDate,
    people: noPeople(),
    createdBy: payload.user.id,
  };
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

async function createTask(env, task, origin) {
  const tasksChannel = tasksChannelFor(env, origin.channel);
  if (origin.channel !== tasksChannel) {
    task.source = { channel: origin.channel, threadTs: origin.threadTs };
    // The task message links back to the thread it was tracked from. The link
    // is a convenience, so the task is still created without it.
    try {
      const { permalink } = await callSlack(env, "chat.getPermalink", {
        channel: origin.channel,
        message_ts: origin.threadTs,
      });
      task.source.link = permalink;
    } catch (error) {
      console.warn("Could not link the source thread", { error: error.message });
    }
  }

  let message;
  try {
    message = await callSlack(env, "chat.postMessage", {
      channel: tasksChannel,
      ...taskMessage(task),
    });
  } catch (error) {
    await callSlack(env, "chat.postEphemeral", {
      channel: origin.channel,
      thread_ts: origin.threadTs,
      user: task.createdBy,
      text: `Sorry, the task "${escapeSlack(task.title)}" could not be created.`,
    }).catch(() => {});
    throw error;
  }
  console.log("Task created", {
    channel: message.channel,
    ts: message.ts,
    priority: task.priority,
    createdBy: task.createdBy,
  });
  await setPinned(env, message.channel, message.ts, true);

  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel: message.channel,
    message_ts: message.ts,
  });
  const text = `<@${task.createdBy}> tracked a task: <${permalink}|${escapeSlack(task.title)}>`;
  await callSlack(env, "chat.update", {
    channel: origin.channel,
    ts: origin.promptTs,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}
