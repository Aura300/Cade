import { findIntent, intentsOn, plainMessage } from "../intents.js";
import { callSlack, linkedMessage, respondLater } from "../slack.js";

const USAGE =
  "Paste the link to the message: `/cade retry <link>`, with the link from Copy link on a message in a task's thread.";

// `/cade retry <link>` runs the suggestion flow again for a message in a
// task's thread, as if it had just been posted: for one Cade missed, such as
// when it was down, or one whose question was dismissed or has gone. It asks
// whoever wrote the message, privately, as it would have, and only the
// suggestions turned on for the channel apply (see `taskStatusChangeDetection`). Nothing
// changes until they answer. Whoever sent it sees how it went.
export default {
  name: "retry",
  description: "Ask again what a message in a task's thread suggests, with its link",
  slashUsage: "/cade retry <link>",
  section: "work",
  slashChannel: [],
  async slash(command, context) {
    const link = linkedMessage(command.text);
    if (!link) return USAGE;
    context.waitUntil(
      (async () => respondLater(command.responseUrl, { text: await retry(context.env, context, link, command.user) }))(),
    );
  },
};

// Reads the message at `link` and hands it to the intent that matches it,
// as a new message would be. Says how it went.
async function retry(env, context, { channel, ts }, user) {
  let found;
  try {
    // Given a reply's ts, this returns just that reply.
    const { messages = [] } = await callSlack(env, "conversations.replies", { channel, ts, limit: 1 });
    found = messages.find((message) => message.ts === ts);
  } catch (error) {
    if (!/message_not_found|channel_not_found|thread_not_found/.test(error.message)) throw error;
  }
  if (!found) return "I couldn't find that message. Use Copy link on it, in a channel I'm in.";

  const { user_id: botUserId } = await callSlack(env, "auth.test", {});
  const message = plainMessage({ ...found, channel }, botUserId);
  if (!message) return "That's not a message I act on: edits, deletions and bot posts are left alone.";
  if (!message.inThread) return "That's not in a thread. Retry works on a message in a task's thread.";

  // Imported when needed, as the registry lists this command.
  const { intents } = await import("./registry.js");
  const meant = findIntent(intentsOn(env, intents, channel), message);
  if (!meant) return "Nothing to suggest for that message, or the suggestions that would apply are turned off here.";

  await meant.handle(message, context);
  // Whether it found anything to ask is up to the intent, which may not.
  const who = message.user === user ? "you" : `<@${message.user}>`;
  return `Done, I went through that message again. If there's anything to suggest, ${who} will see a private question in the thread.`;
}
