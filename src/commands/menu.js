import { CLOSE_ALL, callSlack, escapeSlack, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, TASK_MENU_ACTION, loadTask } from "../tasks.js";
import { deleteFromMenu } from "./delete.js";
import { editForm } from "./edit.js";
import { releaseForm } from "./release.js";

const DELETE_VIEW = "task:more";
const DELETE_ACTION = "task:more:delete";

// The ⋯ menu on a task's card (see taskMenu in tasks.js) has up to three
// choices, without a command message in the task's thread:
//   Edit     one form for the people, status, priority and due date (not on
//            an incident, whose are fixed) and pull requests (see edit.js);
//            saving it posts who changed what in the thread, as the record,
//            and the card updates.
//   Release  while the task has PRs not sent yet: the form `@Cade release`
//            opens, to send some of them for approval, a partial release.
//   Delete   a panel with Delete, which Slack asks about before it's
//            clicked.
// Anything Cade can't do is said only to whoever chose it. Cards posted
// before had other choices; they open Edit, which has everything.
const FORMS = {
  edit: (env, origin, task) => editForm(origin, task),
  release: async (env, origin) => {
    const { view, problem } = await releaseForm(env, origin);
    return view ?? problem;
  },
  delete: (env, origin, task) => deletePanel(origin, task),
};

export default {
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    // The menu is on the task's root message.
    [TASK_MENU_ACTION]: async (payload, { env }) => {
      const origin = { channel: payload.channel.id, ts: payload.message.ts };
      const form = FORMS[payload.actions[0].selected_option.value] ?? FORMS.edit;
      const task = await loadTask(env, origin.channel, origin.ts);
      const view = task ? await form(env, origin, task) : NOT_A_TASK;
      if (typeof view === "string") {
        await callSlack(env, "chat.postEphemeral", { channel: origin.channel, user: payload.user.id, text: view });
        return;
      }
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
    },
    [DELETE_ACTION]: (payload, context) => deleteFromPanel(payload, context),
  },
  // The panel has no Save button, but Slack wants each modal answered.
  views: { [DELETE_VIEW]: () => CLOSE_ALL },
};

// The panel with Delete, which Slack asks about before it's clicked.
function deletePanel(origin, task) {
  return {
    type: "modal",
    callback_id: DELETE_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Delete"),
    close: plainText("Close"),
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(task.title)}*`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: DELETE_ACTION,
            text: plainText("Delete task…"),
            value: JSON.stringify(origin),
            confirm: {
              title: plainText("Delete task?"),
              text: plainText("I'll delete the task and my replies in its thread. There's no undo."),
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

// Deleting can take longer than Slack waits for a click's answer, so the
// panel says how it went once it's done.
function deleteFromPanel(payload, context) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const viewId = payload.view.id;
  context.waitUntil(
    (async () => {
      await showOnPanel(context.env, viewId, "Working on it…");
      let text;
      try {
        text = await deleteFromMenu(context.env, channel, ts, payload.user.id);
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
      callback_id: DELETE_VIEW,
      title: plainText("Delete"),
      close: plainText("Close"),
      blocks: [{ type: "section", text: mrkdwn(text) }],
    },
  });
}
