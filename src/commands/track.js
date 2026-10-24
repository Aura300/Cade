import { pairFor, roleOf, tasksChannelFor } from "../channels.js";
import { clientStatus, loadRequirement, updateRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText, respondLater } from "../slack.js";
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
// "Track and assign", offered when a requirement thread asks someone to start
// working on it before it is tracked (see suggestAssignment in assign.js).
export const TRACK_ASSIGN_ACTION = "track:assign";

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
  section: "start",
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
    [TRACK_ASSIGN_ACTION]: async (payload, { env }) => {
      // The form opens straight away; the private question it came from goes.
      await openModal(env, payload.trigger_id, JSON.parse(payload.actions[0].value));
      await respondLater(payload.response_url, { delete_original: true });
    },
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
// requirement's title, priority and due date, to show in the form, and from
// "Track and assign" the `developers` to start the task with. From `/luma track` it has only the channel.
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
    blocks: origin.requirement
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
    // priority, or someone else tracked it, while the form was open. If it
    // can't be read, the values the form was opened with are used.
    const requirement = await loadRequirement(env, origin.channel, origin.threadTs).catch((error) => {
      console.warn("Could not read the requirement", { ts: origin.threadTs, error: error.message });
      return null;
    });
    if (requirement?.task) {
      await callSlack(env, "chat.postEphemeral", {
        channel: origin.channel,
        thread_ts: origin.threadTs,
        user: task.createdBy,
        text: alreadyTracked(requirement),
      });
      return;
    }
    task.priority = requirement?.priority || origin.priority;
    task.dueDate = requirement ? requirement.dueDate : origin.dueDate;
  }
  // Tracked because someone was asked to start working on it: they are its
  // developers, and the work is under way.
  if (origin.developers?.length) {
    task.people.developer = origin.developers;
    task.status = "IN_PROGRESS";
  }
  const tasksChannel = origin.incident
    ? pairFor(env, origin.channel).incidents
    : tasksChannelFor(env, origin.channel);
  if (roleOf(env, origin.channel) === "external") {
    task.source = {
      channel: origin.channel,
      threadTs: origin.threadTs,
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

  // The requirement thread hears it's tracked, with a link to the task: the
  // Track task button becomes that message, and "Track and assign", which
  // has no button message, posts it. Incidents are tracked as they are
  // reported, and `/luma track` in a tasks channel has no thread to tell.
  if (task.source && !origin.reported) {
    const text = `<@${task.createdBy}> tracked this as a task: <${permalink}|${escapeSlack(task.title)}>`;
    const body = { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
    if (origin.promptTs) {
      await callSlack(env, "chat.update", { channel: origin.channel, ts: origin.promptTs, ...body });
    } else {
      await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.threadTs, ...body });
    }
  }
}
