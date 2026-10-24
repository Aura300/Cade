import { commands } from "./registry.js";

// Runs a parsed command and returns the reply to send back to its author, if
// any. The caller decides how to deliver it: an ephemeral response for slash
// commands, a thread reply for messages.
export async function dispatch(command, context) {
  if (command.name === "help") return usage();
  const handler = commands[command.name];
  if (!handler) {
    // Messages that merely start with "luma" are usually conversation, so
    // only answer when Luma was addressed directly.
    return command.addressed ? usage() : undefined;
  }

  console.log("Command", {
    name: handler.name,
    source: command.source,
    channel: command.channel,
    user: command.user,
  });
  try {
    const problem = checkScope(handler, command, context.env);
    if (problem) return problem;
    return await handler.run(command, context);
  } catch (error) {
    console.error("Command failed", { name: handler.name, error: error.message });
    return `Sorry, \`${handler.name}\` failed. Please try again.`;
  }
}

// Handlers declare where they may run:
//   sources   which invocations are accepted ("slash", "message")
//   channel   the env setting holding the only channel ID they work in
//   inThread  whether they must be sent as a thread reply
function checkScope(handler, command, env) {
  const channel = handler.channel && env[handler.channel];
  if (handler.channel && !channel) {
    throw new Error(`${handler.channel} is not configured`);
  }

  const inThread = Boolean(command.threadTs) && command.threadTs !== command.ts;
  const allowed =
    handler.sources.includes(command.source) &&
    (!channel || command.channel === channel) &&
    (!handler.inThread || inThread);
  if (allowed) return undefined;

  const where = handler.inThread ? " in a task thread" : "";
  const channelHint = channel ? ` in <#${channel}>` : "";
  return `Use \`${handler.usage}\`${where}${channelHint}.`;
}

function usage() {
  const lines = [...new Set(Object.values(commands))].map(
    ({ usage, description }) => `• \`${usage}\` – ${description}`,
  );
  return `Available commands:\n${lines.join("\n")}\n• \`/luma help\` – Show this list`;
}
