import { getTaskIncludingDeleted, markTaskDeleted } from "../db.js";
import { callSlack, escapeSlack, linkedMessage, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, refreshHomes, refreshSummary, syncTask } from "../tasks.js";

const DELETE_ACTION = "delete:confirm";
const CANCEL_ACTION = "delete:cancel";

// Slack's errors for a message or thread that is already gone.
const GONE = /message_not_found|thread_not_found/;
// Slack's error for a message the bot didn't post, which it can't delete.
const NOT_OURS = /cant_delete_message/;

const NO_LINK = "Paste the link to what to remove: `/cade remove <link>`, with the link from Copy link on its message.";

// What the buttons say is deleted, by kind.
const NOUNS = { task: "task", message: "message", thread: "messages" };

// `/cade remove <link>` (or `/cade delete <link>`), from anywhere, asks
// whoever sent it, privately, about whatever the link points at: a task, a
// reply, or any other message's thread. The question has Delete and
// Cancel buttons, and Delete opens a second "are you sure" dialog.
// Confirming deletes it:
//   a task           its card and Cade's replies in its thread
//   a reply          the reply, if Cade posted it
//   another message  Cade's replies in its thread, and the message too if
//                    Cade posted it
// The question is replaced by how it went.
//
// The task's messages go before it is marked deleted, so if a deletion fails
// midway it can be tried again. A task marked deleted whose messages are
// still there, left by a deletion that failed before that order, can be
// removed again too.
//
// A bot token can only delete the bot's own messages, so people's replies
// stay behind under Slack's "This message was deleted" placeholder.
export default {
  name: "delete",
  aliases: ["remove"],
  description: "Delete a task and Cade's messages in its thread, or what a link points at",
  slashUsage: "/cade remove <link>",
  admin: true,
  section: "task",
  slashChannel: [],
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
      const request = JSON.parse(payload.actions[0].value);
      context.waitUntil(
        (async () => {
          const result = await REMOVERS[request.kind](context.env, request.channel, request.ts, payload.user.id);
          await respondLater(payload.response_url, { replace_original: true, text: result ?? "Done, it's gone." });
        })(),
      );
    },
    [CANCEL_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

const REMOVERS = {
  task: deleteTask,
  message: deleteOne,
  thread: deleteThread,
};

// The question for `/cade remove <link>`, about what the link points at.
async function askLinked(env, link, user) {
  const asked = { channel: link.channel, ts: link.ts, user };
  if (link.threadTs) {
    return confirmation(asked, "message", "should I remove that message?", "", "I'll delete that message, if I posted it.");
  }
  if (await getTaskIncludingDeleted(env, link.channel, link.ts)) return askTask(env, asked);
  return confirmation(
    asked,
    "thread",
    "should I remove my messages in that thread?",
    "",
    "I'll delete my replies in that thread, and the message itself if I posted it.",
  );
}

async function askTask(env, asked) {
  const task = await getTaskIncludingDeleted(env, asked.channel, asked.ts);
  if (!task) return NOT_A_TASK;
  return confirmation(asked, "task", `should I delete the task *${escapeSlack(task.title)}*?`, task.title);
}

// The Delete and Cancel buttons, under `question`, which is put to whoever
// asked, `asked.user`, about the message at `asked.channel`/`asked.ts`.
// `title` is what's deleted; `deleted` says what goes instead, for messages
// that aren't tasks.
function confirmation(asked, kind, question, title, deleted) {
  const text = `<@${asked.user}>, ${question} There's no undo.`;
  deleted ??= `I'll delete "${title}" and my replies in its thread.`;
  const value = JSON.stringify({ kind, channel: asked.channel, ts: asked.ts });
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
  if (!task.deleted) await refreshHomes(env, task, null);
  console.log("Task deleted", { ts, user });
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

// Deletes Cade's replies in a thread that isn't a task's, and its root if Cade posted it, and says how it went.
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
