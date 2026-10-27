import { POST_ATTEMPTS, countPostAttempt, insertTask, markTaskPosted } from "../db.js";
import { callSlack, escapeSlack, plainText } from "../slack.js";
import { fromTheCall, syncApplied } from "./debrief.js";
import { moveMessage, offerStart } from "./move.js";
import {
  INCIDENT,
  chosenProject,
  noPeople,
  projectBlock,
  readTaskForm,
  refreshSummary,
  setPinned,
  syncTask,
  taskFormBlocks,
  taskMessage,
} from "../tasks.js";

const TRACK_VIEW = "track";
const INCIDENT_VIEW = "incident";

// `/cade task` in a dev channel opens the task form straight away, since a
// slash command carries a trigger_id, and posts the task in that channel.
// `/cade incident` does the same for an incident, asking only what it is:
// incidents are always urgent and due immediately, and their cards say
// they're incidents.
//
// `@Cade task` or `@Cade incident` in the thread of a message in a dev
// channel offers, privately, to start one from that message (see offerStart
// in move.js): the form, named from its first line, and once it is posted
// the message is moved into its thread. The message shortcuts New task
// and New incident do the same from any message, anywhere (see
// move.js); outside a dev channel, with more than one group, the form asks
// which project it's for.
export default {
  name: "task",
  description: "Track a task (`@Cade task` in a message's thread tracks that message)",
  usage: "@Cade task",
  slashUsage: "/cade task",
  section: "start",
  channel: "tasks",
  run: (command, { env }) => fromThread(env, command, "task"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: trackView(env, { channel: command.channel }) });
  },
  views: { [TRACK_VIEW]: submit },
};

export const incident = {
  name: "incident",
  description: "Report an incident, always urgent and due immediately",
  usage: "@Cade incident",
  slashUsage: "/cade incident",
  section: "start",
  channel: "tasks",
  run: (command, { env }) => fromThread(env, command, "incident"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: incidentView(env, { channel: command.channel }) });
  },
  views: { [INCIDENT_VIEW]: submitIncident },
};

// `@Cade task` and `@Cade incident` start one from a message in the
// channel, replied in its thread.
function fromThread(env, command, kind) {
  const inThread = command.threadTs && command.threadTs !== command.ts;
  if (inThread) return offerStart(env, command, kind);
  return `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`;
}

// `origin` says where the task goes: `channel`, the dev channel, or, without
// one, the form asks for the project. It may have `title` to start with,
// and `move`, the message to move into the task's thread once it is posted
// (see moveMessage in move.js). From `/cade debrief` it has `sync`, the
// suggestion it applies (see debrief.js), and the form has an Initial
// message, starting as `initial`, posted in the task's thread.
export function trackView(env, origin, { initial } = {}) {
  return {
    type: "modal",
    callback_id: TRACK_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New task"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      ...(origin.channel ? [] : [projectBlock(env)]),
      ...taskFormBlocks("Task title", origin),
      ...(origin.sync ? [initialMessageBlock(initial)] : []),
    ],
  };
}

// `origin` is as for trackView.
export function incidentView(env, origin) {
  return {
    type: "modal",
    callback_id: INCIDENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New incident"),
    submit: plainText("Report"),
    close: plainText("Cancel"),
    blocks: [
      ...(origin.channel ? [] : [projectBlock(env)]),
      ...taskFormBlocks("What's the incident?", origin, { details: false }),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Incidents are :red_circle: Urgent and due Immediate. I'll pass this straight to the team." }],
      },
    ],
  };
}

// The Initial message of a form opened from `/cade debrief`, posted in the
// thread of the task it makes.
function initialMessageBlock(initial) {
  return {
    type: "input",
    block_id: "initial_message",
    optional: true,
    label: plainText("Initial message"),
    hint: plainText("Posted in the task's thread once it's made."),
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      max_length: 3000,
      initial_value: initial?.slice(0, 3000) || undefined,
    },
  };
}

// The form's origin, with the project chosen on it, or the errors to show.
function readOrigin(payload) {
  const origin = JSON.parse(payload.view.private_metadata || "{}");
  origin.channel ??= chosenProject(payload.view.state.values);
  return origin.channel ? { origin } : { errors: { project: "Please choose a project." } };
}

async function submit(payload, context) {
  const { values } = payload.view.state;
  const { title, dueDate, priority, errors } = readTaskForm(values, "Please give the task a title.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task = { title, priority, status: "TODO", dueDate, people: noPeople(), createdBy: payload.user.id };
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

function submitIncident(payload, context) {
  const { title, errors } = readTaskForm(payload.view.state.values, "Please tell us what's going on.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task = { title, status: "TODO", ...INCIDENT, incident: true, people: noPeople(), createdBy: payload.user.id };
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

// Stores the task in the dev channel `origin.channel`, then posts it, and
// returns its root message's ts, if it was posted. Stored before it is
// posted, so that if Slack doesn't take it, it is posted later (see
// retry.js); what follows the post needs only `move` and whoever made it.
export async function createTask(env, task, origin) {
  const after = { move: origin.move };
  const id = await insertTask(env, origin.channel, task, after);
  return publishTask(env, { id, channel: origin.channel, task, origin: after, attempts: 0 });
}

// Posts a stored task that has no root message yet, then pins it, records it
// in the Sheet and moves the message it was made from into its thread, and
// returns its ts. If Slack refuses the post, the task waits for the next
// retry, and whoever made it is told, the first time and when Cade gives up.
export async function publishTask(env, { id, channel, task, origin, attempts }) {
  let message;
  try {
    message = await callSlack(env, "chat.postMessage", { channel, ...taskMessage(task) });
  } catch (error) {
    const tried = await countPostAttempt(env, id);
    console.warn("Could not post the task", { id, attempts: tried, error: error.message });
    if (attempts === 0 || tried >= POST_ATTEMPTS) {
      const text = tried >= POST_ATTEMPTS
        ? `Sorry, I couldn't create the task "${escapeSlack(task.title)}", even after a few tries.`
        : `Sorry, I couldn't post the task "${escapeSlack(task.title)}" just now. I'll try again in a few minutes.`;
      await callSlack(env, "chat.postEphemeral", { channel, user: task.createdBy, text }).catch(() => {});
    }
    return;
  }
  // The task's link is stored with it, for the Sheet. It is a convenience,
  // so the task is stored without it if it can't be looked up.
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
    incident: Boolean(task.incident),
    createdBy: task.createdBy,
  });
  await setPinned(env, message.channel, message.ts, true);
  await syncTask(env, message.channel, message.ts, task);
  await refreshSummary(env, message.channel);
  if (origin.move) {
    const problem = await moveMessage(env, {
      from: origin.move,
      target: { channel: message.channel, ts: message.ts },
      user: task.createdBy,
    }).catch((error) => error.message);
    if (problem) console.warn("Could not move the message", { ts: origin.move.ts, problem });
  }
  return message.ts;
}
