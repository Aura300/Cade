// Most commands are messages that start by mentioning the bot, such as
// `@LUMA assign @person`, because Slack does not allow custom slash commands
// in threads and most commands are sent from a task's thread. Commands that
// start something new, such as `/luma track`, also work as slash commands.
// In a direct message with Luma there is no one else to address, so the
// whole message is the command and the mention is optional.
const MESSAGE_PREFIX = /^\s*<@([A-Z0-9]+)>(?:\s+(.*))?$/s;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Returns the command in a message, or null if the message is not one:
//   name       the command name, lowercased ("" when none was given)
//   text       everything after the name
//   mentions   users mentioned in `text`, excluding the bot
//   direct     true in a direct message with Luma
//   user, channel, ts, threadTs
export function parseMessage(event, botUserId) {
  // Edits, deletions and bot posts (including Luma's own) are not commands.
  if (event.subtype || event.bot_id) return null;

  const direct = event.channel_type === "im";
  const match = MESSAGE_PREFIX.exec(event.text ?? "");
  const mentioned = match?.[1] === botUserId;
  if (!mentioned && !direct) return null;

  const input = (mentioned ? (match[2] ?? "") : event.text ?? "").trim();
  const [name = ""] = input.split(/\s+/, 1);
  const text = input.slice(name.length).trim();
  const mentions = [
    ...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id)),
  ].filter((id) => id !== botUserId);

  return {
    name: name.toLowerCase(),
    text,
    mentions,
    direct,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
  };
}

// Returns the command in a `/luma name …` request, in the same shape as
// parseMessage, plus the triggerId for opening a modal. Slash commands are
// never in a thread.
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
  };
}
