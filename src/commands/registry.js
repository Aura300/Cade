import aiSuggest from "./ai-suggest.js";
import assign from "./assign.js";
import remove from "./delete.js";
import replace from "./replace.js";
import edit from "./edit.js";
import { due, priority } from "./details.js";
import brief from "./brief.js";
import debrief from "./debrief.js";
import menu from "./menu.js";
import move from "./move.js";
import pr from "./pr.js";
import release from "./release.js";
import resync from "./resync.js";
import standup from "./standup.js";
import status from "./status.js";
import suggest from "./suggest.js";
import summary from "./summary.js";
import syncup from "./syncup.js";
import tasks from "./tasks.js";
import track, { incident } from "./track.js";
import unassign from "./unassign.js";

// To add a command, create a handler module and list it here. A handler is:
//   {
//     name, description,
//     usage?: how to send it as an `@Cade name` message,
//     slashUsage?: how to send it as `/cade name`,
//     section: where help lists it: "start", "thread" or "work",
//     aliases?: other names that run the same handler,
//     channel?: "tasks", or [] for any channel: the channels in
//               CHANNEL_PAIRS it works in,
//     slashChannel?: like `channel`, for `/cade name` when it differs,
//     inThread?: true if it must be run from a thread reply,
//     run?(command, context) -> reply | undefined, for `@Cade name`,
//     slash?(command, context) -> reply | undefined, for `/cade name`; it has
//               the command's triggerId, so it can open a modal straight away,
//     views?: { [callbackId]: handler(payload, context) } for its modals,
//     actions?: { [actionId]: handler(payload, context) } for its buttons,
//     shortcuts?: { [callbackId]: handler(payload, context) } for its items
//               in a message's ⋯ → More actions (see slack/manifest.json),
//     reactions?: handler(event, context) for each emoji added to a message
//               in a channel Cade is in; it decides which ones it acts on,
//     intents?: plain messages it acts on, made with intent() (see intents.js),
//   }
// A reply is plain text or a message body such as { text, blocks }.
// See parse.js for the shape of `command`.
const handlers = [track, incident, assign, unassign, status, priority, due, pr, release, remove, replace, move, resync, tasks, standup, syncup, summary, brief, debrief];

export const commands = Object.fromEntries(
  handlers.flatMap((handler) =>
    [handler.name, ...(handler.aliases ?? [])].map((name) => [name, handler]),
  ),
);

// The task card's menu, its Edit form, and suggestions from people's own words only answer
// clicks and messages, so they aren't commands.
const interactive = [...handlers, menu, edit, suggest, aiSuggest];

export const views = Object.assign(
  {},
  ...interactive.map((handler) => handler.views ?? {}),
);

export const intents = interactive.flatMap((handler) => handler.intents ?? []);

export const shortcuts = Object.assign(
  {},
  ...interactive.map((handler) => handler.shortcuts ?? {}),
);

export const reactions = interactive.flatMap((handler) => (handler.reactions ? [handler.reactions] : []));

export const actions = Object.assign(
  {},
  ...interactive.map((handler) => handler.actions ?? {}),
);
