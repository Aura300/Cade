import assign from "./assign.js";
import remove from "./delete.js";
import detach from "./detach.js";
import { due, priority } from "./details.js";
import exec from "./exec.js";
import move from "./move.js";
import pr from "./pr.js";
import release from "./release.js";
import requirement, { incident } from "./requirement.js";
import standup from "./standup.js";
import status from "./status.js";
import summary from "./summary.js";
import tasks from "./tasks.js";
import track from "./track.js";
import unassign from "./unassign.js";

// To add a command, create a handler module and list it here. A handler is:
//   {
//     name, description,
//     usage?: how to send it as an `@Cade name` message,
//     slashUsage?: how to send it as `/cade name`,
//     section: where help lists it: "start", "thread" or "work",
//     aliases?: other names that run the same handler,
//     channel?: "external", "tasks" or both as a list: the channels in
//               CHANNEL_PAIRS it works in,
//     slashChannel?: like `channel`, for `/cade name` when it differs,
//     inThread?: true if it must be run from a thread reply,
//     run?(command, context) -> reply | undefined, for `@Cade name`,
//     slash?(command, context) -> reply | undefined, for `/cade name`; it has
//               the command's triggerId, so it can open a modal straight away,
//     views?: { [callbackId]: handler(payload, context) } for its modals,
//     actions?: { [actionId]: handler(payload, context) } for its buttons,
//     intents?: plain messages it acts on, made with intent() (see intents.js),
//   }
// A reply is plain text or a message body such as { text, blocks }.
// See parse.js for the shape of `command`.
const handlers = [requirement, incident, track, assign, unassign, status, priority, due, pr, release, detach, remove, move, tasks, standup, summary, exec];

export const commands = Object.fromEntries(
  handlers.flatMap((handler) =>
    [handler.name, ...(handler.aliases ?? [])].map((name) => [name, handler]),
  ),
);

export const views = Object.assign(
  {},
  ...handlers.map((handler) => handler.views ?? {}),
);

export const intents = handlers.flatMap((handler) => handler.intents ?? []);

export const actions = Object.assign(
  {},
  ...handlers.map((handler) => handler.actions ?? {}),
);
