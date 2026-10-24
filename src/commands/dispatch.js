import { channelsWithRole } from "../channels.js";
import { commands } from "./registry.js";

// Runs a parsed command and returns the reply to post in the message's thread,
// if any. `@LUMA help`, a bare `@LUMA` or an unknown command lists them all.
export async function dispatch(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  if (!handler.run) return `Use \`${handler.slashUsage}\`${channelHint(handler, context.env)}.`;
  return runHandler(handler, handler.run, handler.usage, command, context);
}

// Runs a `/luma name` slash command and returns the reply to show privately
// to the person who sent it, if any. `/luma`, `/luma help` or an unknown
// command lists them all.
export async function dispatchSlash(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  if (!handler.slash) return `Use \`${handler.usage}\`${handler.inThread ? " in a task thread" : ""}.`;
  return runHandler(handler, handler.slash, handler.slashUsage, command, context);
}

async function runHandler(handler, run, usage, command, context) {
  console.log("Command", {
    name: handler.name,
    channel: command.channel,
    user: command.user,
  });
  try {
    const problem = checkScope(handler, usage, command, context.env);
    if (problem) return problem;
    return await run(command, context);
  } catch (error) {
    console.error("Command failed", { name: handler.name, error: error.message });
    return `Sorry, \`${handler.name}\` failed. Please try again.`;
  }
}

// Handlers declare where they may run:
//   channel   the role, or list of roles, of the channels they work in
//             ("external", "tasks"; see CHANNEL_PAIRS)
//   inThread  whether they must be sent as a thread reply
function checkScope(handler, usage, command, env) {
  const channels = channelsFor(handler, env);
  const inThread = Boolean(command.threadTs) && command.threadTs !== command.ts;
  const allowed =
    (!channels.length || channels.includes(command.channel)) &&
    (!handler.inThread || inThread);
  if (allowed) return undefined;

  const where = handler.inThread ? " in a task thread" : "";
  return `Use \`${usage}\`${where}${channelHint(handler, env)}.`;
}

function channelsFor(handler, env) {
  const roles = [handler.channel ?? []].flat();
  return roles.flatMap((role) => channelsWithRole(env, role));
}

function channelHint(handler, env) {
  const channels = channelsFor(handler, env);
  return channels.length ? ` in ${channels.map((id) => `<#${id}>`).join(" or ")}` : "";
}

function usage() {
  const lines = [...new Set(Object.values(commands))].flatMap(({ usage, slashUsage, description }) =>
    [slashUsage, usage].filter(Boolean).map((form) => `• \`${form}\` – ${description}`),
  );
  return `Available commands:\n${lines.join("\n")}\n• \`@LUMA help\` – Show this list`;
}
