import { REFRESH_ACTION, TABS, publishHome } from "../home.js";

// The buttons on the Home tab (see home.js): one for each view of the open
// tasks, and Refresh, which draws the view it's on again.
export default {
  name: "home",
  actions: {
    [REFRESH_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id, payload.actions[0].value);
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
