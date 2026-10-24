import { roleOf } from "../channels.js";
import { NOT_A_REQUIREMENT, loadRequirement, updateRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, loadTask, setPinned, syncTask } from "../tasks.js";

const DELETE_ACTION = "delete:confirm";
const CANCEL_ACTION = "delete:cancel";

// What can be deleted: a task, in its thread in a tasks or incidents channel,
// or a requirement or incident, in its thread in an external channel.
const KINDS = {
  task: { noun: "task", load: loadTask, missing: NOT_A_TASK },
  requirement: { noun: "requirement", load: loadRequirement, missing: NOT_A_REQUIREMENT },
};

// `@LUMA delete` (or `@LUMA remove`) in a task or requirement thread replies
// with Delete and Cancel buttons. Delete opens a second "are you sure"
// dialog, and only the person who asked for the deletion can confirm or
// cancel it. Confirming deletes the root message and Luma's replies in its
// thread.
//
// Deleting a task also says so in the external thread it was tracked from,
// and a requirement it was tracked from goes back to In discussion, keeping
// the client's priority and due date. A requirement with a tracked task
// cannot be deleted, since the task is the team's: it must be untracked
// first, with `@LUMA remove` in the task's thread in the dev channel.
//
// A bot token can only delete the bot's own messages, so people's replies
// stay behind under Slack's "This message was deleted" placeholder.
export default {
  name: "delete",
  aliases: ["remove"],
  description: "Delete the task or requirement and Luma's messages in its thread",
  usage: "@LUMA delete",
  channel: ["tasks", "incidents", "external"],
  inThread: true,
  async run(command, { env }) {
    const kind = roleOf(env, command.channel) === "external" ? "requirement" : "task";
    const { noun, load, missing } = KINDS[kind];
    const item = await load(env, command.channel, command.threadTs);
    if (!item) return missing;
    if (item.task) return stillTracked(item);

    const question = `<@${command.user}>, delete the ${noun} *${escapeSlack(item.title)}*? This cannot be undone.`;
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
                text: plainText(
                  `"${item.title}" and Luma's replies in its thread will be deleted.`.slice(0, 300),
                ),
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
      // Buttons posted before requirements could be deleted have no kind.
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
    text: `Only <@${request.requestedBy}> can confirm this deletion. Send \`@LUMA delete\` to ask for your own.`,
  });
  return null;
}

async function deleteTask(env, channel, ts, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return;

  await deleteReplies(env, channel, ts);
  // The permalink is looked up while the task message still exists.
  await syncTask(env, channel, ts, task, { deleted: true });
  // Deleting a message also removes its pin.
  await callSlack(env, "chat.delete", { channel, ts });
  console.log("Task deleted", { ts, user });

  if (task.source) {
    // Matches the "tracked a task" announcement, without the link.
    const text = `<@${user}> untracked a task: ${escapeSlack(task.title)}`;
    await callSlack(env, "chat.postMessage", {
      channel: task.source.channel,
      thread_ts: task.source.threadTs,
      text,
      blocks: [{ type: "section", text: mrkdwn(text) }],
    });
    await updateRequirement(env, task.source, (requirement) =>
      requirement.task?.ts === ts
        ? { ...requirement, status: "DISCUSSION", task: undefined }
        : null,
    );
    // Back in discussion, so pinned again even if the task was Done.
    if (task.source.requirement) {
      await setPinned(env, task.source.channel, task.source.threadTs, true);
    }
  }

  await callSlack(env, "chat.postEphemeral", {
    channel,
    user,
    text: `Deleted the task "${escapeSlack(task.title)}".`,
  });
}

async function deleteRequirement(env, channel, ts, user) {
  const requirement = await loadRequirement(env, channel, ts);
  if (!requirement) return;
  if (requirement.task) {
    // It was tracked after the buttons were posted.
    await callSlack(env, "chat.postEphemeral", {
      channel,
      thread_ts: ts,
      user,
      text: stillTracked(requirement),
    });
    return;
  }

  await deleteReplies(env, channel, ts);
  await callSlack(env, "chat.delete", { channel, ts });
  console.log("Requirement deleted", { ts, user });

  await callSlack(env, "chat.postEphemeral", {
    channel,
    user,
    text: `Deleted the requirement "${escapeSlack(requirement.title)}".`,
  });
}

function stillTracked(requirement) {
  const { link, title } = requirement.task;
  return `This requirement is tracked as <${link}|${escapeSlack(title)}>. Untrack it first: send \`@LUMA remove\` in <${link}|the task's thread>.`;
}

// Deletes Luma's replies in a thread. They go first, so the root is not left
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
