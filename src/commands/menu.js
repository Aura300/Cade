import { callSlack } from "../slack.js";
import { NOT_A_TASK, TASK_MENU_ACTION, loadTask } from "../tasks.js";
import { openTeamForm } from "./assign.js";
import { openDueForm, openPriorityForm } from "./details.js";
import { openStatusForm } from "./status.js";

// The ⋯ menu on a task's card (see taskMenu in tasks.js) does what `@Cade
// assign`, `status`, `priority` and `due` do, without a command message in
// the task's thread. Each choice opens a form; saving it posts who changed
// what in the thread, as the record, and the card updates. Anything Cade
// can't do is said only to whoever chose it.
const FORMS = {
  assign: openTeamForm,
  status: openStatusForm,
  priority: openPriorityForm,
  due: openDueForm,
};

export default {
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    // The menu is on the task's root message.
    [TASK_MENU_ACTION]: async (payload, { env }) => {
      const channel = payload.channel.id;
      const ts = payload.message.ts;
      const open = FORMS[payload.actions[0].selected_option.value];
      const task = open && (await loadTask(env, channel, ts));
      if (!task) {
        await callSlack(env, "chat.postEphemeral", { channel, user: payload.user.id, text: NOT_A_TASK });
        return;
      }
      await open(env, payload.trigger_id, { channel, ts, task });
    },
  },
};
