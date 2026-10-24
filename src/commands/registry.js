import assign from "./assign.js";
import remove from "./delete.js";
import status from "./status.js";
import track from "./track.js";
import unassign from "./unassign.js";

// To add a command, create a handler module and list it here. A handler is:
//   {
//     name, description, usage,
//     aliases?: other names that run the same handler,
//     sources: ["slash" | "message"],
//     channel?: env setting with the channel ID it is limited to,
//     inThread?: true if it must be run from a thread reply,
//     run(command, context) -> reply | undefined,
//     views?: { [callbackId]: handler(payload, context) } for its modals,
//     actions?: { [actionId]: handler(payload, context) } for its buttons,
//   }
// A reply is plain text or a message body such as { text, blocks }.
// See parse.js for the shape of `command`.
const handlers = [track, assign, unassign, status, remove];

export const commands = Object.fromEntries(
  handlers.flatMap((handler) =>
    [handler.name, ...(handler.aliases ?? [])].map((name) => [name, handler]),
  ),
);

export const views = Object.assign(
  {},
  ...handlers.map((handler) => handler.views ?? {}),
);

export const actions = Object.assign(
  {},
  ...handlers.map((handler) => handler.actions ?? {}),
);
