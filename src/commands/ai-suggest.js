import { readChanges, today } from "../ai.js";
import { suggesting } from "../intents.js";
import { findDetails } from "../requirements.js";
import { CLOSE_ALL, callSlack, dismiss, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, formatDueDate, loadTask, pickerDate } from "../tasks.js";
import { applyChanges } from "./changes.js";
import { statusOption } from "./status.js";

const CONFIRM_ACTION = "ai-suggest:confirm";
const CHANGE_ACTION = "ai-suggest:change";
const SKIP_ACTION = "ai-suggest:skip";
const CHANGE_VIEW = "ai-suggest:form";

// Suggestions read with AI (see ai.js): what a message in a task's thread
// asks to change, which can be several people in several roles, the status,
// and, on the team's own tasks, the priority and due date. Whoever wrote it
// is asked, privately, with what was read: Confirm applies it, Change… opens
// a form filled in with it, with every role's people, the status, priority
// and due date to correct, and Not now drops it. Applying it tells the
// thread as any change does (see changes.js).
//
// In the thread of a requirement or incident tracked as a task, only
// developers and the status are read, and only whoever wrote the message
// can be added, since the client may be among those it mentions.

// Reads the message for `about` (the task its thread is about; see
// threadTask in suggest.js) and, if it asks for changes, asks whoever wrote
// it. Throws if the model fails, for suggest.js to fall back on phrases.
export async function suggestWithAi(env, message, { target, of, task, place }) {
  const external = place === "external";
  const handOffs = suggesting(env, "hand-offs") || suggesting(env, "started");
  const allowed = {
    roles: handOffs ? (external ? ["developer"] : Object.keys(ROLES)) : [],
    fromMentions: !external,
    status: suggesting(env, "started") || suggesting(env, "progress"),
    details: !external && suggesting(env, "details") && (await findDetails(env, target.channel, target.ts))?.kind === "task",
  };
  const changes = await readChanges(env, { message, task, today: today(env), allowed });
  if (!changes) return;

  const question = `Should I update the task${of}? From your message:`;
  const value = JSON.stringify({ ...target, changes, from: task.status, roles: allowed.roles, details: allowed.details });
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
          { type: "button", action_id: CONFIRM_ACTION, text: plainText("Confirm"), style: "primary", value },
          { type: "button", action_id: CHANGE_ACTION, text: plainText("Change…"), value },
          { type: "button", action_id: SKIP_ACTION, text: plainText("Not now"), value: "{}" },
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
    [CONFIRM_ACTION]: async (payload, context) => {
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
    [CHANGE_ACTION]: async (payload, { env }) => {
      const suggestion = JSON.parse(payload.actions[0].value);
      const task = await loadTask(env, suggestion.channel, suggestion.ts);
      if (!task) return;
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: changeForm(task, { ...suggestion, responseUrl: payload.response_url }),
      });
    },
    [SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
  views: { [CHANGE_VIEW]: saveForm },
};

// The form behind Change…: each role's people, the status and, where the
// team owns them, the priority and due date, filled in with the task as it
// would be with the suggestion applied.
function changeForm(task, { channel, ts, changes, roles, details, responseUrl }) {
  const peopleAfter = (role) => {
    const { add = [], remove = [] } = changes.people?.[role] ?? {};
    return [...task.people[role].filter((id) => !remove.includes(id)), ...add];
  };
  const priorityOption = (name) => ({ text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true }, value: name });
  const priority = changes.priority ?? task.priority;
  const dueDate = "dueDate" in changes ? changes.dueDate : task.dueDate;
  return {
    type: "modal",
    callback_id: CHANGE_VIEW,
    private_metadata: JSON.stringify({ channel, ts, roles, details, responseUrl }),
    title: plainText("Update task"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      ...roles.map((role) => {
        const chosen = peopleAfter(role);
        return {
          type: "input",
          block_id: role,
          // Saving a role with no one clears it.
          optional: true,
          label: plainText(`${ROLES[role]}s`),
          element: {
            type: "multi_users_select",
            action_id: "value",
            placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
            ...(chosen.length && { initial_users: chosen }),
          },
        };
      }),
      {
        type: "input",
        block_id: "status",
        label: plainText("Status"),
        element: {
          type: "static_select",
          action_id: "value",
          options: Object.keys(STATUSES).map(statusOption),
          initial_option: statusOption(changes.status ?? task.status),
        },
      },
      ...(details
        ? [
            {
              type: "input",
              block_id: "priority",
              label: plainText("Priority"),
              element: {
                type: "static_select",
                action_id: "value",
                options: Object.keys(PRIORITIES).map(priorityOption),
                ...(PRIORITIES[priority] && { initial_option: priorityOption(priority) }),
              },
            },
            {
              type: "input",
              block_id: "due_date",
              // Saving with no date removes it.
              optional: true,
              label: plainText("Due date"),
              element: {
                type: "datepicker",
                action_id: "value",
                placeholder: plainText("Select a date"),
                ...(pickerDate(dueDate) && { initial_date: pickerDate(dueDate) }),
              },
            },
          ]
        : []),
    ],
  };
}

// Saves the form as the changes from the task as it is now, as Confirm
// would, and removes the private question.
function saveForm(payload, context) {
  const { channel, ts, roles, details, responseUrl } = JSON.parse(payload.view.private_metadata);
  const { values } = payload.view.state;
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (task) {
        const changes = { people: {}, status: values.status.value.selected_option.value };
        for (const role of roles) {
          const chosen = values[role]?.value.selected_users ?? [];
          changes.people[role] = {
            add: chosen.filter((id) => !task.people[role].includes(id)),
            remove: task.people[role].filter((id) => !chosen.includes(id)),
          };
        }
        if (details) {
          changes.priority = values.priority.value.selected_option?.value ?? task.priority;
          changes.dueDate = formatDueDate(values.due_date.value.selected_date);
        }
        await applyChanges(env, { channel, ts }, changes, payload.user.id);
      }
      await dismiss(responseUrl);
    })(),
  );
  return CLOSE_ALL;
}
