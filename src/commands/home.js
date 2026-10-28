import { REFRESH_ACTION, publishHome } from "../home.js";

// The Refresh button on the Home tab (see home.js) draws it again.
export default {
  name: "home",
  actions: {
    [REFRESH_ACTION]: async (payload, { env }) => {
      await publishHome(env, payload.user.id);
    },
  },
};
