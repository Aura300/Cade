import { channelsWithRole, findPair } from "../channels.js";
import { commands } from "./registry.js";

// Runs a parsed command and returns the reply to post in the message's thread,
// if any. `@Cade help`, a bare `@Cade` or an unknown command lists them all.
export async function dispatch(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  const scope = { channel: handler.channel, inThread: handler.inThread };
  if (!handler.run) {
    return `That one's a slash command: try \`${[handler.slashUsage].flat()[0]}\`${channelHint(slashScope(handler), context.env, command.channel)}.`;
  }
  return runHandler(handler, handler.run, [handler.usage].flat()[0], scope, command, context);
}

// Runs a `/cade name` slash command and returns the reply to show privately
// to the person who sent it, if any. `/cade`, `/cade help` or an unknown
// command lists them all.
export async function dispatchSlash(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  if (!handler.slash) return `For that one, send \`${[handler.usage].flat()[0]}\`${handler.inThread ? " in a task thread" : ""}.`;
  return runHandler(handler, handler.slash, [handler.slashUsage].flat()[0], slashScope(handler), command, context);
}

// Slash commands are never in a thread, and can work in other channels than
// the handler's `@Cade` form.
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
    return `Sorry, something went wrong with \`${handler.name}\`. Could you try again?`;
  }
}

// Handlers declare where they may run:
//   channel       the role, or list of roles, of the channels they work in
//                 ("tasks"; see CHANNEL_PAIRS)
//   slashChannel  the same for their `/cade` form, when it differs
//   inThread      whether they must be sent as a thread reply
function checkScope(scope, usage, command, env) {
  const channels = channelsFor(scope, env);
  const inThread = Boolean(command.threadTs) && command.threadTs !== command.ts;
  const allowed =
    (!channels.length || channels.includes(command.channel)) &&
    (!scope.inThread || inThread);
  if (allowed) return undefined;
  const where = scope.inThread ? " in a task thread" : "";
  return `That one works with \`${usage}\`${where}${channelHint(scope, env, command.channel)}.`;
}

function channelsFor(scope, env) {
  const roles = [scope.channel ?? []].flat();
  return roles.flatMap((role) => channelsWithRole(env, role));
}

// Names the channels to use instead. From a group's channel, only its own
// is named, since the others belong to another project.
function channelHint(scope, env, from) {
  const pair = findPair(env, from);
  const channels = pair
    ? [scope.channel ?? []].flat().map((role) => pair[role]).filter(Boolean)
    : channelsFor(scope, env);
  return channels.length ? ` in ${channels.map((id) => `<#${id}>`).join(" or ")}` : "";
}

// Help lists the commands by how they're sent: the slash commands, at the
// top of a channel; the `@Cade` messages, sent in a message's thread or a
// task's; the message shortcuts; and the admin commands, for tidying up.
function usage() {
  const all = [...new Set(Object.values(commands))];
  const handlers = all.filter((handler) => !handler.admin);
  const slash = handlers.filter((handler) => handler.slashUsage).flatMap((handler) => handler.slashUsage);
  const messages = (section) => handlers.filter((handler) => handler.section === section && handler.usage).flatMap((handler) => handler.usage);
  const admin = all.filter((handler) => handler.admin).flatMap((handler) => handler.slashUsage);
  const list = (forms) => forms.map((form) => `\`${form}\``).join(" · ");
  return [
    "Here's what I can do:",
    "*Slash commands*, at the top of a channel:",
    list(slash),
    "*Messages*, sent in a thread:",
    `• In a message's thread: ${list(messages("message"))}`,
    `• In a task's thread: ${list(messages("task"))}`,
    "*On any message*: ⋯ → More actions → New task, New incident or Move to existing.",
    `*Admin commands*, for tidying up: ${list(admin)}`,
    "Send `@Cade help` or `/cade help` any time to see this again.",
  ].join("\n");
}
