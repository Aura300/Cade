import { readChanges, today } from "../ai.js";
import { suggesting } from "../intents.js";
import { callSlack, dismiss, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
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

// Reads the message for `about` (the task its thread is about; see
// threadTask in suggest.js) and, if it asks for changes, asks whoever wrote
// it. Throws if the model fails, for suggest.js to fall back on phrases.
export async function suggestWithAi(env, message, { target, task }) {
  const handOffs = suggesting(env, "hand-offs", message.channel) || suggesting(env, "started", message.channel);
  const allowed = {
    roles: handOffs ? Object.keys(ROLES) : [],
    status: suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel),
    details: suggesting(env, "details", message.channel) && !task.incident,
  };
  const changes = await readChanges(env, { message, task, today: today(env), allowed });
  if (changes) await askToChange(env, message, { target, task }, changes);
}

// Asks whoever wrote `message`, privately, whether to make `changes` (as
// changes.js takes them) to `task`, with a summary and Accept, Edit… and
// Reject. Shared with suggestions by phrases (see suggest.js).
export async function askToChange(env, message, { target, task }, changes) {
  const question = "Should I update the task? From your message:";
  // Whoever the message mentioned was notified by it, so applying it
  // doesn't notify them again (see applyChanges).
  const value = JSON.stringify({ ...target, changes, from: task.status, told: message.mentions });
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

// What would change, a line each: people added and removed per role,
// marked (Add) and (Remove), then the status, priority and due date, from what they are now.
// Mentions in a message only one person sees notify no one.
export function summary(task, changes) {
  const lines = Object.entries(changes.people ?? {}).map(([role, { add, remove }]) => {
    const parts = [add.length && `${mentions(add)} (Add)`, remove.length && `${mentions(remove)} (Remove)`].filter(Boolean);
    return `*${ROLES[role]}s:* ${parts.join(" · ")}`;
  });
  if (changes.status) lines.push(`*Status:* ${STATUSES[task.status]} → ${STATUSES[changes.status]}`);
  if (changes.priority) lines.push(`*Priority:* ${PRIORITIES[task.priority] ?? ""} ${task.priority} → ${PRIORITIES[changes.priority]} ${changes.priority}`);
  if ("dueDate" in changes) lines.push(`*Due:* ${task.dueDate || "none"} → ${changes.dueDate || "none"}`);
  return lines.join("\n");
}

export default {
  actions: {
    [ACCEPT_ACTION]: async (payload, context) => {
      const { changes, from, told, ...target } = JSON.parse(payload.actions[0].value);
      context.waitUntil(
        (async () => {
          // The private message goes first, so the click shows at once:
          // saving takes a few seconds, and may fail.
          await dismiss(payload.response_url);
          await applyChanges(context.env, target, changes, payload.user.id, { from, told });
        })(),
      );
    },
    // Opening a form must happen within Slack's three seconds of the click.
    [EDIT_ACTION]: async (payload, { env }) => {
      const { channel, ts, changes, told } = JSON.parse(payload.actions[0].value);
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: editForm({ channel, ts }, task, { changes, told, responseUrl: payload.response_url }),
      });
    },
    [REJECT_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};
