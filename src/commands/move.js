import { pairFor, roleOf } from "../channels.js";
import { activeRequirements, tasksWithStatus } from "../db.js";
import { intent } from "../intents.js";
import { loadRequirement } from "../requirements.js";
import { acknowledge, callSlack, escapeSlack, linkedThread, mrkdwn, plainText, respondLater } from "../slack.js";
import { STATUSES, loadTask, setPinned, statusName } from "../tasks.js";
import { incidentView, requirementView } from "./requirement.js";
import { trackView } from "./track.js";

const PICK_ACTION = "move:pick";
const MOVE_ACTION = "move:confirm";
const CANCEL_ACTION = "move:cancel";
const PICK_BLOCK = "move:target";
const START_ACTION = "move:start-requirement";
const INCIDENT_ACTION = "move:report-incident";
const TRACK_ACTION = "move:track-task";
const EXISTING_ACTION = "move:existing";
const DISMISS_ACTION = "move:dismiss";
// The message shortcuts, ⋯ → More actions → Move to task and Convert to
// task, by the callback_ids the manifest gives them, and Move's form.
const MOVE_SHORTCUT = "move";
const CONVERT_SHORTCUT = "convert";
const MOVE_VIEW = "move:form";

// Added to a moved message, so it can be passed over without opening it.
const MOVED_REACTION = "outbox_tray";

const NOT_IN_THREAD = "Reply `@Cade move` in the thread of the message you want to move.";

// What a message can be moved to: requirements and incidents in the external
// channel, tasks in a tasks or incidents channel. Each lists the open ones,
// newest first, and loads one, or null if it is gone; `open` says whether it
// can still take a message, and `noun` names its thread.
const REQUIREMENTS = {
  noun: (requirement) => (requirement.incident ? "incident" : "requirement"),
  list: (env, channel) => activeRequirements(env, channel),
  load: loadRequirement,
  open: (requirement) => requirement.status !== "DONE",
  label: (requirement) => `${requirement.incident ? "Incident" : "Requirement"} · ${requirement.title}`,
  alreadyThere: "This is already a requirement thread.",
  none: "There are no open requirements here.",
  start: "Start one with `/cade requirement`.",
};

const OPEN_STATUSES = Object.keys(STATUSES).filter((status) => status !== "DONE");

const TASKS = {
  noun: () => "task",
  list: async (env, channel) =>
    (await tasksWithStatus(env, channel, OPEN_STATUSES))
      .reverse()
      .slice(0, 100)
      .map(({ ts, task }) => ({ ts, ...task })),
  load: loadTask,
  open: (task) => task.status !== "DONE",
  label: (task) => `${statusName(task.status)} · ${task.title}`,
  alreadyThere: "This is already a task thread.",
  none: "There are no open tasks here.",
  start: "Start one with `/cade track`.",
};

const targetsIn = (env, channel) => (roleOf(env, channel) === "external" ? REQUIREMENTS : TASKS);

// More about a requirement or task sometimes arrives as a message of its own.
// `@Cade move`, replied in that message's thread, asks privately which open
// requirement or incident (in the external channel) or task (in a tasks or
// incidents channel) it belongs to; messages only move within their channel.
// Slack can't move messages, so Move copies it into that thread, quoted and
// credited to whoever wrote it, replies under the original with a link to
// the copy, asking people to carry on there, and reacts to the original with
// :outbox_tray:. Only the message moves, not its replies, which the copy's
// link back still reaches. A bot token can't delete people's messages, so
// the original stays, unpinned if it was pinned.
//
// `@Cade move <link>`, with a link to a requirement's, incident's or task's
// message or any reply in its thread, moves it there straight away, with a
// ✅ on the command, so it can be pasted into old threads one after another.
// Without a link, it asks as above.
//
// ⋯ → More actions → Move to task, Cade's message shortcut, does the same
// from the message itself, with a form (see openMoveForm); Convert to task
// starts a task or requirement from it (see openConvertForm).
//
// A message posted on its own in the external channel, not in a thread, gets
// a private question for whoever posted it: start a requirement or report
// an incident from it, with its first line as the name, or move it to an
// open one. In a tasks channel the question is whether to track it as a
// task, or move it to an open one. A requirement, incident or task started
// from it takes the message into its thread once it is posted, as Move
// would. `@Cade requirement`, `@Cade incident` and `@Cade track`, replied in
// a message's thread, offer the same for that message (see offerStart).
export default {
  name: "move",
  description: "Move a message into a requirement's or task's thread",
  usage: "@Cade move [message link]",
  section: "thread",
  channel: ["external", "tasks", "incidents"],
  async run(command, { env }) {
    const inThread = command.threadTs && command.threadTs !== command.ts;
    if (!inThread) return NOT_IN_THREAD;
    const { problem, moved } = await checkRoot(env, command.channel, command.threadTs);
    if (moved) return privately(env, command, { text: moved });
    if (problem) return problem;
    const targets = targetsIn(env, command.channel);
    const link = linkedThread(command.text);
    if (link) return moveToLinked(env, command, link, targets);
    const open = await targets.list(env, command.channel);
    if (!open.length) return `${targets.none} ${targets.start}`;
    await privately(env, command, picker(command.channel, command.threadTs, open, targets));
  },
  shortcuts: { [MOVE_SHORTCUT]: openMoveForm, [CONVERT_SHORTCUT]: openConvertForm },
  views: { [MOVE_VIEW]: submitMoveForm },
  intents: [
    intent({
      name: "new-thread",
      order: 50,
      match: (message) => !message.inThread,
      handle: (message, { env }) => offerThread(env, message),
    }),
  ],
  actions: {
    [START_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: requirementView(prompted(payload)) });
      await respondLater(payload.response_url, { delete_original: true });
    },
    [INCIDENT_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: incidentView(prompted(payload)) });
      await respondLater(payload.response_url, { delete_original: true });
    },
    [TRACK_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: trackView(prompted(payload)) });
      await respondLater(payload.response_url, { delete_original: true });
    },
    [EXISTING_ACTION]: async (payload, context) => {
      context.waitUntil(offerExisting(context.env, payload));
    },
    [DISMISS_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    // Picking only chooses; Move moves.
    [PICK_ACTION]: async () => {},
    [MOVE_ACTION]: async (payload, context) => {
      const picked = payload.state?.values?.[PICK_BLOCK]?.[PICK_ACTION]?.selected_option?.value;
      if (!picked) {
        await callSlack(context.env, "chat.postEphemeral", {
          channel: payload.channel.id,
          user: payload.user.id,
          text: "Pick where it goes first, then press Move.",
        });
        return;
      }
      context.waitUntil(movePicked(context.env, payload, picked));
    },
    [CANCEL_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// The message a shortcut was chosen on, if it can be moved or have
// something started from it, as { channel, ts, text }; otherwise tells
// whoever chose it why not, privately, and returns null. Only messages posted
// in the channel itself count, not replies. A form must open within Slack's
// three seconds of the click, so these are the quick checks `@Cade move`
// makes.
async function shortcutMessage(payload, env, roles, wrongPlace) {
  const channel = payload.channel.id;
  const { ts, thread_ts: threadTs, text = "" } = payload.message;
  const tell = async (reply) => {
    await callSlack(env, "chat.postEphemeral", { channel, user: payload.user.id, text: reply });
    return null;
  };
  if (!roles.includes(roleOf(env, channel))) return tell(wrongPlace);
  if (threadTs && threadTs !== ts) return tell("I can only do that with messages posted in the channel itself, not replies in a thread.");
  const { problem, moved } = await checkRoot(env, channel, ts);
  if (problem || moved) return tell(problem ?? moved);
  return { channel, ts, text, tell };
}

// ⋯ → More actions → Move to task: a form to choose where the message goes,
// the same choices as `@Cade move`, without a command in its thread.
async function openMoveForm(payload, { env }) {
  const message = await shortcutMessage(
    payload,
    env,
    ["external", "tasks", "incidents"],
    "I only move messages in the client, dev and incidents channels I look after.",
  );
  if (!message) return;
  const { channel, ts, tell } = message;
  const targets = targetsIn(env, channel);
  const open = await targets.list(env, channel);
  if (!open.length) return tell(`${targets.none} ${targets.start}`);
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: MOVE_VIEW,
      private_metadata: JSON.stringify({ channel, ts }),
      title: plainText("Move to task"),
      submit: plainText("Move"),
      close: plainText("Cancel"),
      blocks: [
        {
          type: "input",
          block_id: "target",
          label: plainText("Move it to"),
          element: {
            type: "static_select",
            action_id: "value",
            placeholder: plainText(targets === TASKS ? "Choose a task" : "Choose a requirement"),
            options: open.map((target) => ({ text: plainText(optionText(targets.label(target))), value: target.ts })),
          },
        },
        { type: "context", elements: [mrkdwn(optionText(firstLine(message.text)) || "_The message_")] },
      ],
    },
  });
}

// ⋯ → More actions → Convert to task: in the dev channel, the Track task
// form; in the client channel, where the client's work starts as a
// requirement, the Start requirement form. Each is named from the message's
// first line, and takes the message into its thread once it's posted, as
// Track as task and Start requirement do.
async function openConvertForm(payload, { env }) {
  const message = await shortcutMessage(
    payload,
    env,
    ["external", "tasks"],
    "Convert to task works on messages in the dev channel, or the client channel for a requirement.",
  );
  if (!message) return;
  const { channel, ts, text } = message;
  const view = roleOf(env, channel) === "external" ? requirementView : trackView;
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: view({ channel, moveTs: ts, title: firstLine(text) }),
  });
}

// Moves the message as Move on the picker would, telling only whoever chose
// it if it couldn't.
function submitMoveForm(payload, context) {
  const { channel, ts } = JSON.parse(payload.view.private_metadata);
  const targetTs = payload.view.state.values.target.value.selected_option.value;
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const problem = await moveMessage(context.env, { channel, ts, targetTs, user });
      if (problem) await callSlack(context.env, "chat.postEphemeral", { channel, user, text: problem });
    })(),
  );
}

function picker(channel, ts, open, targets) {
  const text = "Where should I move this message?";
  const value = JSON.stringify({ channel, ts });
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        block_id: PICK_BLOCK,
        elements: [
          {
            type: "static_select",
            action_id: PICK_ACTION,
            placeholder: plainText(targets === TASKS ? "Choose a task" : "Choose a requirement"),
            options: open.map((target) => ({
              text: plainText(optionText(targets.label(target))),
              value: target.ts,
            })),
          },
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: MOVE_ACTION, text: plainText("Move"), style: "primary", value },
          { type: "button", action_id: CANCEL_ACTION, text: plainText("Cancel"), value },
        ],
      },
    ],
  };
}

// A menu option's text is at most 75 characters.
function optionText(text) {
  return text.length > 75 ? `${text.slice(0, 74)}…` : text;
}

// What can be started from a message: the question and button
// `@Cade <kind>` offers, and the action that opens its form.
const STARTS = {
  requirement: { question: "Shall I start a requirement from this message?", button: "Start requirement", action: START_ACTION },
  incident: { question: "Shall I report an incident from this message?", button: "Report incident", action: INCIDENT_ACTION },
  task: { question: "Shall I track this message as a task?", button: "Track task", action: TRACK_ACTION },
};

// The private question for a message posted on its own. In the external
// channel, Report incident is there if the pair has an incidents channel;
// Move to existing is there if there's anything open to move it to. The
// incidents channel's tasks come only from incidents, so it isn't asked.
async function offerThread(env, message) {
  const role = roleOf(env, message.channel);
  if (role !== "external" && role !== "tasks") return;
  const value = JSON.stringify({
    channel: message.channel,
    ts: message.ts,
    title: firstLine(message.text),
  });
  const button = (action_id, text, style) => ({ type: "button", action_id, text: plainText(text), value, style });
  const open = await targetsIn(env, message.channel).list(env, message.channel);
  const [text, starts] =
    role === "external"
      ? [
          "Is this a new requirement, an incident, or part of one we're already on?",
          [
            button(START_ACTION, "Start requirement", "primary"),
            pairFor(env, message.channel).incidents && button(INCIDENT_ACTION, "Report incident"),
          ],
        ]
      : ["Should I track this as a task, or is it part of one we're already on?", [button(TRACK_ACTION, "Track as task", "primary")]];
  const buttons = [
    ...starts,
    open.length && button(EXISTING_ACTION, "Move to existing"),
    button(DISMISS_ACTION, "Not now"),
  ].filter(Boolean);
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    user: message.user,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }, { type: "actions", elements: buttons }],
  });
}

// For `@Cade requirement`, `@Cade incident` or `@Cade track` replied in a
// message's thread: offers, privately, to start a `kind` from the thread's
// root message, or returns why it can't.
export async function offerStart(env, command, kind) {
  const { problem, moved, root } = await checkRoot(env, command.channel, command.threadTs);
  if (moved) return privately(env, command, { text: moved });
  if (problem) return problem;
  const { question, button, action } = STARTS[kind];
  const value = JSON.stringify({ channel: command.channel, ts: command.threadTs, title: firstLine(root.text ?? "") });
  await privately(env, command, {
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: action, text: plainText(button), style: "primary", value },
          { type: "button", action_id: DISMISS_ACTION, text: plainText("Not now"), value },
        ],
      },
    ],
  });
}

// Whether the root of the thread at `ts` can be moved, or have something
// started from it: { root } if so, or { problem } to reply with, or { moved }
// to tell the person privately where it went.
async function checkRoot(env, channel, ts) {
  const targets = targetsIn(env, channel);
  if (await targets.load(env, channel, ts)) return { problem: targets.alreadyThere };
  const thread = await readThread(env, channel, ts);
  if (!thread || thread.root.bot_id) return { problem: "I can only move people's messages." };
  if (thread.movedTo) return { moved: `This message was already moved: <${thread.movedTo}|see it there>.` };
  return { root: thread.root };
}

// Moves the command's thread into the one `link` points to, acknowledging
// the command, or returns why it can't.
async function moveToLinked(env, command, link, targets) {
  const noun = targets === TASKS ? "a task" : "a requirement or incident";
  if (link.channel !== command.channel) {
    return `That link is to another channel. Messages only move within their own channel, so paste a link to ${noun} here.`;
  }
  const target = await targets.load(env, link.channel, link.ts);
  if (!target) return `That link isn't to ${noun} here. Use Copy link on its message.`;
  if (!targets.open(target)) return `That ${targets.noun(target)} is done, so I didn't move anything.`;
  const problem = await moveMessage(env, { channel: command.channel, ts: command.threadTs, targetTs: link.ts, user: command.user });
  return problem ?? acknowledge();
}

// Shows `body` in the command's thread to whoever sent it.
async function privately(env, command, body) {
  await callSlack(env, "chat.postEphemeral", {
    channel: command.channel,
    thread_ts: command.threadTs,
    user: command.user,
    ...body,
  });
}

// The message's first line, without formatting marks, as a name to start
// the form with.
function firstLine(text) {
  return text.split("\n").find((line) => line.trim())?.replace(/[*_~`>]/g, "").trim().slice(0, 150) ?? "";
}

// The form's origin, from a button on the question: the message to move
// into the new thread, and its first line.
function prompted(payload) {
  const { channel, ts, title } = JSON.parse(payload.actions[0].value);
  return { channel, moveTs: ts, title };
}

// Replaces the question with the picker, as `@Cade move` shows it.
async function offerExisting(env, payload) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const targets = targetsIn(env, channel);
  const open = await targets.list(env, channel);
  const body = open.length
    ? picker(channel, ts, open, targets)
    : { text: `Everything here has been closed since. ${targets.start}` };
  await respondLater(payload.response_url, { replace_original: true, ...body });
}

// Moves the message the picker is for, then removes the picker, or says
// why it didn't.
async function movePicked(env, payload, targetTs) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const problem = await moveMessage(env, { channel, ts, targetTs, user: payload.user.id });
  await respondLater(
    payload.response_url,
    problem ? { replace_original: true, text: problem } : { delete_original: true },
  );
}

// Copies the message at `ts` into the thread of the requirement or task at
// `targetTs`, in the same channel, replies under the original and reacts to
// it, on behalf of `user`. Returns why it didn't, or null if it did: the
// target may have been done or deleted, or the message deleted or moved,
// since the move was asked for.
export async function moveMessage(env, { channel, ts, targetTs, user }) {
  const targets = targetsIn(env, channel);
  const target = await targets.load(env, channel, targetTs);
  if (!target || !targets.open(target)) return "That has been closed or deleted since, so I didn't move anything.";
  const thread = await readThread(env, channel, ts);
  if (!thread) return "That message has been deleted since, so there's nothing to move.";
  if (thread.movedTo) return `This message was already moved: <${thread.movedTo}|see it there>.`;
  const { root } = thread;

  // A top-level message's link only scrolls to it; thread_ts opens its
  // thread too, where its replies stayed.
  const { permalink } = await callSlack(env, "chat.getPermalink", { channel, message_ts: ts });
  const original = `${permalink}?thread_ts=${ts}&cid=${channel}`;
  const quoted = (root.text ?? "").split("\n").map((line) => `> ${line}`).join("\n");
  const files = root.files?.length ? "\n_It has attachments: see the original._" : "";
  const copy = await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: targetTs,
    text: `Moved from <@${root.user}>'s <${original}|message>:\n${quoted}${files}`,
  });

  const { permalink: moved } = await callSlack(env, "chat.getPermalink", { channel, message_ts: copy.ts });
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    text: `<@${user}> moved this message to the ${targets.noun(target)} thread <${moved}|${escapeSlack(target.title)}>. Please carry on the conversation there.`,
  });
  // The reaction is only a signal, so the move stands without it.
  await callSlack(env, "reactions.add", { channel, timestamp: ts, name: MOVED_REACTION }).catch((error) => {
    console.warn("Could not mark the message moved", { ts, error: error.message });
  });
  // A pinned original is now followed in the thread it moved to, so it no
  // longer needs its pin. setPinned only logs a failure.
  if (root.pinned_to?.includes(channel)) await setPinned(env, channel, ts, false);
  console.log("Message moved", { ts, targetTs, user });
  return null;
}

// The thread's root message and, if Cade moved it already, the link to its
// copy, from Cade's note under it; or null if the root is gone.
async function readThread(env, channel, ts) {
  let messages;
  try {
    ({ messages = [] } = await callSlack(env, "conversations.replies", { channel, ts, limit: 200 }));
  } catch (error) {
    if (/message_not_found|thread_not_found/.test(error.message)) return null;
    throw error;
  }
  const [root] = messages;
  if (!root || root.ts !== ts || root.subtype === "tombstone") return null;
  const note = messages
    .slice(1)
    .map((message) => message.bot_id && MOVED_NOTE.exec(message.text ?? ""))
    .find(Boolean);
  return { root, movedTo: note?.[1] };
}

const MOVED_NOTE = /moved this message to the \w+ thread <([^|>]+)\|/;
