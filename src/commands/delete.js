import { roleOf } from "../channels.js";
import { markRequirementDeleted, markTaskDeleted } from "../db.js";
import { NOT_A_REQUIREMENT, loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, loadTask, syncTask } from "../tasks.js";

const DELETE_ACTION = "delete:confirm";
const CANCEL_ACTION = "delete:cancel";

// What can be deleted: a task, in its thread in a tasks or incidents channel,
// or a requirement or incident, in its thread in an external channel.
const KINDS = {
  task: { noun: "task", load: loadTask, missing: NOT_A_TASK },
  requirement: { noun: "requirement", load: loadRequirement, missing: NOT_A_REQUIREMENT },
};

// `@Cade delete` (or `@Cade remove`) in a task or requirement thread replies
// with Delete and Cancel buttons. Delete opens a second "are you sure"
// dialog, and only the person who asked for the deletion can confirm or
// cancel it. Confirming deletes the root message and Cade's replies in its
// thread.
//
// Whoever confirmed sees the messages go, so nothing more is said. A task
// tracked from a requirement or incident is removed with it, from its
// thread, so the two never part: removing a requirement that has been
// tracked deletes its task as well, which the question says, and the task
// can't be removed from the dev channel on its own.
//
// A bot token can only delete the bot's own messages, so people's replies
// stay behind under Slack's "This message was deleted" placeholder.
export default {
  name: "delete",
  aliases: ["remove"],
  description: "Delete the task or requirement and Cade's messages in its thread",
  usage: "@Cade delete",
  section: "thread",
  channel: ["tasks", "incidents", "external"],
  inThread: true,
  async run(command, { env }) {
    const kind = roleOf(env, command.channel) === "external" ? "requirement" : "task";
    const { noun, load, missing } = KINDS[kind];
    const item = await load(env, command.channel, command.threadTs);
    if (!item) return missing;
    if (kind === "task" && item.source) return belongsToRequirement(item);

    // A tracked requirement takes its task with it.
    const task = item.task;
    const also = task ? ` and its task <${task.link}|${escapeSlack(task.title)}> in <#${task.channel}>` : "";
    const question = `<@${command.user}>, delete the ${noun} *${escapeSlack(item.title)}*${also}? This cannot be undone.`;
    const deleted = task
      ? `"${item.title}", its task "${task.title}", and Cade's replies in both threads will be deleted.`
      : `"${item.title}" and Cade's replies in its thread will be deleted.`;
    const value = JSON.stringify({
      kind,
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
          // Cancel comes first and stands out, so the safe choice is the
          // easy one; Delete is plain and still asks again.
          elements: [
            {
              type: "button",
              action_id: CANCEL_ACTION,
              text: plainText("Cancel"),
              style: "primary",
              value,
            },
            {
              type: "button",
              action_id: DELETE_ACTION,
              text: plainText(`Delete ${noun}`),
              value,
              confirm: {
                title: plainText(`Delete ${noun}?`),
                text: plainText(deleted.slice(0, 300)),
                confirm: plainText("Delete"),
                deny: plainText(`Keep ${noun}`),
                style: "danger",
              },
            },
          ],
        },
      ],
    };
  },
  actions: {
    [DELETE_ACTION]: async (payload, context) => {
      const request = await authorize(payload, context.env);
      if (!request) return;
      const remove = request.kind === "requirement" ? deleteRequirement : deleteTask;
      context.waitUntil(remove(context.env, request.channel, request.ts, payload.user.id));
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
    text: `Only <@${request.requestedBy}> can confirm this deletion. Send \`@Cade delete\` to ask for your own.`,
  });
  return null;
}

async function deleteTask(env, channel, ts, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return;

  await deleteReplies(env, channel, ts);
  await markTaskDeleted(env, channel, ts);
  await syncTask(env, channel, ts, task, { deleted: true });
  // Deleting a message also removes its pin.
  await callSlack(env, "chat.delete", { channel, ts });
  console.log("Task deleted", { ts, user });
}

async function deleteRequirement(env, channel, ts, user) {
  const requirement = await loadRequirement(env, channel, ts);
  if (!requirement) return;
  // Its task first, even if it was tracked after the question was asked.
  if (requirement.task) {
    await deleteTask(env, requirement.task.channel, requirement.task.ts, user);
  }

  await deleteReplies(env, channel, ts);
  await markRequirementDeleted(env, channel, ts);
  await callSlack(env, "chat.delete", { channel, ts });
  console.log("Requirement deleted", { ts, user });
}

function belongsToRequirement(task) {
  const noun = task.source.incident ? "an incident" : "a requirement";
  const thread = task.source.link ? `<${task.source.link}|its thread>` : "its thread";
  return `This task belongs to ${noun}. Remove it from ${thread} with \`@Cade remove\`, which removes both.`;
}

// Deletes Cade's replies in a thread. They go first, so the root is not left
// behind if a delete fails midway.
async function deleteReplies(env, channel, ts) {
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

  for (const message of own) {
    await callSlack(env, "chat.delete", { channel, ts: message.ts }).catch((error) => {
      // Other bots' replies cannot be deleted with this token.
      console.warn("Could not delete reply", { ts: message.ts, error: error.message });
    });
  }
}
