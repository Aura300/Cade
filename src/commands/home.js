import { findProject } from "../channels.js";
import { setHomeProject } from "../db.js";
import { ALL_PROJECTS, CLAIM_ACTION, PROJECT_ACTION, REFRESH_ACTION, TABS, publishHome } from "../home.js";
import { callSlack } from "../slack.js";
import { loadTask } from "../tasks.js";
import { changeTask } from "./changes.js";

// Slack's limit for a channel's topic.
const TOPIC_LIMIT = 250;
const TOPIC_LINK = /<https:\/\/slack\.com\/app_redirect[^>]*>/;

// `/cade home` in a project's channel puts a link to Cade's Home tab in the
// channel's topic, after the topic that's there; running it again swaps the
// link, so it is only ever there once.
//
// The buttons on the Home tab (see home.js): one for each view of the open
// tasks, the project picker, Refresh, which draws the view it's on again, and Assign to me, on
// the Unassigned view.
export default {
  name: "home",
  description: "Put a link to the Home tab (all tasks, my tasks) in this channel's topic",
  slashUsage: "/cade home",
  section: "work",
  slashChannel: "channel",
  async slash(command, context) {
    const { env } = context;
    const { channel } = command;
    if (!findProject(env, channel)) return "Send `/cade home` in a project's channel.";
    const { team_id: team, bot_id: bot } = await callSlack(env, "auth.test", {});
    const { bot: app } = await callSlack(env, "bots.info", { bot });
    const link = `<https://slack.com/app_redirect?app=${app.app_id}&team=${team}&tab=home|Cade tasks>`;
    const { channel: info } = await callSlack(env, "conversations.info", { channel });
    const topic = (info.topic?.value ?? "")
      .replace(TOPIC_LINK, "")
      .replace(/\s*\|\s*$/, "")
      .trim();
    const next = topic ? `${topic} | ${link}` : link;
    if (next.length > TOPIC_LIMIT) return "The channel's topic is too long to add the link; shorten it and try again.";
    await callSlack(env, "conversations.setTopic", { channel, topic: next });
    return "Added a link to the Home tab to the channel's topic.";
  },
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
