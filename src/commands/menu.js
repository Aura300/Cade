import { callSlack } from "../slack.js";
import { NOT_A_TASK, TASK_MENU_ACTION, loadTask, saveTask } from "../tasks.js";
import { editForm } from "./edit.js";
import { archiveTask } from "./archive.js";
import { releaseForm } from "./release.js";

// The ⋯ menu on a task's card (see taskMenu in tasks.js) has up to four
// choices, without a command message in the task's thread:
//   Edit     one form for the people, status, priority and due date (not on
//            an incident, whose are fixed) and pull requests (see edit.js);
//            saving it posts who changed what in the thread, as the record,
//            and the card updates.
//   Release  while the task has PRs not sent yet: the form `@Cade release`
//            opens, to send some of them for approval, a partial release.
//   Refresh  redraws the card from the stored task, and its Sheet row and
//            summary, as `/cade resync` does: nothing is posted, so no one
//            is notified.
//   Archive  archives the task, as `@Cade archive` does (see archive.js),
//            telling its thread who did.
// Anything Cade can't do is said only to whoever chose it. Cards posted
// before had other choices; they open Edit, which has everything.
const FORMS = {
  edit: (env, origin, task) => editForm(origin, task),
  release: async (env, origin) => {
    const { view, problem } = await releaseForm(env, origin);
    return view ?? problem;
  },
};

export default {
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    // The menu is on the task's root message.
    [TASK_MENU_ACTION]: async (payload, context) => {
      const { env } = context;
      const origin = { channel: payload.channel.id, ts: payload.message.ts };
      const choice = payload.actions[0].selected_option.value;
      const task = await loadTask(env, origin.channel, origin.ts);
      if (choice === "refresh" && task) {
        context.waitUntil(saveTask(env, origin.channel, origin.ts, task));
        return;
      }
      if (choice === "archive" && task) {
        context.waitUntil(
          (async () => {
            const text = await archiveTask(env, origin.channel, origin.ts, payload.user.id);
            if (text) await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.ts, text });
          })(),
        );
        return;
      }
      const form = FORMS[choice] ?? FORMS.edit;
      const view = task ? await form(env, origin, task) : NOT_A_TASK;
      if (typeof view === "string") {
        await callSlack(env, "chat.postEphemeral", { channel: origin.channel, user: payload.user.id, text: view });
        return;
      }
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
    },
  },
};
