import { pairFor, tasksChannelFor } from "../channels.js";
import { loadRequirement, updateRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import {
  PRIORITIES,
  formatDueDate,
  noPeople,
  setPinned,
  syncTask,
  taskMessage,
} from "../tasks.js";

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
//
// In a requirement thread started with `/luma requirement`, the form starts
// with the requirement's title, and the requirement's root message is updated
// to link to the task.
//
// `/luma track` opens the form straight away, since a slash command carries a
// trigger_id, so no message is needed to start from. In a tasks channel the
// task is simply posted there; in an external channel Luma posts a message to
// act as the task's external thread.
export default {
  name: "track",
  description: "Track a new task (from a request thread, or in the dev channel for your own work)",
  usage: "@LUMA track",
  slashUsage: "/luma track",
  channel: ["external", "tasks"],
  async run(command, { env }) {
    const origin = { channel: command.channel, threadTs: command.threadTs ?? command.ts };
    const inThread = command.threadTs && command.threadTs !== command.ts;
    if (inThread && pairFor(env, command.channel).external === command.channel) {
      const requirement = await loadRequirement(env, command.channel, command.threadTs);
      if (requirement) Object.assign(origin, { requirement: true, title: requirement.title });
    }
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
  async slash(command, { env }) {
    await openModal(env, command.triggerId, { channel: command.channel });
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
// From a requirement thread it also has `requirement: true` and the `title`
// to start the form with. From `/luma track` it has only the channel.
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
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 150,
          initial_value: origin.title?.slice(0, 150),
        },
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
  if (origin.channel !== tasksChannel && !origin.threadTs) {
    // `/luma track` in an external channel: this message becomes the external
    // thread, and is replaced by the announcement like the button would be.
    const placeholder = `<@${task.createdBy}> is tracking a task: ${escapeSlack(task.title)}`;
    const { ts } = await callSlack(env, "chat.postMessage", {
      channel: origin.channel,
      text: placeholder,
      blocks: [{ type: "section", text: mrkdwn(placeholder) }],
    });
    origin = { ...origin, threadTs: ts, promptTs: ts };
  }
  if (origin.channel !== tasksChannel) {
    task.source = {
      channel: origin.channel,
      threadTs: origin.threadTs,
      requirement: Boolean(origin.requirement),
    };
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
  await syncTask(env, message.channel, message.ts, task);

  const { permalink } = await callSlack(env, "chat.getPermalink", {
    channel: message.channel,
    message_ts: message.ts,
  });
  await updateRequirement(env, task.source, (requirement) => ({
    ...requirement,
    status: "IN_PROGRESS",
    priority: task.priority,
    dueDate: task.dueDate,
    task: {
      channel: message.channel,
      ts: message.ts,
      title: task.title,
      link: permalink,
      trackedBy: task.createdBy,
    },
  }));

  // `/luma track` in a tasks channel has no prompt; the task message is enough.
  if (!origin.promptTs) return;
  const text = `<@${task.createdBy}> tracked a task: <${permalink}|${escapeSlack(task.title)}>`;
  await callSlack(env, "chat.update", {
    channel: origin.channel,
    ts: origin.promptTs,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}
