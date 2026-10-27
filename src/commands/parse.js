// Most commands are messages that start by mentioning the bot, such as
// `@Cade assign @person`, because Slack does not allow custom slash commands
// in threads and most commands are sent from a task's thread. Commands that
// start something new, such as `/cade task`, also work as slash commands.
const MESSAGE_PREFIX = /^\s*<@([A-Z0-9]+)>(?:\s+(.*))?$/s;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Returns the command in a message, or null if the message is not one:
//   name       the command name, lowercased ("" when none was given)
//   text       everything after the name
//   mentions   users mentioned in `text`, excluding the bot
//   user, channel, ts, threadTs
export function parseMessage(event, botUserId) {
  // Edits, deletions and bot posts (including Cade's own) are not commands.
  if (event.subtype || event.bot_id) return null;

  const match = MESSAGE_PREFIX.exec(event.text ?? "");
  if (!match || match[1] !== botUserId) return null;

  const input = (match[2] ?? "").trim();
  const [name = ""] = input.split(/\s+/, 1);
  const text = input.slice(name.length).trim();
  const mentions = [
    ...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id)),
  ].filter((id) => id !== botUserId);

  return {
    name: name.toLowerCase(),
    text,
    mentions,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
  };
}

// Returns the command in a `/cade name …` request, in the same shape as
// parseMessage, plus the triggerId for opening a modal and the responseUrl
// for answering later, privately, after Slack's three seconds. Slash
// commands are never in a thread.
export function parseSlashCommand(form) {
  const input = (form.get("text") ?? "").trim();
  const [name = ""] = input.split(/\s+/, 1);
  return {
    name: name.toLowerCase(),
    text: input.slice(name.length).trim(),
    mentions: [],
    user: form.get("user_id"),
    channel: form.get("channel_id"),
    triggerId: form.get("trigger_id"),
    responseUrl: form.get("response_url"),
  };
}
