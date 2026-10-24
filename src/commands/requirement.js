import { callSlack, escapeSlack, plainText } from "../slack.js";
import { requirementMessage } from "../requirements.js";
import { readTaskForm, taskFormBlocks } from "../tasks.js";

const REQUIREMENT_VIEW = "requirement";

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

async function postRequirement(env, channel, requirement) {
  try {
    const message = await callSlack(env, "chat.postMessage", {
      channel,
      ...requirementMessage(requirement),
    });
    console.log("Requirement created", { channel, ts: message.ts, createdBy: requirement.createdBy });
  } catch (error) {
    await callSlack(env, "chat.postEphemeral", {
      channel,
      user: requirement.createdBy,
      text: `Sorry, the requirement "${escapeSlack(requirement.title)}" could not be posted.`,
    }).catch(() => {});
    throw error;
  }
}
