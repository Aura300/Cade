import { channelsWithRole, findPair } from "../channels.js";
import { commands } from "./registry.js";

// Runs a parsed command and returns the reply to post in the message's thread,
// if any. `@Cade help`, a bare `@Cade` or an unknown command lists them all.
export async function dispatch(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  const scope = { channel: handler.channel, inThread: handler.inThread };
  if (!handler.run) {
    return `That one's a slash command: try \`${handler.slashUsage}\`${channelHint(slashScope(handler), context.env, command.channel)}.`;
  }
  return runHandler(handler, handler.run, handler.usage, scope, command, context);
}

// Runs a `/cade name` slash command and returns the reply to show privately
// to the person who sent it, if any. `/cade`, `/cade help` or an unknown
// command lists them all.
export async function dispatchSlash(command, context) {
  const handler = commands[command.name];
  if (!handler) return usage();
  if (!handler.slash) return `For that one, send \`${handler.usage}\`${handler.inThread ? " in a task thread" : ""}.`;
  return runHandler(handler, handler.slash, handler.slashUsage, slashScope(handler), command, context);
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
//                 ("external", "tasks"; see CHANNEL_PAIRS)
//   slashChannel  the same for their `/cade` form, when it differs
//   inThread      whether they must be sent as a thread reply
function checkScope(scope, usage, command, env) {
  const channels = channelsFor(scope, env);
  const inThread = Boolean(command.threadTs) && command.threadTs !== command.ts;
  const allowed =
    (!channels.length || channels.includes(command.channel)) &&
    (!scope.inThread || inThread);
  if (allowed) return undefined;

  const missing = missingRoles(scope, env, command.channel);
  if (missing) return missing;
  const where = scope.inThread ? " in a task thread" : "";
  return `That one works with \`${usage}\`${where}${channelHint(scope, env, command.channel)}.`;
}

function channelsFor(scope, env) {
  const roles = [scope.channel ?? []].flat();
  return roles.flatMap((role) => channelsWithRole(env, role));
}

// From a channel in a pair that has none of the channels the command works
// in, such as a group with only a tasks channel, says what to add.
function missingRoles(scope, env, from) {
  const pair = findPair(env, from);
  const roles = [scope.channel ?? []].flat();
  if (!pair || !roles.length || roles.some((role) => pair[role])) return undefined;
  const names = roles.map((role) => `\`${role}\``).join(" or ");
  return `This group has no ${names} channel, so that one isn't available here. Add one to its pair in \`CHANNEL_PAIRS\` to use it.`;
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

// Help is three lines, one per section, listing each command's forms. In a
// task thread, saying it in your own words comes first: Cade offers to
// assign people or link PRs from what you write, and the commands are there
// for anything else.
const SECTIONS = [
  ["start", "Start"],
  ["thread", "In a task thread"],
  ["work", "Your work"],
];

function usage() {
  const handlers = [...new Set(Object.values(commands))];
  const lines = SECTIONS.map(([section, title]) => {
    const forms = handlers
      .filter((handler) => handler.section === section)
      .flatMap(({ slashUsage, usage }) => [slashUsage, usage].filter(Boolean))
      .map((form) => `\`${form}\``)
      .join(" · ");
    const words =
      section === "thread"
        ? "Just talk to me: write \"@person please look into this\" or paste a PR link, and I'll offer to assign or link it. Or: "
        : "";
    return `*${title}:* ${words}${forms}`;
  });
  return `Here's what I can do:\n${lines.join("\n")}\nSend \`@Cade help\` or \`/cade help\` any time to see this again.`;
}
