import { readChanges, today } from "../ai.js";
import { suggesting } from "../intents.js";
import { findDetails } from "../requirements.js";
import { callSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, loadTask } from "../tasks.js";
import { applyChanges } from "./changes.js";
import { editForm } from "./edit.js";

// The action IDs are kept from when the buttons read Confirm, Change… and
// Not now, so suggestions already posted still work.
const ACCEPT_ACTION = "ai-suggest:confirm";
const EDIT_ACTION = "ai-suggest:change";
const REJECT_ACTION = "ai-suggest:skip";

// Suggestions read with AI (see ai.js): what a message in a task's thread
// asks to change, which can be several people in several roles, the status,
// and, on the team's own tasks, the priority and due date. Whoever wrote it
// is asked, privately, with a summary of what was read: Accept applies it,
// Edit… opens the task's Edit form filled in with it (see edit.js), and
// Reject drops it. Applying it tells the thread as any change does (see
// changes.js).
//
// In the thread of a requirement or incident tracked as a task, only
// developers and the status are read, and only whoever wrote the message
// can be added, since the client may be among those it mentions.

// Reads the message for `about` (the task its thread is about; see
// threadTask in suggest.js) and, if it asks for changes, asks whoever wrote
// it. Throws if the model fails, for suggest.js to fall back on phrases.
export async function suggestWithAi(env, message, { target, of, task, place }) {
  const external = place === "external";
  const handOffs = suggesting(env, "hand-offs", message.channel) || suggesting(env, "started", message.channel);
  const allowed = {
    roles: handOffs ? (external ? ["developer"] : Object.keys(ROLES)) : [],
    fromMentions: !external,
    status: suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel),
    details: !external && suggesting(env, "details", message.channel) && (await findDetails(env, target.channel, target.ts))?.kind === "task",
  };
  const changes = await readChanges(env, { message, task, today: today(env), allowed });
  if (!changes) return;

  const question = `Should I update the task${of}? From your message:`;
  const value = JSON.stringify({ ...target, changes, from: task.status });
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      { type: "section", text: mrkdwn(summary(task, changes)) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: ACCEPT_ACTION, text: plainText("Accept"), style: "primary", value },
          { type: "button", action_id: EDIT_ACTION, text: plainText("Edit…"), value },
          { type: "button", action_id: REJECT_ACTION, text: plainText("Reject"), value: "{}" },
        ],
      },
    ],
  });
}

// What would change, a line each: people added (+) and removed (−) per
// role, then the status, priority and due date, from what they are now.
// Mentions in a message only one person sees notify no one.
export function summary(task, changes) {
  const lines = Object.entries(changes.people ?? {}).map(([role, { add, remove }]) => {
    const parts = [add.length && `+ ${mentions(add)}`, remove.length && `− ${mentions(remove)}`].filter(Boolean);
    return `*${ROLES[role]}s:* ${parts.join("   ")}`;
  });
  if (changes.status) lines.push(`*Status:* ${STATUSES[task.status]} → ${STATUSES[changes.status]}`);
  if (changes.priority) lines.push(`*Priority:* ${PRIORITIES[task.priority] ?? ""} ${task.priority} → ${PRIORITIES[changes.priority]} ${changes.priority}`);
  if ("dueDate" in changes) lines.push(`*Due:* ${task.dueDate || "none"} → ${changes.dueDate || "none"}`);
  return lines.join("\n");
}

export default {
  actions: {
    [ACCEPT_ACTION]: async (payload, context) => {
      const { changes, from, ...target } = JSON.parse(payload.actions[0].value);
      context.waitUntil(
        (async () => {
          await applyChanges(context.env, target, changes, payload.user.id, { from });
          // An ephemeral message can only be changed through its response_url.
          await respondLater(payload.response_url, { delete_original: true });
        })(),
      );
    },
    // Opening a form must happen within Slack's three seconds of the click.
    [EDIT_ACTION]: async (payload, { env }) => {
      const { channel, ts, changes } = JSON.parse(payload.actions[0].value);
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: await editForm(env, { channel, ts }, task, { changes, responseUrl: payload.response_url }),
      });
    },
    [REJECT_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};
