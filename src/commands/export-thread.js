import { escapeSlack, linkedThread, respondLater } from "../slack.js";
import { exportThread } from "../export.js";
import { loadTask } from "../tasks.js";

const NO_LINK =
  "Paste the link to the task: `/cade export <link>`, with the link from Copy link on its message. Several links work too.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// `/cade export <link> [<link> …]` writes a task's thread as text in its
// page under the Export tab of the project's Google Doc, as the card's ⋯ →
// Export thread does (see export.js), and replies with where, only to
// whoever sent it. Sending it again writes the same page over.
export default {
  name: "export",
  description: "Write a task's thread as text in the project's Google Doc, with its link",
  slashUsage: "/cade export <link>",
  section: "work",
  slashChannel: [],
  async slash(command, context) {
    const links = [...command.text.matchAll(LINK)].map((match) => linkedThread(match[1] ?? match[2])).filter(Boolean);
    if (!links.length) return NO_LINK;
    // Reading a thread and writing the Doc can take longer than Slack waits
    // for a slash command's answer, so the reply follows.
    context.waitUntil(
      (async () => {
        const lines = [];
        for (const link of links) lines.push(await exportLink(context.env, link));
        await respondLater(command.responseUrl, { text: lines.join("\n") });
      })(),
    );
  },
};

// Exports what the link points at and says how it went.
async function exportLink(env, { channel, ts }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  const title = escapeSlack(task.title);
  try {
    const url = await exportThread(env, channel, ts, task);
    return url ? `Exported *${title}*: <${url}|in the Doc>.` : `*${title}* is in a project with no Google Doc to export to.`;
  } catch (error) {
    console.warn("Could not export the thread", { channel, ts, error: error.message });
    return `I couldn't export *${title}*.`;
  }
}
