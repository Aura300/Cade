import { publishSummary } from "../summary.js";
import { respondLater } from "../slack.js";

// `/cade summary` in a dev channel puts a table of the group's open tasks,
// incidents too, in the channel's canvas, most urgent first.
// It goes in the canvas Slack shows in the channel's header, made if there
// is none, replacing what it held. Cade then keeps it up to date as things
// change (see summary.js). Sending it again rewrites the table.
export default {
  name: "summary",
  description: "Keep a table of what's open in this channel's canvas, most urgent first",
  slashUsage: "/cade summary",
  section: "work",
  channel: "tasks",
  async slash(command, context) {
    // Reading the tasks and writing the canvas can take longer than Slack
    // waits for a slash command's answer, so the answer follows.
    context.waitUntil(
      (async () => {
        let text;
        try {
          text = await publishSummary(context.env, command.channel, command.user);
        } catch (error) {
          console.error("Could not publish the summary", { channel: command.channel, error: error.message });
          text = "Sorry, I couldn't update this channel's canvas. Could you try again?";
        }
        await respondLater(command.responseUrl, { text });
      })(),
    );
  },
};
