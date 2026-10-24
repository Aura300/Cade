import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, loadTask } from "../tasks.js";

const DELETE_ACTION = "delete:confirm";
const CANCEL_ACTION = "delete:cancel";

// `luma delete` (or `luma remove`) in a task thread replies with Delete and
// Cancel buttons. Delete opens a second "are you sure" dialog, and only the
// person who asked for the deletion can confirm or cancel it. Confirming
// deletes the task message and Luma's replies in its thread.
//
// A bot token can only delete the bot's own messages, so people's replies
// stay behind under Slack's "This message was deleted" placeholder.
export default {
  name: "delete",
  aliases: ["remove"],
  description: "Delete the task and Luma's messages in its thread",
  usage: "luma delete",
  sources: ["message"],
  channel: "TASK_CHANNEL_ID",
  inThread: true,
  async run(command, { env }) {
    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    const question = `<@${command.user}>, delete the task *${escapeSlack(task.title)}*? This cannot be undone.`;
    const value = JSON.stringify({
      channel: command.channel,
      ts: command.threadTs,
      requestedBy: command.user,
    });
    return {
      text: question,
      blocks: [
        { type: "section", text: mrkdwn(question) },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: DELETE_ACTION,
              text: plainText("Delete task"),
              style: "danger",
              value,
              confirm: {
                title: plainText("Delete task?"),
                text: plainText(
                  `"${task.title}" and Luma's replies in its thread will be deleted.`.slice(0, 300),
                ),
                confirm: plainText("Delete"),
                deny: plainText("Keep task"),
                style: "danger",
              },
            },
            {
              type: "button",
              action_id: CANCEL_ACTION,
              text: plainText("Cancel"),
              value,
            },
          ],
        },
      ],
    };
  },
  actions: {
    [DELETE_ACTION]: async (payload, context) => {
      const request = await authorize(payload, context.env);
      if (request) {
        context.waitUntil(deleteTask(context.env, request.channel, request.ts, payload.user.id));
      }
    },
    [CANCEL_ACTION]: async (payload, context) => {
      const request = await authorize(payload, context.env);
      if (request) {
        await callSlack(context.env, "chat.delete", {
          channel: request.channel,
          ts: payload.message.ts,
        });
      }
    },
  },
};

// Returns the deletion request if the person clicking is the one who made it;
// otherwise tells them, privately, who can.
async function authorize(payload, env) {
  const request = JSON.parse(payload.actions[0].value);
  if (payload.user.id === request.requestedBy) return request;

  await callSlack(env, "chat.postEphemeral", {
    channel: request.channel,
    thread_ts: request.ts,
    user: payload.user.id,
    text: `Only <@${request.requestedBy}> can confirm this deletion. Send \`luma delete\` to ask for your own.`,
  });
  return null;
}

async function deleteTask(env, channel, ts, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return;

  const own = [];
  let cursor;
  do {
    const page = await callSlack(env, "conversations.replies", {
      channel,
      ts,
      limit: 200,
      cursor,
    });
    own.push(...page.messages.filter((message) => message.bot_id && message.ts !== ts));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Replies first, so the root is not left behind if a delete fails midway.
  for (const message of own) {
    await callSlack(env, "chat.delete", { channel, ts: message.ts }).catch((error) => {
      // Other bots' replies cannot be deleted with this token.
      console.warn("Could not delete reply", { ts: message.ts, error: error.message });
    });
  }
  // Deleting a message also removes its pin.
  await callSlack(env, "chat.delete", { channel, ts });
  console.log("Task deleted", { ts, deletedReplies: own.length, user });

  await callSlack(env, "chat.postEphemeral", {
    channel,
    user,
    text: `Deleted the task "${escapeSlack(task.title)}".`,
  });
}
