import { pairFor } from "../channels.js";
import { POST_ATTEMPTS, countPostAttempt, insertRequirement, markRequirementPosted } from "../db.js";
import { INCIDENT, requirementMessage } from "../requirements.js";
import { callSlack, escapeSlack, plainText } from "../slack.js";
import { noPeople, readTaskForm, refreshSummary, setPinned, taskFormBlocks } from "../tasks.js";
import { moveMessage, offerStart } from "./move.js";
import { createTask } from "./track.js";

const REQUIREMENT_VIEW = "requirement";
const INCIDENT_VIEW = "incident";

const NO_INCIDENTS = "I can't take incidents in this channel yet. Add an `incidents` channel to its pair in `CHANNEL_PAIRS`, and I'll be ready.";

// `@Cade requirement` and `@Cade incident` start one from a message already
// in the channel, replied in its thread (see offerStart in move.js).
function fromThread(env, command, kind) {
  const inThread = command.threadTs && command.threadTs !== command.ts;
  if (inThread) return offerStart(env, command, kind);
  return `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`;
}

// `/cade requirement` in an external channel asks for the requirement's name,
// priority and optional due date, in the same form as a task, then posts it
// as a new message whose thread is where it is discussed. Once it is agreed,
// `@Cade track` in that thread opens the task form with those filled in, and
// the requirement's message follows the task. `@Cade requirement` in the
// thread of a message in the channel starts one from that message.
export default {
  name: "requirement",
  description: "Start a thread to discuss a new requirement",
  usage: "@Cade requirement",
  slashUsage: "/cade requirement",
  section: "start",
  channel: "external",
  run: (command, { env }) => fromThread(env, command, "requirement"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", {
      trigger_id: command.triggerId,
      view: requirementView({ channel: command.channel }),
    });
  },
  views: { [REQUIREMENT_VIEW]: submit },
};

// `origin` is { channel }, and from the prompt for a message posted on its
// own (see move.js), the message's `moveTs` and its first line as the
// `title`, to start with; the message is moved into the new thread once it
// is posted.
export function requirementView(origin) {
  return {
    type: "modal",
    callback_id: REQUIREMENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New requirement"),
    submit: plainText("Start thread"),
    close: plainText("Cancel"),
    blocks: taskFormBlocks("Requirement name", { title: origin.title }),
  };
}

async function submit(payload, context) {
  const { title, dueDate, priority, errors } = readTaskForm(
    payload.view.state.values,
    "Please give the requirement a name.",
  );
  if (errors) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  const requirement = {
    title,
    status: "DISCUSSION",
    priority,
    dueDate,
    createdBy: payload.user.id,
  };
  context.waitUntil(createRequirement(context.env, origin.channel, requirement, origin.moveTs));
  return { response_action: "clear" };
}

// `/cade incident` in an external channel asks only for what the incident
// is: incidents are always urgent and due immediately. It posts the incident
// like a requirement, then tracks it straight away as a task in the pair's
// incidents channel, without waiting for `@Cade track`. From then on it works
// like a tracked requirement, except that its priority and due date never
// change. `@Cade incident` in the thread of a message in the channel
// reports one from that message.
export const incident = {
  name: "incident",
  description: "Report an incident, tracked straight away in the incidents channel",
  usage: "@Cade incident",
  slashUsage: "/cade incident",
  section: "start",
  channel: "external",
  async run(command, { env }) {
    if (!pairFor(env, command.channel).incidents) return NO_INCIDENTS;
    return fromThread(env, command, "incident");
  },
  async slash(command, { env }) {
    if (!pairFor(env, command.channel).incidents) return NO_INCIDENTS;
    await callSlack(env, "views.open", {
      trigger_id: command.triggerId,
      view: incidentView({ channel: command.channel }),
    });
  },
  views: { [INCIDENT_VIEW]: submitIncident },
};

// `origin` is as for requirementView.
export function incidentView(origin) {
  return {
    type: "modal",
    callback_id: INCIDENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Report incident"),
    submit: plainText("Report"),
    close: plainText("Cancel"),
    blocks: [
      ...taskFormBlocks("What's the incident?", { title: origin.title }, { details: false }),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Incidents are :red_circle: Urgent and due Immediate. I'll pass this straight to the team.",
          },
        ],
      },
    ],
  };
}

async function submitIncident(payload, context) {
  const { title, errors } = readTaskForm(payload.view.state.values, "Please tell us what's going on.");
  if (errors) return { response_action: "errors", errors };

  const { channel, moveTs } = JSON.parse(payload.view.private_metadata || "{}");
  const incident = {
    title,
    status: "DISCUSSION",
    ...INCIDENT,
    incident: true,
    createdBy: payload.user.id,
  };
  // Its task is tracked once it is posted (see publishRequirement).
  context.waitUntil(createRequirement(context.env, channel, incident, moveTs));
  return { response_action: "clear" };
}

// Stores the requirement (or incident), then posts it, and moves the message
// at `moveTs`, if any, into its thread. The move is only made if it is
// posted straight away, since a retry doesn't know of it; `@Cade move` is
// there for that.
async function createRequirement(env, channel, requirement, moveTs) {
  const id = await insertRequirement(env, channel, requirement);
  const ts = await publishRequirement(env, { id, channel, requirement, attempts: 0 });
  if (!ts || !moveTs) return;
  const problem = await moveMessage(env, { channel, ts: moveTs, targetTs: ts, user: requirement.createdBy }).catch(
    (error) => error.message,
  );
  if (problem) console.warn("Could not move the message", { ts: moveTs, problem });
}

// Posts a stored requirement that has no root message yet and pins it; an
// incident is then tracked straight away. If Slack refuses the post, it waits
// for the next retry (see retry.js), and whoever started it is told, the
// first time and when Cade gives up. Returns the root message's ts, if it
// was posted.
export async function publishRequirement(env, { id, channel, requirement, attempts }) {
  const noun = requirement.incident ? "incident" : "requirement";
  let message;
  try {
    message = await callSlack(env, "chat.postMessage", {
      channel,
      ...requirementMessage(requirement),
    });
  } catch (error) {
    const tried = await countPostAttempt(env, "requirements", id);
    console.warn("Could not post the requirement", { id, attempts: tried, error: error.message });
    if (attempts === 0 || tried >= POST_ATTEMPTS) {
      const text = tried >= POST_ATTEMPTS
        ? `Sorry, I couldn't post the ${noun} "${escapeSlack(requirement.title)}", even after a few tries.`
        : `Sorry, I couldn't post the ${noun} "${escapeSlack(requirement.title)}" just now. I'll try again in a few minutes.`;
      await callSlack(env, "chat.postEphemeral", { channel, user: requirement.createdBy, text }).catch(() => {});
    }
    return;
  }
  await markRequirementPosted(env, id, message.ts);
  console.log("Requirement created", {
    channel,
    ts: message.ts,
    incident: Boolean(requirement.incident),
    createdBy: requirement.createdBy,
  });
  // Open requirements are pinned in the external channel, as open tasks
  // are in the dev channel, until their task is Done.
  await setPinned(env, channel, message.ts, true);
  await refreshSummary(env, channel);

  if (requirement.incident) {
    const { title, createdBy } = requirement;
    const task = { title, status: "TODO", ...INCIDENT, people: noPeople(), createdBy };
    await createTask(env, task, {
      channel,
      threadTs: message.ts,
      requirement: true,
      incident: true,
      // Tracked as it's reported, so there's nothing to announce.
      reported: true,
      ...INCIDENT,
    });
  }
  return message.ts;
}
