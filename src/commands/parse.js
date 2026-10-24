// Slack does not allow custom slash commands in threads, and it intercepts
// messages that start with "/", so commands can also be sent as plain
// messages: `luma assign @person` or `@Luma assign @person`.
const MESSAGE_PREFIX = /^\s*(?:<@([A-Z0-9]+)>|\/?luma)(?:\s+(.*))?$/is;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Both parsers return the same command shape, so handlers do not need to know
// whether they were invoked as `/luma <name>` or as a message:
//   source     "slash" or "message"
//   name       the command name, lowercased ("" when none was given)
//   text       everything after the name
//   mentions   users mentioned in `text`, excluding the bot
//   addressed  whether the bot was @mentioned (always true for slash commands)
//   user, channel, ts, threadTs, triggerId
export function parseSlashCommand(payload) {
  return build(payload.text ?? "", {
    source: "slash",
    addressed: true,
    user: payload.user_id,
    channel: payload.channel_id,
    triggerId: payload.trigger_id,
  });
}

export function parseMessage(event, botUserId) {
  // Edits, deletions and bot posts (including Luma's own) are not commands.
  if (event.subtype || event.bot_id) return null;

  const match = MESSAGE_PREFIX.exec(event.text ?? "");
  if (!match) return null;
  const [, mentionedUser, input = ""] = match;
  if (mentionedUser && mentionedUser !== botUserId) return null;

  return build(
    input,
    {
      source: "message",
      addressed: Boolean(mentionedUser),
      user: event.user,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
    },
    botUserId,
  );
}

function build(input, fields, botUserId) {
  const trimmed = input.trim();
  const [name = ""] = trimmed.split(/\s+/, 1);
  const text = trimmed.slice(name.length).trim();
  const mentions = [
    ...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id)),
  ].filter((id) => id !== botUserId);
  return { ...fields, name: name.toLowerCase(), text, mentions };
}
