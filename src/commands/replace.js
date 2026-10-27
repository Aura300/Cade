import { getTask } from "../db.js";
import { callSlack, linkedMessage, mrkdwn, respondLater } from "../slack.js";

const USAGE =
  'Paste the link to my message, then what it should say: `/cade replace <link> "New wording"`, with the link from Copy link on the message.';

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold a bare address.
const FIRST_LINK = /<https?:\/\/[^>]+>|https?:\/\/\S+/;

// `/cade replace <link> <text>` changes what one of Cade's messages says to
// `text`, from anywhere, as `/cade remove <link>` removes one: a reply in a
// thread or a message of its own, with the link from Copy link on it. The
// text may be in quotes, and takes Slack formatting, mentions and links as
// any message does. Slack only lets Cade change its own messages, and an
// edited message notifies no one. A task's card isn't changed this way, as
// it's drawn from the task on every change: its ⋯ → Edit changes the task.
// Only whoever sent it sees the answer.
export default {
  name: "replace",
  description: "Change what one of Cade's messages says, from anywhere, with its link",
  slashUsage: "/cade replace <link> <text>",
  admin: true,
  section: "task",
  slashChannel: [],
  async slash(command, context) {
    const link = linkedMessage(command.text);
    const text = newText(command.text);
    if (!link || !text) return USAGE;
    context.waitUntil(
      (async () => respondLater(command.responseUrl, { text: await replace(context.env, link, text, command.user) }))(),
    );
  },
};

// The text after the link, without quotes around it.
function newText(input) {
  const rest = input.replace(FIRST_LINK, "").trim();
  const quoted = /^["“](.*)["”]$/s.exec(rest);
  return (quoted ? quoted[1] : rest).trim();
}

// Changes the message at `link` to say `text`, and says how it went.
async function replace(env, { channel, ts }, text, user) {
  if (await getTask(env, channel, ts)) {
    return "That's a task's card, which I redraw from the task on every change. Change the task with ⋯ → Edit on the card instead.";
  }
  try {
    // The blocks are replaced too, or Slack would keep showing the old ones,
    // and so are any attachments, such as a card's coloured strip.
    await callSlack(env, "chat.update", { channel, ts, text, blocks: [{ type: "section", text: mrkdwn(text) }], attachments: [] });
  } catch (error) {
    if (/cant_update_message|edit_window_closed/.test(error.message)) return "I can only change my own messages, so that one stays as it is.";
    if (/message_not_found|channel_not_found/.test(error.message)) return "I couldn't find that message. Use Copy link on it, in a channel I'm in.";
    throw error;
  }
  console.log("Message replaced", { ts, user });
  return "Done, the message says that now.";
}
