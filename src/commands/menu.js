import { CLOSE_ALL, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, TASK_MENU_ACTION, loadTask } from "../tasks.js";
import { teamForm } from "./assign.js";
import { deleteFromMenu } from "./delete.js";
import { detachFromMenu } from "./detach.js";
import { dueForm, priorityForm } from "./details.js";
import { pullRequestForm } from "./pr.js";
import { releaseForm } from "./release.js";
import { statusForm } from "./status.js";

const MORE_VIEW = "task:more";
const MORE_ACTIONS = {
  priority: "task:more:priority",
  due: "task:more:due",
  detach: "task:more:detach",
  delete: "task:more:delete",
};

// The ⋯ menu on a task's card (see taskMenu in tasks.js) does what `@Cade
// assign`, `status`, `pr`, `release`, `priority`, `due`, `detach` and
// `delete` do, without a command message in the task's thread. Each choice
// opens a form; saving it posts who changed what in the thread, as the
// record, and the card updates. Anything Cade can't do is said only to
// whoever chose it.
//
// More opens a panel of buttons for what's rarely needed: the priority and
// due date, on a task with no requirement (which owns them otherwise), and
// Detach or Delete, which Slack asks about before they're clicked.
const FORMS = {
  assign: (env, origin, task) => teamForm(origin, task),
  status: (env, origin, task) => statusForm(origin, task),
  prs: (env, origin, task) => pullRequestForm(origin, task),
  release: async (env, origin) => {
    const { view, problem } = await releaseForm(env, origin);
    return view ?? problem;
  },
  more: (env, origin, task) => morePanel(origin, task),
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
    // The priority and due date forms open on top of the panel; saving one
    // closes both (see CLOSE_ALL).
    [MORE_ACTIONS.priority]: (payload, { env }) => pushForm(payload, env, priorityForm),
    [MORE_ACTIONS.due]: (payload, { env }) => pushForm(payload, env, dueForm),
    [MORE_ACTIONS.detach]: (payload, context) => fromPanel(payload, context, detachFromMenu),
    [MORE_ACTIONS.delete]: (payload, context) => fromPanel(payload, context, deleteFromMenu),
  },
  // The panel has no Save button, but Slack wants each modal answered.
  views: { [MORE_VIEW]: () => CLOSE_ALL },
};

function morePanel(origin, task) {
  const value = JSON.stringify(origin);
  const button = (choice, text, extra) => ({ type: "button", action_id: MORE_ACTIONS[choice], text: plainText(text), value, ...extra });
  const confirm = (title, text, yes) => ({
    confirm: { title: plainText(title), text: plainText(text), confirm: plainText(yes), deny: plainText("Cancel"), style: "danger" },
  });
  const noun = task.source?.incident ? "incident" : "requirement";
  const buttons = [
    ...(task.source ? [] : [button("priority", "Change priority…"), button("due", "Change due date…")]),
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
    title: plainText("More"),
    close: plainText("Close"),
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(task.title)}*`) },
      { type: "actions", elements: buttons },
      ...(task.source
        ? [{ type: "context", elements: [mrkdwn(`Its priority and due date come from its ${noun}, and are changed there.`)] }]
        : []),
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
