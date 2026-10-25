import { activeRequirements } from "../db.js";
import { loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText, respondLater } from "../slack.js";

const PICK_ACTION = "move:pick";
const MOVE_ACTION = "move:confirm";
const CANCEL_ACTION = "move:cancel";
const PICK_BLOCK = "move:requirement";

const NOT_IN_THREAD = "Reply `@Cade move` in the thread of the message you want to move.";
const NO_REQUIREMENTS = "There are no open requirements here. Start one with `/cade requirement`.";

// More about a requirement sometimes arrives as a message of its own in the
// external channel. `@Cade move`, replied in that message's thread, asks
// privately which open requirement or incident it belongs to. Slack can't
// move messages, so Move copies it into the requirement's thread, quoted and
// credited to whoever wrote it, and replies under the original with a link
// to the copy, asking people to carry on there. Only the message moves, not its replies, which the copy's
// link back still reaches. A bot token can't delete people's messages, so
// the original stays.
export default {
  name: "move",
  description: "Move a message into a requirement's thread",
  usage: "@Cade move",
  section: "thread",
  channel: "external",
  async run(command, { env }) {
    const inThread = command.threadTs && command.threadTs !== command.ts;
    if (!inThread) return NOT_IN_THREAD;
    if (await loadRequirement(env, command.channel, command.threadTs)) {
      return "This is already a requirement thread.";
    }
    const message = await rootMessage(env, command.channel, command.threadTs);
    if (!message || message.bot_id) return "I can only move people's messages.";
    const requirements = await activeRequirements(env, command.channel);
    if (!requirements.length) return NO_REQUIREMENTS;

    await callSlack(env, "chat.postEphemeral", {
      channel: command.channel,
      thread_ts: command.threadTs,
      user: command.user,
      ...picker(command.channel, command.threadTs, requirements),
    });
  },
  actions: {
    // Picking only chooses; Move moves.
    [PICK_ACTION]: async () => {},
    [MOVE_ACTION]: async (payload, context) => {
      const picked = payload.state?.values?.[PICK_BLOCK]?.[PICK_ACTION]?.selected_option?.value;
      if (!picked) {
        await callSlack(context.env, "chat.postEphemeral", {
          channel: payload.channel.id,
          user: payload.user.id,
          text: "Pick a requirement first, then press Move.",
        });
        return;
      }
      context.waitUntil(move(context.env, payload, picked));
    },
    [CANCEL_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

function picker(channel, ts, requirements) {
  const text = "Which requirement should I move this message to?";
  const value = JSON.stringify({ channel, ts });
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        block_id: PICK_BLOCK,
        elements: [
          {
            type: "static_select",
            action_id: PICK_ACTION,
            placeholder: plainText("Choose a requirement"),
            options: requirements.map((requirement) => ({
              text: plainText(optionText(requirement)),
              value: requirement.ts,
            })),
          },
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: MOVE_ACTION, text: plainText("Move"), style: "primary", value },
          { type: "button", action_id: CANCEL_ACTION, text: plainText("Cancel"), value },
        ],
      },
    ],
  };
}

// A menu option's text is at most 75 characters.
function optionText({ title, incident }) {
  const text = `${incident ? "Incident" : "Requirement"} · ${title}`;
  return text.length > 75 ? `${text.slice(0, 74)}…` : text;
}

// Copies the message into the picked requirement's thread, replies under the
// original, and removes the private picker. The requirement may have been
// done or deleted, or the message deleted, since the picker was shown.
async function move(env, payload, requirementTs) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const done = (text) => respondLater(payload.response_url, { replace_original: true, text });

  const requirement = await loadRequirement(env, channel, requirementTs);
  if (!requirement || requirement.status === "DONE") {
    await done("That requirement has been closed or deleted since, so I didn't move anything.");
    return;
  }
  const message = await rootMessage(env, channel, ts);
  if (!message) {
    await done("That message has been deleted since, so there's nothing to move.");
    return;
  }

  const { permalink: original } = await callSlack(env, "chat.getPermalink", { channel, message_ts: ts });
  const quoted = (message.text ?? "").split("\n").map((line) => `> ${line}`).join("\n");
  const files = message.files?.length ? "\n_It has attachments: see the original._" : "";
  const copy = await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: requirementTs,
    text: `Moved from <@${message.user}>'s <${original}|message>:\n${quoted}${files}`,
  });

  const { permalink } = await callSlack(env, "chat.getPermalink", { channel, message_ts: copy.ts });
  const noun = requirement.incident ? "incident" : "requirement";
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    text: `<@${payload.user.id}> moved this message to the ${noun} thread <${permalink}|${escapeSlack(requirement.title)}>. Please carry on the conversation there.`,
  });
  await respondLater(payload.response_url, { delete_original: true });
  console.log("Message moved", { ts, requirementTs, user: payload.user.id });
}

// The thread's root message, or null if it is gone.
async function rootMessage(env, channel, ts) {
  try {
    const { messages } = await callSlack(env, "conversations.replies", { channel, ts, limit: 1 });
    const message = messages?.[0];
    return message && message.ts === ts && message.subtype !== "tombstone" ? message : null;
  } catch (error) {
    if (/message_not_found|thread_not_found/.test(error.message)) return null;
    throw error;
  }
}
