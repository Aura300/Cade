import { NOT_A_REQUIREMENT, REQUIREMENT_MENU_ACTION, loadRequirement } from "../requirements.js";
import { CLOSE_ALL, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, TASK_MENU_ACTION, loadTask } from "../tasks.js";
import { teamForm } from "./assign.js";
import { deleteFromMenu, deleteRequirementFromMenu } from "./delete.js";
import { detachFromMenu } from "./detach.js";
import { dueForm, priorityForm } from "./details.js";
import { editForm } from "./edit.js";
import { pullRequestForm } from "./pr.js";
import { releaseForm } from "./release.js";
import { statusForm } from "./status.js";
import { trackRequirementForm } from "./track.js";

const MORE_VIEW = "task:more";
const MORE_ACTIONS = {
  priority: "task:more:priority",
  due: "task:more:due",
  detach: "task:more:detach",
  delete: "task:more:delete",
};
const DELETE_REQUIREMENT_ACTION = "requirement:menu:delete";

// The ⋯ menu on a task's card (see taskMenu in tasks.js) has two choices,
// without a command message in the task's thread:
//   Edit    one form for the people, status, priority and due date (on the
//           team's own tasks) and pull requests (see edit.js); saving it
//           posts who changed what in the thread, as the record, and the
//           card updates.
//   Delete  a panel with Delete and, for a task tracked from a requirement
//           or incident, Detach, which Slack asks about before they're
//           clicked.
// Anything Cade can't do is said only to whoever chose it. Sending PRs for
// approval is `@Cade release`.
//
// Cards posted before had a choice for each form, and More, a panel with
// the priority and due date too; they're still answered, until the card is
// redrawn.
//
// The ⋯ menu on a requirement's or incident's card in the client channel
// (see requirementMenu in requirements.js) has up to three:
//   Edit        the task's Edit form, showing only the priority and due
//               date, which the client sets and its task follows (see
//               edit.js); not on an incident, whose are fixed.
//   Track task  the form `@Cade track` opens, until a task is tracked.
//   Delete      a panel with Delete, which Slack asks about before it's
//               clicked, deleting its task too, as `@Cade delete` would.
// Cards posted before the menu get it when they are next redrawn.
const FORMS = {
  edit: (env, origin, task) => editForm(env, origin, task),
  delete: (env, origin, task) => morePanel(origin, task, { title: "Delete", details: false }),
  assign: (env, origin, task) => teamForm(origin, task),
  status: (env, origin, task) => statusForm(origin, task),
  prs: (env, origin, task) => pullRequestForm(origin, task),
  release: async (env, origin) => {
    const { view, problem } = await releaseForm(env, origin);
    return view ?? problem;
  },
  more: (env, origin, task) => morePanel(origin, task),
};

const REQUIREMENT_FORMS = {
  edit: (env, origin, requirement) => editForm(env, origin, requirement),
  track: (env, origin, requirement) => trackRequirementForm(origin, requirement),
  delete: (env, origin, requirement) => requirementPanel(origin, requirement),
};

export default {
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    // The menu is on the task's root message.
    [TASK_MENU_ACTION]: async (payload, { env }) => {
      const origin = { channel: payload.channel.id, ts: payload.message.ts };
      const form = FORMS[payload.actions[0].selected_option.value];
      const task = form && (await loadTask(env, origin.channel, origin.ts));
      const view = task ? await form(env, origin, task) : NOT_A_TASK;
      if (typeof view === "string") {
        await callSlack(env, "chat.postEphemeral", { channel: origin.channel, user: payload.user.id, text: view });
        return;
      }
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
    },
    [REQUIREMENT_MENU_ACTION]: async (payload, { env }) => {
      const origin = { channel: payload.channel.id, ts: payload.message.ts };
      const form = REQUIREMENT_FORMS[payload.actions[0].selected_option.value];
      const requirement = form && (await loadRequirement(env, origin.channel, origin.ts));
      const view = requirement ? await form(env, origin, requirement) : NOT_A_REQUIREMENT;
      if (typeof view === "string") {
        await callSlack(env, "chat.postEphemeral", { channel: origin.channel, user: payload.user.id, text: view });
        return;
      }
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
    },
    // The priority and due date forms open on top of the panel; saving one
    // closes both (see CLOSE_ALL).
    [MORE_ACTIONS.priority]: (payload, { env }) => pushForm(payload, env, priorityForm),
    [MORE_ACTIONS.due]: (payload, { env }) => pushForm(payload, env, dueForm),
    [MORE_ACTIONS.detach]: (payload, context) => fromPanel(payload, context, detachFromMenu),
    [MORE_ACTIONS.delete]: (payload, context) => fromPanel(payload, context, deleteFromMenu),
    [DELETE_REQUIREMENT_ACTION]: (payload, context) => fromPanel(payload, context, deleteRequirementFromMenu),
  },
  // The panel has no Save button, but Slack wants each modal answered.
  views: { [MORE_VIEW]: () => CLOSE_ALL },
};

// The panel of rarely needed buttons: the priority and due date (`details`),
// on a task with no requirement (which owns them otherwise), Detach and
// Delete.
function morePanel(origin, task, { title = "More", details = true } = {}) {
  const value = JSON.stringify(origin);
  const button = (choice, text, extra) => ({ type: "button", action_id: MORE_ACTIONS[choice], text: plainText(text), value, ...extra });
  const confirm = (title, text, yes) => ({
    confirm: { title: plainText(title), text: plainText(text), confirm: plainText(yes), deny: plainText("Cancel"), style: "danger" },
  });
  const noun = task.source?.incident ? "incident" : "requirement";
  const buttons = [
    ...(task.source || !details ? [] : [button("priority", "Change priority…"), button("due", "Change due date…")]),
    ...(task.source
      ? [
          button(
            "detach",
            `Detach from ${noun}…`,
            confirm(
              "Detach task?",
              `The task stops following its ${noun}, whose message will say where the work went. Both threads are told. There's no undo.`,
              "Detach",
            ),
          ),
        ]
      : []),
    button(
      "delete",
      "Delete task…",
      confirm("Delete task?", "I'll delete the task and my replies in its thread. There's no undo.", "Delete"),
    ),
  ];
  return {
    type: "modal",
    callback_id: MORE_VIEW,
    private_metadata: value,
    title: plainText(title),
    close: plainText("Close"),
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(task.title)}*`) },
      { type: "actions", elements: buttons },
      ...(task.source && details
        ? [{ type: "context", elements: [mrkdwn(`Its priority and due date come from its ${noun}, and are changed there.`)] }]
        : []),
    ],
  };
}

// The requirement card's Delete panel. A tracked requirement takes its task
// with it, which the question says.
function requirementPanel(origin, requirement) {
  const noun = requirement.incident ? "incident" : "requirement";
  const also = requirement.task ? ` and its task "${requirement.task.title}"` : "";
  const deleted = `I'll delete the ${noun}${also}, and my replies in ${requirement.task ? "both threads" : "its thread"}. There's no undo.`;
  return {
    type: "modal",
    callback_id: MORE_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Delete"),
    close: plainText("Close"),
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(requirement.title)}*`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: DELETE_REQUIREMENT_ACTION,
            text: plainText(`Delete ${noun}…`),
            value: JSON.stringify(origin),
            confirm: {
              title: plainText(`Delete ${noun}?`),
              text: plainText(deleted.slice(0, 300)),
              confirm: plainText("Delete"),
              deny: plainText("Cancel"),
              style: "danger",
            },
          },
        ],
      },
    ],
  };
}

async function pushForm(payload, env, form) {
  const origin = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, origin.channel, origin.ts);
  if (!task) return showOnPanel(env, payload.view.id, NOT_A_TASK);
  await callSlack(env, "views.push", { trigger_id: payload.trigger_id, view: form(origin, task) });
}

// Detach and Delete can take longer than Slack waits for a click's answer,
// so the panel says how it went once they're done.
function fromPanel(payload, context, act) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const viewId = payload.view.id;
  context.waitUntil(
    (async () => {
      await showOnPanel(context.env, viewId, "Working on it…");
      let text;
      try {
        text = await act(context.env, channel, ts, payload.user.id);
      } catch (error) {
        console.error("Task menu action failed", { ts, error: error.message });
        text = "Sorry, something went wrong. Could you try again?";
      }
      await showOnPanel(context.env, viewId, text);
    })(),
  );
}

function showOnPanel(env, viewId, text) {
  return callSlack(env, "views.update", {
    view_id: viewId,
    view: {
      type: "modal",
      callback_id: MORE_VIEW,
      title: plainText("More"),
      close: plainText("Close"),
      blocks: [{ type: "section", text: mrkdwn(text) }],
    },
  });
}
