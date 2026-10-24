import { pairFor } from "../channels.js";
import { INCIDENT, requirementMessage } from "../requirements.js";
import { callSlack, escapeSlack, plainText } from "../slack.js";
import { noPeople, readTaskForm, setPinned, taskFormBlocks } from "../tasks.js";
import { createTask } from "./track.js";

const REQUIREMENT_VIEW = "requirement";
const INCIDENT_VIEW = "incident";

// `/luma requirement` in an external channel asks for the requirement's name,
// priority and optional due date, in the same form as a task, then posts it
// as a new message whose thread is where it is discussed. Once it is agreed,
// `@LUMA track` in that thread opens the task form with those filled in, and
// the requirement's message follows the task.
export default {
  name: "requirement",
  description: "Start a thread to discuss a new requirement",
  slashUsage: "/luma requirement",
  channel: "external",
  async slash(command, { env }) {
    await callSlack(env, "views.open", {
      trigger_id: command.triggerId,
      view: requirementView({ channel: command.channel }),
    });
  },
  views: { [REQUIREMENT_VIEW]: submit },
};

function requirementView(origin) {
  return {
    type: "modal",
    callback_id: REQUIREMENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New requirement"),
    submit: plainText("Start thread"),
    close: plainText("Cancel"),
    blocks: taskFormBlocks("Requirement name"),
  };
}

async function submit(payload, context) {
  const { title, dueDate, priority, errors } = readTaskForm(
    payload.view.state.values,
    "Enter a requirement name.",
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
  context.waitUntil(postRequirement(context.env, origin.channel, requirement));
  return { response_action: "clear" };
}

// `/luma incident` in an external channel asks only for what the incident
// is: incidents are always urgent and due immediately. It posts the incident
// like a requirement, then tracks it straight away as a task in the pair's
// incidents channel, without waiting for `@LUMA track`. From then on it works
// like a tracked requirement, except that its priority and due date never
// change.
export const incident = {
  name: "incident",
  description: "Report an incident, tracked straight away in the incidents channel",
  slashUsage: "/luma incident",
  channel: "external",
  async slash(command, { env }) {
    if (!pairFor(env, command.channel).incidents) {
      return "Incidents aren't set up for this channel yet: add an `incidents` channel to its pair in `CHANNEL_PAIRS`.";
    }
    await callSlack(env, "views.open", {
      trigger_id: command.triggerId,
      view: incidentView({ channel: command.channel }),
    });
  },
  views: { [INCIDENT_VIEW]: submitIncident },
};

function incidentView(origin) {
  return {
    type: "modal",
    callback_id: INCIDENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Report incident"),
    submit: plainText("Report"),
    close: plainText("Cancel"),
    blocks: [
      ...taskFormBlocks("What's the incident?", {}, { details: false }),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Incidents are :red_circle: Urgent and due Immediate, and go straight to the team.",
          },
        ],
      },
    ],
  };
}

async function submitIncident(payload, context) {
  const { title, errors } = readTaskForm(payload.view.state.values, "Describe the incident.");
  if (errors) return { response_action: "errors", errors };

  const { channel } = JSON.parse(payload.view.private_metadata || "{}");
  const createdBy = payload.user.id;
  context.waitUntil(
    (async () => {
      const ts = await postRequirement(context.env, channel, {
        title,
        status: "DISCUSSION",
        ...INCIDENT,
        incident: true,
        createdBy,
      });
      const task = { title, status: "TODO", ...INCIDENT, people: noPeople(), createdBy };
      await createTask(context.env, task, {
        channel,
        threadTs: ts,
        requirement: true,
        incident: true,
        ...INCIDENT,
      });
    })(),
  );
  return { response_action: "clear" };
}

// Posts the requirement (or incident) and returns its message's ts.
async function postRequirement(env, channel, requirement) {
  const noun = requirement.incident ? "incident" : "requirement";
  try {
    const message = await callSlack(env, "chat.postMessage", {
      channel,
      ...requirementMessage(requirement),
    });
    console.log("Requirement created", {
      channel,
      ts: message.ts,
      incident: Boolean(requirement.incident),
      createdBy: requirement.createdBy,
    });
    // Open requirements are pinned in the external channel, as open tasks
    // are in the dev channel, until their task is Done.
    await setPinned(env, channel, message.ts, true);
    return message.ts;
  } catch (error) {
    await callSlack(env, "chat.postEphemeral", {
      channel,
      user: requirement.createdBy,
      text: `Sorry, the ${noun} "${escapeSlack(requirement.title)}" could not be posted.`,
    }).catch(() => {});
    throw error;
  }
}
