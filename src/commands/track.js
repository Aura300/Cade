import { pairFor, roleOf, tasksChannelFor } from "../channels.js";
import { clientStatus, loadRequirement, updateRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import {
  PRIORITIES,
  noPeople,
  readTaskForm,
  setPinned,
  syncTask,
  taskFormBlocks,
  taskMessage,
} from "../tasks.js";

const TRACK_VIEW = "track";
const OPEN_ACTION = "track:open";

function notInRequirement(env, channel) {
  return `Use \`@LUMA track\` in the thread of a requirement started with \`/luma requirement\`. For the team's own work, use \`/luma track\` in <#${tasksChannelFor(env, channel)}>.`;
}

function alreadyTracked(requirement) {
  const { link, title } = requirement.task;
  return `This requirement is already tracked as <${link}|${escapeSlack(title)}>.`;
}

// Each channel has one way to track a task:
//
// `@LUMA track` in the thread of a requirement started with `/luma
// requirement` tracks the requirement. It replies with a Track task button,
// because only a click carries the trigger_id Slack needs to open a modal.
// The form starts with the requirement's title and asks only for the task's
// title: the client sets the priority and due date in the requirement
// thread, and the task takes them from the requirement. Submitting posts the
// task to the paired tasks channel, replaces the button with an announcement
// linking to it, and links the requirement's message to it. A requirement
// has one task, so a tracked requirement cannot be tracked again.
//
// Incidents are tracked when they are reported (see requirement.js). If an
// incident's task is deleted, `@LUMA track` in its thread tracks it again,
// in the pair's incidents channel.
//
// `/luma track` in a tasks channel, for the team's own work, opens the full
// form straight away, since a slash command carries a trigger_id. The task is
// posted in that channel with no external thread.
export default {
  name: "track",
  description: "Track a requirement as a task (in its thread)",
  usage: "@LUMA track",
  slashUsage: "/luma track",
  channel: "external",
  slashChannel: "tasks",
  async run(command, { env }) {
    const inThread = command.threadTs && command.threadTs !== command.ts;
    const requirement =
      inThread && (await loadRequirement(env, command.channel, command.threadTs));
    if (!requirement) return notInRequirement(env, command.channel);
    if (requirement.task) return alreadyTracked(requirement);

    const { title, priority, dueDate, incident } = requirement;
    const origin = {
      channel: command.channel,
      threadTs: command.threadTs,
      requirement: true,
      incident,
      title,
      priority,
      dueDate,
    };
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
// From a requirement thread it also has `requirement: true` and the
// requirement's title, priority and due date, to show in the form. From `/luma track` it has only the channel.
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
    blocks: fromRequirement(origin)
      ? [
          ...taskFormBlocks("Task title", origin, { details: false }),
          {
            type: "context",
            elements: [
              mrkdwn(
                `*Priority:* ${PRIORITIES[origin.priority]} ${origin.priority}  ·  *Due:* ${origin.dueDate || "_None_"}\n${
                  origin.incident
                    ? "Incidents are always urgent and fixed as soon as possible."
                    : "From the requirement. The client changes them in the requirement thread."
                }`,
              ),
            ],
          },
        ]
      : taskFormBlocks("Task title", origin),
  };
}

// Whether the task takes its priority and due date from a requirement.
// Requirements started before they had a priority still ask for one.
function fromRequirement(origin) {
  return Boolean(origin.requirement && PRIORITIES[origin.priority]);
}

async function submit(payload, context) {
  const { title, dueDate, priority, errors } = readTaskForm(
    payload.view.state.values,
    "Enter a task title.",
  );
  if (errors) return { response_action: "errors", errors };

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

// Posts the task and announces it. `origin` is where it was tracked from, as
// for the form; `/luma incident` uses this too, with `incident: true`, so the
// task goes to the pair's incidents channel.
export async function createTask(env, task, origin) {
  if (origin.requirement) {
    // The requirement's current state, in case the client changed its
    // priority, or someone else tracked it, while the form was open.
    const requirement = await loadRequirement(env, origin.channel, origin.threadTs);
    if (requirement?.task) {
      await callSlack(env, "chat.postEphemeral", {
        channel: origin.channel,
        thread_ts: origin.threadTs,
        user: task.createdBy,
        text: alreadyTracked(requirement),
      });
      return;
    }
    if (fromRequirement(origin)) {
      task.priority = requirement?.priority || origin.priority;
      task.dueDate = requirement ? requirement.dueDate : origin.dueDate;
    }
  }
  const tasksChannel = origin.incident
    ? pairFor(env, origin.channel).incidents
    : tasksChannelFor(env, origin.channel);
  if (roleOf(env, origin.channel) === "external") {
    task.source = {
      channel: origin.channel,
      threadTs: origin.threadTs,
      requirement: Boolean(origin.requirement),
      incident: Boolean(origin.incident),
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
    status: clientStatus(task.status),
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
