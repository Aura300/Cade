import { channelsWithRole, findPair } from "../channels.js";
import { commands } from "./registry.js";

// Runs a parsed command and returns the reply to post in the message's thread,
// if any. `@LUMA help`, a bare `@LUMA` or an unknown command lists them all.
export async function dispatch(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  const scope = { channel: handler.channel, inThread: handler.inThread };
  if (!handler.run) {
    return `Use \`${handler.slashUsage}\`${channelHint(slashScope(handler), context.env, command.channel)}.`;
  }
  return runHandler(handler, handler.run, handler.usage, scope, command, context);
}

// Runs a `/luma name` slash command and returns the reply to show privately
// to the person who sent it, if any. `/luma`, `/luma help` or an unknown
// command lists them all.
export async function dispatchSlash(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  if (!handler.slash) return `Use \`${handler.usage}\`${handler.inThread ? " in a task thread" : ""}.`;
  return runHandler(handler, handler.slash, handler.slashUsage, slashScope(handler), command, context);
}

// Slash commands are never in a thread, and can work in other channels than
// the handler's `@LUMA` form.
function slashScope(handler) {
  return { channel: handler.slashChannel ?? handler.channel };
}

async function runHandler(handler, run, usage, scope, command, context) {
  console.log("Command", {
    name: handler.name,
    channel: command.channel,
    user: command.user,
  });
  try {
    const problem = checkScope(scope, usage, command, context.env);
    if (problem) return problem;
    return await run(command, context);
  } catch (error) {
    console.error("Command failed", { name: handler.name, error: error.message });
    return `Sorry, \`${handler.name}\` failed. Please try again.`;
  }
}

// Handlers declare where they may run:
//   channel       the role, or list of roles, of the channels they work in
//                 ("external", "tasks"; see CHANNEL_PAIRS)
//   slashChannel  the same for their `/luma` form, when it differs
//   inThread      whether they must be sent as a thread reply
function checkScope(scope, usage, command, env) {
  const channels = channelsFor(scope, env);
  const inThread = Boolean(command.threadTs) && command.threadTs !== command.ts;
  const allowed =
    (!channels.length || channels.includes(command.channel)) &&
    (!scope.inThread || inThread);
  if (allowed) return undefined;

  const where = scope.inThread ? " in a task thread" : "";
  return `Use \`${usage}\`${where}${channelHint(scope, env, command.channel)}.`;
}

function channelsFor(scope, env) {
  const roles = [scope.channel ?? []].flat();
  return roles.flatMap((role) => channelsWithRole(env, role));
}

// Names the channels to use instead. From a channel in a pair, only that
// pair's channels are named, since the others belong to another project.
function channelHint(scope, env, from) {
  const pair = findPair(env, from);
  const channels = pair
    ? [scope.channel ?? []].flat().map((role) => pair[role]).filter(Boolean)
    : channelsFor(scope, env);
  return channels.length ? ` in ${channels.map((id) => `<#${id}>`).join(" or ")}` : "";
}

function usage() {
  const lines = [...new Set(Object.values(commands))].flatMap(({ usage, slashUsage, description }) =>
    [slashUsage, usage].filter(Boolean).map((form) => `• \`${form}\` – ${description}`),
  );
  return `Available commands:\n${lines.join("\n")}\n• \`@LUMA help\` – Show this list`;
}
