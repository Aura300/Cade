import { escapeSlack, linkedThread, respondLater } from "../slack.js";
import { loadTask, saveTask } from "../tasks.js";

const NO_LINK =
  "Paste the link to the task: `/cade resync <link>`, with the link from Copy link on its message. Several links work too.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// `/cade resync <link> [<link> …]` redraws a task's card from what Cade has
// stored, and sends it to the Sheet and summary again, for a card that's
// out of date: one posted before a change to how cards look, such as the ⋯
// menu, or one a failed update left behind. Nothing changes but the
// message, so no one is notified, and only whoever sent it sees the reply.
export default {
  name: "resync",
  description: "Redraw a task's card from what Cade has stored, quietly",
  slashUsage: "/cade resync <link>",
  section: "thread",
  slashChannel: [],
  async slash(command, context) {
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

// Redraws what the link points at and says how it went.
async function resync(env, { channel, ts }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  await saveTask(env, channel, ts, task);
  const title = escapeSlack(task.title);
  return `Resynced the task ${task.link ? `<${task.link}|${title}>` : `*${title}*`}.`;
}
