import { setHomeProject } from "../db.js";
import { ALL_PROJECTS, CLAIM_ACTION, PROJECT_ACTION, REFRESH_ACTION, TABS, publishHome } from "../home.js";
import { loadTask } from "../tasks.js";
import { changeTask } from "./changes.js";

// The buttons on the Home tab (see home.js): one for each view of the open
// tasks, the project picker, Refresh, which draws the view it's on again, and Assign to me, on
// the Unassigned view.
export default {
  name: "home",
  actions: {
    [REFRESH_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id, payload.actions[0].value);
    },
    // The choice is kept for next time, and the tab drawn again, on the
    // view it was on (the view's private metadata).
    [PROJECT_ACTION]: async (payload, { env }) => {
      const { value } = payload.actions[0].selected_option;
      await setHomeProject(env, payload.user.id, value === ALL_PROJECTS ? null : value);
      await publishHome(env, payload.user.id, payload.view?.private_metadata);
    },
    // The button's id ends with the task's channel and thread. Someone may
    // have taken the task since the tab was drawn, and then it's left
    // alone. The card shows the new owner, so nothing is posted.
    [CLAIM_ACTION]: async (payload, { env }) => {
      const user = payload.user.id;
      const [channel, ts] = payload.actions[0].action_id.split(":").slice(2);
      const task = await loadTask(env, channel, ts);
      if (task && !Object.values(task.people).some((ids) => ids.length)) {
        await changeTask(env, { channel, ts }, { people: { owner: { add: [user] } } }, user);
      }
      await publishHome(env, user, "unassigned");
    },
    ...Object.fromEntries(
      Object.entries(TABS).map(([tab, { action }]) => [
        action,
        async (payload, { env }) => {
          await publishHome(env, payload.user.id, tab);
        },
      ]),
    ),
  },
};
