import { findPair, groupEnabled } from "../channels.js";
import { escapeSlack, linkedThread, respondLater } from "../slack.js";
import { writeSummary } from "../summary.js";
import { loadTask, saveTask } from "../tasks.js";

const NO_LINK =
  "Paste the link to the task: `/cade resync <link>`, with the link from Copy link on its message. Several links work too. Or `/cade resync summary` in a dev channel for its summary.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// `/cade resync <link> [<link> …]` redraws a task's card from what Cade has
// stored, and sends it to the Sheet and summary again, for a card that's
// out of date: one posted before a change to how cards look, such as the ⋯
// menu, or one a failed update left behind. Nothing changes but the
// message, so no one is notified, and only whoever sent it sees the reply.
//
// `/cade resync summary` in a dev channel rewrites its summary canvas in
// full, with its title, and makes it read-only again (see summary.js), as
// for one someone edited, or one a failed update left behind.
export default {
  name: "resync",
  description: "Redraw a task's card from what Cade has stored, quietly",
  slashUsage: ["/cade resync <link>", "/cade resync summary"],
  admin: true,
  section: "task",
  slashChannel: [],
  async slash(command, context) {
    if (/^summary$/i.test(command.text.trim())) return resyncSummary(command, context);
    const links = [...command.text.matchAll(LINK)].map((match) => linkedThread(match[1] ?? match[2])).filter(Boolean);
    if (!links.length) return NO_LINK;
    // Redrawing can take longer than Slack waits for a slash command's
    // answer, so the reply follows.
    context.waitUntil(
      (async () => {
        const lines = [];
        for (const link of links) lines.push(await resync(context.env, link));
        await respondLater(command.responseUrl, { text: lines.join("\n") });
      })(),
    );
  },
};

// Rewrites the summary of the dev channel the command was sent in.
function resyncSummary(command, context) {
  const group = findPair(context.env, command.channel);
  if (!group) return "Send `/cade resync summary` in a group's dev channel, for its summary.";
  if (!groupEnabled(context.env, group.tasks, "canvas", "CANVAS")) return "The summary canvas is off for this group; turn it on with `canvas` in cade.config.json.";
  // Writing the canvas can take longer than Slack waits for a slash
  // command's answer, so the answer follows.
  context.waitUntil(
    (async () => {
      let text;
      try {
        text = await writeSummary(context.env, group.tasks, { full: true, user: command.user });
      } catch (error) {
        console.error("Could not resync the summary", { channel: group.tasks, error: error.message });
        text = "Sorry, I couldn't update the summary just now. Could you try again?";
      }
      await respondLater(command.responseUrl, { text });
    })(),
  );
}

// Redraws what the link points at and says how it went.
async function resync(env, { channel, ts }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  await saveTask(env, channel, ts, task);
  const title = escapeSlack(task.title);
  return `Resynced the task ${task.link ? `<${task.link}|${title}>` : `*${title}*`}.`;
}
