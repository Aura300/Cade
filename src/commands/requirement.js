import { callSlack, escapeSlack, plainText } from "../slack.js";
import { requirementMessage } from "../requirements.js";

const REQUIREMENT_VIEW = "requirement";

// `/luma requirement` in an external channel asks for the requirement's name,
// then posts it as a new message whose thread is where it is discussed. Once
// it is agreed, `@LUMA track` in that thread opens the task form with the
// name filled in, and the requirement's message follows the task's status.
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
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: plainText("Requirement name"),
        element: { type: "plain_text_input", action_id: "value", max_length: 150 },
      },
    ],
  };
}

async function submit(payload, context) {
  const title = payload.view.state.values.title.value.value?.trim() ?? "";
  if (!title) {
    return { response_action: "errors", errors: { title: "Enter a requirement name." } };
  }

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  const requirement = { title, status: "DISCUSSION", createdBy: payload.user.id };
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
