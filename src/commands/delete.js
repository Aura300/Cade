import { roleOf } from "../channels.js";
import {
  getTask,
  getTaskIncludingDeleted,
  latestTaskFrom,
  markRequirementDeleted,
  markTaskDeleted,
  markUnpostedTasksDeleted,
} from "../db.js";
import { NOT_A_REQUIREMENT, loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, linkedMessage, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, refreshSummary, syncTask } from "../tasks.js";

const DELETE_ACTION = "delete:confirm";
const CANCEL_ACTION = "delete:cancel";

// Slack's errors for a message or thread that is already gone.
const GONE = /message_not_found|thread_not_found/;
// Slack's error for a message the bot didn't post, which it can't delete.
const NOT_OURS = /cant_delete_message/;

const NO_LINK = "Paste the link to what to remove: `/cade remove <link>`, with the link from Copy link on its message.";

// What the buttons say is deleted, by kind.
const NOUNS = { task: "task", requirement: "requirement", message: "message", thread: "messages" };

// `@Cade delete` (or `@Cade remove`) in a task or requirement thread replies
// with Delete and Cancel buttons. Delete opens a second "are you sure"
// dialog, and only the person who asked for the deletion can confirm or
// cancel it. Confirming deletes the root message and Cade's replies in its
// thread.
//
// Whoever confirmed sees the messages go, so nothing more is said. A task
// tracked from a requirement or incident is removed with it, from its
// thread, so the two never part: removing a requirement deletes its task as
// well, which the question says, and while the requirement is there the task
// can't be removed from the dev channel on its own. Once the requirement is
// gone, deleted from Cade or by hand in Slack, its task is an orphan, and
// can be removed from its own thread.
//
// The task's messages go before it is marked deleted, so if a deletion fails
// midway it can be tried again. A task marked deleted whose messages are
// still there, left by a deletion that failed before that order, can be
// removed again too.
//
// A bot token can only delete the bot's own messages, so people's replies
// stay behind under Slack's "This message was deleted" placeholder.
//
// `/cade remove <link>` (or `/cade delete <link>`) asks the same privately,
// from anywhere, about whatever the link points at: a task or requirement,
// as above; any other message's thread, whose root goes too if Cade posted
// it; or a single reply, if Cade posted it. The answer, too, is private.
export default {
  name: "delete",
  aliases: ["remove"],
  description: "Delete the task or requirement and Cade's messages in its thread, or what a link points at",
  usage: "@Cade delete",
  slashUsage: "/cade remove <link>",
  section: "thread",
  channel: ["tasks", "external"],
  slashChannel: [],
  inThread: true,
  async run(command, { env }) {
    return roleOf(env, command.channel) === "external"
      ? askRequirement(env, command)
      : askTask(env, command);
  },
  async slash(command, context) {
    const link = linkedMessage(command.text);
    if (!link) return NO_LINK;
    // Reading the thread can take longer than Slack waits for a slash
    // command's answer, so the question follows.
    context.waitUntil(
      (async () => respondLater(command.responseUrl, await askLinked(context.env, link, command.user)))(),
    );
  },
  actions: {
    [DELETE_ACTION]: async (payload, context) => {
      const request = await authorize(payload, context.env);
      if (!request) return;
      // Buttons from before requirements could be deleted have no kind.
      const remove = REMOVERS[request.kind] ?? deleteTaskOnly;
      context.waitUntil(
        (async () => {
          const result = await remove(context.env, request.channel, request.ts, payload.user.id);
          // A private question is replaced by how it went.
          if (request.private) {
            await respondLater(payload.response_url, { replace_original: true, text: result ?? "Done, it's gone." });
          }
        })(),
      );
    },
    [CANCEL_ACTION]: async (payload, context) => {
      const request = await authorize(payload, context.env);
      if (!request) return;
      if (request.private) {
        await respondLater(payload.response_url, { delete_original: true });
        return;
      }
      await callSlack(context.env, "chat.delete", {
        channel: request.channel,
        ts: payload.message.ts,
      });
    },
  },
};

const REMOVERS = {
  task: deleteTaskOnly,
  requirement: deleteRequirement,
  message: deleteOne,
  thread: deleteThread,
};

// The question for `/cade remove <link>`, about what the link points at.
async function askLinked(env, link, user) {
  const asked = { channel: link.channel, threadTs: link.ts, user, private: true };
  if (link.threadTs) {
    return confirmation(asked, "message", "should I remove that message?", "", null, "I'll delete that message, if I posted it.");
  }
  if (await getTaskIncludingDeleted(env, link.channel, link.ts)) return askTask(env, asked);
  if (await loadRequirement(env, link.channel, link.ts)) return askRequirement(env, asked);
  return confirmation(
    asked,
    "thread",
    "should I remove my messages in that thread?",
    "",
    null,
    "I'll delete my replies in that thread, and the message itself if I posted it.",
  );
}

async function askTask(env, command) {
  const task = await getTaskIncludingDeleted(env, command.channel, command.threadTs);
  if (!task) return NOT_A_TASK;
  if (!task.source) {
    return confirmation(command, "task", `should I delete the task *${escapeSlack(task.title)}*?`, task.title);
  }
  if ((await sourceState(env, task.source)).alive) return belongsToRequirement(task);
  const noun = task.source.incident ? "incident" : "requirement";
  return confirmation(
    command,
    "task",
    `the ${noun} this task came from has been deleted, so should I delete the task *${escapeSlack(task.title)}* on its own?`,
    task.title,
  );
}

async function askRequirement(env, command) {
  const requirement = await loadRequirement(env, command.channel, command.threadTs);
  if (!requirement) return NOT_A_REQUIREMENT;
  // A tracked requirement takes its task with it.
  const task = await liveTaskOf(env, command.channel, command.threadTs, requirement);
  const also = task ? ` and its task <${task.link}|${escapeSlack(task.title)}> in <#${task.channel}>` : "";
  return confirmation(
    command,
    "requirement",
    `should I delete the requirement *${escapeSlack(requirement.title)}*${also}?`,
    requirement.title,
    task,
  );
}

// The Delete and Cancel buttons, under `question`, which is put to whoever
// asked. `title` is what's deleted, and `task` the task deleted with it;
// `deleted` says what goes instead, for messages that are neither. A
// `private` command, from `/cade remove`, is answered through its
// response_url.
function confirmation(command, kind, question, title, task, deleted) {
  const text = `<@${command.user}>, ${question} There's no undo.`;
  deleted ??= task
    ? `I'll delete "${title}", its task "${task.title}", and my replies in both threads.`
    : `I'll delete "${title}" and my replies in its thread.`;
  const value = JSON.stringify({
    kind,
    channel: command.channel,
    ts: command.threadTs,
    requestedBy: command.user,
    ...(command.private && { private: true }),
  });
  const noun = NOUNS[kind];
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
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
}

// Returns the deletion request if the person clicking is the one who made it;
// otherwise tells them, privately, who can.
async function authorize(payload, env) {
  const request = JSON.parse(payload.actions[0].value);
  if (payload.user.id === request.requestedBy) return request;

  await callSlack(env, "chat.postEphemeral", {
    channel: request.channel,
    thread_ts: request.ts,
    user: payload.user.id,
    text: `Only <@${request.requestedBy}> can confirm this one. If you'd like to delete it, send \`@Cade delete\` and I'll ask you.`,
  });
  return null;
}

// The requirement's task that hasn't been deleted, if any: the one it links
// to, or, if storing that link failed, the one that links to it.
export async function liveTaskOf(env, channel, ts, requirement) {
  const linked = requirement.task;
  if (linked && (await getTask(env, linked.channel, linked.ts))) return linked;
  const latest = await latestTaskFrom(env, { channel, threadTs: ts });
  return latest && !latest.deleted ? latest : null;
}

// Whether the requirement or incident a task was tracked from is still
// there: stored, and its root message not deleted in Slack. Returns
// { alive, requirement }, with the requirement if it is stored.
async function sourceState(env, source) {
  const requirement = await loadRequirement(env, source.channel, source.threadTs);
  if (!requirement) return { alive: false };
  try {
    const { messages } = await callSlack(env, "conversations.replies", {
      channel: source.channel,
      ts: source.threadTs,
      limit: 1,
    });
    // A root deleted by hand that has replies stays as a tombstone.
    return { alive: messages?.[0]?.subtype !== "tombstone", requirement };
  } catch (error) {
    if (GONE.test(error.message)) return { alive: false, requirement };
    throw error;
  }
}

// Deletes a task from its own thread: one with no requirement, or whose
// requirement is gone. A requirement that is still stored but whose message
// was deleted by hand is marked deleted too.
async function deleteTaskOnly(env, channel, ts, user) {
  const task = await getTaskIncludingDeleted(env, channel, ts);
  if (!task) return;
  if (task.source) {
    const { alive, requirement } = await sourceState(env, task.source);
    if (alive) return;
    if (requirement) {
      await markRequirementDeleted(env, task.source.channel, task.source.threadTs);
      await refreshSummary(env, task.source.channel);
    }
  }
  await deleteTask(env, channel, ts, user);
}

async function deleteTask(env, channel, ts, user) {
  const task = await getTaskIncludingDeleted(env, channel, ts);
  if (!task) return;

  await deleteReplies(env, channel, ts);
  // A task already marked deleted is in the sheet as Deleted.
  if (!task.deleted) await syncTask(env, channel, ts, task, { deleted: true });
  // Deleting a message also removes its pin.
  await deleteMessage(env, channel, ts);
  if (!task.deleted) await markTaskDeleted(env, channel, ts);
  await refreshSummary(env, channel);
  console.log("Task deleted", { ts, user });
}

async function deleteRequirement(env, channel, ts, user) {
  const requirement = await loadRequirement(env, channel, ts);
  if (!requirement) return;
  // Its tasks first, even if one was tracked after the question was asked:
  // the one it links to and the one that links to it, which differ only if
  // storing the link failed. Either may be a task whose deletion failed
  // after it was marked deleted.
  const source = { channel, threadTs: ts };
  const tasks = [requirement.task, await latestTaskFrom(env, source)].filter(
    (task, i, all) => task && all.findIndex((other) => other?.channel === task.channel && other?.ts === task.ts) === i,
  );
  for (const task of tasks) await deleteTask(env, task.channel, task.ts, user);
  await markUnpostedTasksDeleted(env, source);

  await deleteReplies(env, channel, ts);
  await deleteMessage(env, channel, ts);
  await markRequirementDeleted(env, channel, ts);
  await refreshSummary(env, channel);
  console.log("Requirement deleted", { ts, user });
}

// Deletes a single message, if Cade posted it, and says how it went.
async function deleteOne(env, channel, ts, user) {
  try {
    await callSlack(env, "chat.delete", { channel, ts });
  } catch (error) {
    if (NOT_OURS.test(error.message)) return "I can only remove my own messages, so that one stays.";
    if (!GONE.test(error.message)) throw error;
  }
  console.log("Message removed", { ts, user });
  return "Done, that message is gone.";
}

// Deletes Cade's replies in a thread that is neither a task nor a
// requirement, and its root if Cade posted it, and says how it went.
async function deleteThread(env, channel, ts, user) {
  await deleteReplies(env, channel, ts);
  let mine = true;
  await callSlack(env, "chat.delete", { channel, ts }).catch((error) => {
    if (NOT_OURS.test(error.message)) mine = false;
    else if (!GONE.test(error.message)) throw error;
  });
  console.log("Thread cleared", { ts, user });
  return mine ? "Done, that message and my replies are gone." : "Done, my replies are gone. The message itself isn't mine, so it stays.";
}

// Deletes from the task card menu's More panel (see menu.js), whose button
// has already asked, as `@Cade delete` would: a task its requirement or
// incident still holds is removed from there instead. Returns what to tell
// whoever clicked.
export async function deleteFromMenu(env, channel, ts, user) {
  const task = await getTask(env, channel, ts);
  if (!task) return NOT_A_TASK;
  if (task.source && (await sourceState(env, task.source)).alive) return belongsToRequirement(task);
  await deleteTaskOnly(env, channel, ts, user);
  return "Done, the task and my replies in its thread are gone.";
}

// Deletes from the requirement card menu's Delete panel (see menu.js), whose
// button has already asked, as `@Cade delete` in its thread would: with its
// task, if one was tracked. Returns what to tell whoever clicked.
export async function deleteRequirementFromMenu(env, channel, ts, user) {
  const requirement = await loadRequirement(env, channel, ts);
  if (!requirement) return NOT_A_REQUIREMENT;
  const noun = requirement.incident ? "incident" : "requirement";
  const task = await liveTaskOf(env, channel, ts, requirement);
  await deleteRequirement(env, channel, ts, user);
  return task ? `Done, the ${noun}, its task and my replies in both threads are gone.` : `Done, the ${noun} and my replies in its thread are gone.`;
}

function belongsToRequirement(task) {
  const noun = task.source.incident ? "incident" : "requirement";
  const thread = task.source.link ? `<${task.source.link}|the ${noun} thread>` : `its ${noun} thread`;
  return `This task is tracked by ${thread}, so please remove it from there with \`@Cade remove\`.`;
}

// Deletes a root message, unless it is gone already.
async function deleteMessage(env, channel, ts) {
  await callSlack(env, "chat.delete", { channel, ts }).catch((error) => {
    if (!GONE.test(error.message)) throw error;
  });
}

// Deletes Cade's replies in a thread. They go first, so the root is not left
// behind if a delete fails midway.
async function deleteReplies(env, channel, ts) {
  const own = [];
  let cursor;
  do {
    let page;
    try {
      page = await callSlack(env, "conversations.replies", {
        channel,
        ts,
        limit: 200,
        cursor,
      });
    } catch (error) {
      // The thread is gone, replies and all.
      if (GONE.test(error.message)) return;
      throw error;
    }
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
