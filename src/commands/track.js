import { pairFor, roleOf, tasksChannelFor } from "../channels.js";
import { POST_ATTEMPTS, countPostAttempt, hasUnpostedTask, insertTask, markTaskPosted } from "../db.js";
import { clientStatus, loadRequirement, updateRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { fromTheCall, syncApplied } from "./debrief.js";
import { moveMessage, offerStart } from "./move.js";
import {
  PRIORITIES,
  REQUESTS,
  STARTED_NOTE,
  noPeople,
  readTaskForm,
  refreshSummary,
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
  return `I can only track a requirement from its own thread: send \`@Cade track\` in the thread of one started with \`/cade requirement\`. For the team's own work, use \`/cade track\` in <#${tasksChannelFor(env, channel)}>.`;
}

function alreadyTracked(requirement) {
  const { link, title } = requirement.task;
  return `Good news: this requirement is already tracked as <${link}|${escapeSlack(title)}>.`;
}

const ALREADY_WAITING =
  "This requirement is already tracked. Its task will show up in the tasks channel in a few minutes.";

// Each channel has one way to track a task:
//
// `@Cade track` in the thread of a requirement started with `/cade
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
// incident's task is deleted, `@Cade track` in its thread tracks it again,
// in the pair's incidents channel.
//
// `/cade track` in a tasks channel, for the team's own work, opens the full
// form straight away, since a slash command carries a trigger_id. The task is
// posted in that channel with no external thread.
//
// `@Cade track` in the thread of a message in a tasks channel offers,
// privately, to track that message as a task: the full form, named from its
// first line, and once the task is posted the message is moved into its
// thread (see move.js).
export default {
  name: "track",
  description: "Track a requirement, or a message in the dev channel, as a task (in its thread)",
  usage: "@Cade track",
  slashUsage: "/cade track",
  section: "start",
  channel: ["external", "tasks"],
  slashChannel: "tasks",
  async run(command, { env }) {
    const inThread = command.threadTs && command.threadTs !== command.ts;
    if (roleOf(env, command.channel) === "tasks") {
      return inThread
        ? offerStart(env, command, "task")
        : "To track a message as a task, reply `@Cade track` in its thread, or use `/cade track` for something new.";
    }
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
// "Track and assign" the `developers` to start the task with; with `started:
// true` the task starts In progress, and `chooseDevelopers: true` makes the
// form ask who the developers are. Cade no longer offers "Track and assign"
// (suggestions use pickers now, see suggest.js), but buttons posted before
// still work. From `/cade track` it has only the channel,
// and for a message in a tasks channel (see move.js) the message's `moveTs`
// and its first line as the `title`, to start with.
async function openModal(env, triggerId, origin) {
  await callSlack(env, "views.open", {
    trigger_id: triggerId,
    view: trackView(origin),
  });
}

// From `/cade debrief` for a group with no client channel, `origin` has
// `sync`, the suggestion it applies (see debrief.js), and the form has an
// Initial message, starting as `initial`, posted in the task's thread.
export function trackView(origin, { initial } = {}) {
  return {
    type: "modal",
    callback_id: TRACK_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Track task"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [...trackBlocks(origin), ...(origin.sync ? [initialMessageBlock(initial, "task")] : [])],
  };
}

// The Initial message of a form opened from `/cade debrief`, posted in the
// thread of what it makes: a task or a requirement.
export function initialMessageBlock(initial, noun) {
  return {
    type: "input",
    block_id: "initial_message",
    optional: true,
    label: plainText("Initial message"),
    hint: plainText(`Posted in the ${noun}'s thread once it's made.`),
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      max_length: 3000,
      initial_value: initial?.slice(0, 3000) || undefined,
    },
  };
}

function trackBlocks(origin) {
  return origin.requirement
      ? [
          ...taskFormBlocks("Task title", origin, { details: false }),
          ...(origin.chooseDevelopers ? [developersBlock(origin.developers)] : []),
          {
            type: "context",
            elements: [
              mrkdwn(
                `*Priority:* ${PRIORITIES[origin.priority]} ${origin.priority}  ·  *Due:* ${origin.dueDate || "_None_"}\n${
                  origin.incident
                    ? "Incidents are always urgent, so we fix them as soon as we can."
                    : "These come from the requirement. The client changes them in the requirement thread."
                }`,
              ),
            ],
          },
        ]
      : taskFormBlocks("Task title", origin);
}

// Who's developing the task, for a task tracked from someone saying the work
// has started.
function developersBlock(developers = []) {
  return {
    type: "input",
    block_id: "developers",
    label: plainText("Developers"),
    element: {
      type: "multi_users_select",
      action_id: "value",
      placeholder: plainText("Choose developers"),
      ...(developers.length && { initial_users: developers }),
    },
  };
}

async function submit(payload, context) {
  const { values } = payload.view.state;
  const { title, dueDate, priority, errors } = readTaskForm(values, "Please give the task a title.");
  if (errors) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  if (values.developers) origin.developers = values.developers.value.selected_users ?? [];
  const task = {
    title,
    priority,
    status: "TODO",
    dueDate,
    people: noPeople(),
    createdBy: payload.user.id,
  };
  const initial = values.initial_message?.value?.value?.trim();
  context.waitUntil(
    (async () => {
      const ts = await createTask(context.env, task, origin);
      if (!origin.sync) return;
      if (ts && initial) {
        await callSlack(context.env, "chat.postMessage", { channel: origin.channel, thread_ts: ts, ...fromTheCall(initial, payload.user.id) });
      }
      await syncApplied(context.env, origin.sync, payload.user.id);
    })(),
  );
  return { response_action: "clear" };
}

// Stores the task, then posts it and announces it, and returns its root
// message's ts, if it was posted. `origin` is where it was tracked from, as
// for the form; `/cade incident` uses this too, with `incident: true`, so
// the task goes to the pair's incidents channel.
export async function createTask(env, task, origin) {
  if (origin.requirement) {
    // The requirement's current state, in case the client changed its
    // priority, or someone else tracked it, while the form was open. If it
    // can't be read, the values the form was opened with are used.
    const requirement = await loadRequirement(env, origin.channel, origin.threadTs).catch((error) => {
      console.warn("Could not read the requirement", { ts: origin.threadTs, error: error.message });
      return null;
    });
    // A task tracked from the thread may still be waiting to be posted.
    const waiting = !requirement?.task &&
      (await hasUnpostedTask(env, { channel: origin.channel, threadTs: origin.threadTs }));
    if (requirement?.task || waiting) {
      await callSlack(env, "chat.postEphemeral", {
        channel: origin.channel,
        thread_ts: origin.threadTs,
        user: task.createdBy,
        text: waiting ? ALREADY_WAITING : alreadyTracked(requirement),
      });
      return;
    }
    task.priority = requirement?.priority || origin.priority;
    task.dueDate = requirement ? requirement.dueDate : origin.dueDate;
  }
  // Tracked because someone was asked to start working on it: they are its
  // developers. It stays To do unless it was tracked because someone said
  // they'd started already.
  if (origin.developers?.length) task.people.developer = origin.developers;
  if (origin.started) task.status = "IN_PROGRESS";
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

  // Stored before it is posted, so that if Slack doesn't take it, it is
  // posted later (see retry.js). What follows the post needs only these.
  const after = {
    channel: origin.channel,
    threadTs: origin.threadTs,
    promptTs: origin.promptTs,
    developers: origin.developers,
    started: origin.started,
    reported: origin.reported,
    moveTs: origin.moveTs,
  };
  const id = await insertTask(env, tasksChannel, task, after);
  return publishTask(env, { id, channel: tasksChannel, task, origin: after, attempts: 0 });
}

// Posts a stored task that has no root message yet, then pins it, tells the
// requirement thread and records it in the Sheet, and returns its ts. If Slack refuses the post,
// the task waits for the next retry, and the person who tracked it is told,
// the first time and when Cade gives up.
export async function publishTask(env, { id, channel, task, origin, attempts }) {
  let message;
  try {
    message = await callSlack(env, "chat.postMessage", { channel, ...taskMessage(task) });
  } catch (error) {
    const tried = await countPostAttempt(env, "tasks", id);
    console.warn("Could not post the task", { id, attempts: tried, error: error.message });
    if (attempts === 0 || tried >= POST_ATTEMPTS) {
      const text = tried >= POST_ATTEMPTS
        ? `Sorry, I couldn't create the task "${escapeSlack(task.title)}", even after a few tries.`
        : `Sorry, I couldn't post the task "${escapeSlack(task.title)}" just now. I'll try again in a few minutes.`;
      await callSlack(env, "chat.postEphemeral", {
        channel: origin.channel,
        thread_ts: origin.threadTs,
        user: task.createdBy,
        text,
      }).catch(() => {});
    }
    return;
  }
  // The task's link is stored with it, for the Sheet and the requirement.
  // It is a convenience, so the task is stored without it if it can't be
  // looked up.
  try {
    ({ permalink: task.link } = await callSlack(env, "chat.getPermalink", {
      channel: message.channel,
      message_ts: message.ts,
    }));
  } catch (error) {
    console.warn("Could not link the task", { ts: message.ts, error: error.message });
  }
  await markTaskPosted(env, id, message.ts, task.link);
  console.log("Task created", {
    channel: message.channel,
    ts: message.ts,
    priority: task.priority,
    createdBy: task.createdBy,
  });
  await setPinned(env, message.channel, message.ts, true);
  // Tracked with "Track and assign": the developers may not be in the
  // requirement thread, so the task's thread asks them, as `@Cade assign`
  // would. Tracked as started, the work is under way, so the developers
  // other than whoever tracked it are only told.
  const others = (origin.developers ?? []).filter((id) => !origin.started || id !== task.createdBy);
  if (others.length) {
    await callSlack(env, "chat.postMessage", {
      channel: message.channel,
      thread_ts: message.ts,
      text: `${mentions(others)} ${origin.started ? STARTED_NOTE : REQUESTS.developer}`,
    });
  }
  await syncTask(env, message.channel, message.ts, task);
  await refreshSummary(env, message.channel);
  // Tracked from a message in the tasks channel: the message moves into the
  // task's thread.
  if (origin.moveTs) {
    const problem = await moveMessage(env, {
      channel: message.channel,
      ts: origin.moveTs,
      targetTs: message.ts,
      user: task.createdBy,
    }).catch((error) => error.message);
    if (problem) console.warn("Could not move the message", { ts: origin.moveTs, problem });
  }

  const permalink = task.link;
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
  // reported, and `/cade track` in a tasks channel has no thread to tell.
  if (task.source && !origin.reported) {
    const text = `<@${task.createdBy}> tracked this as a task: <${permalink}|${escapeSlack(task.title)}>. The team's on it!`;
    const body = { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
    if (origin.promptTs) {
      await callSlack(env, "chat.update", { channel: origin.channel, ts: origin.promptTs, ...body });
    } else {
      await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.threadTs, ...body });
    }
  }
  return message.ts;
}
