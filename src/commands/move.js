import { groupDisabled, projects, roleOf } from "../channels.js";
import { tasksWithStatus } from "../db.js";
import { findIntent, intent, intentsOn, plainMessage } from "../intents.js";
import { acknowledge, callSlack, escapeSlack, linkedThread, mrkdwn, plainText, respondLater } from "../slack.js";
import { STATUSES, chosenProject, loadTask, projectBlock, setPinned, statusName } from "../tasks.js";
import { incidentView, trackView } from "./track.js";

const PICK_ACTION = "move:pick";
const MOVE_ACTION = "move:confirm";
const CANCEL_ACTION = "move:cancel";
const PICK_BLOCK = "move:target";
const INCIDENT_ACTION = "move:report-incident";
const TRACK_ACTION = "move:track-task";
const EXISTING_ACTION = "move:existing";
const DISMISS_ACTION = "move:dismiss";
const PROJECT_ACTION = "move:project";
// The emoji that ask Cade to convert or move a message, when someone adds
// them to it.
const REACTIONS = { convert: "ticket", move: "twisted_rightwards_arrows" };

// The message shortcuts, ⋯ → More actions → New task, New
// incident and Move to existing, by the callback_ids the manifest gives
// them, and Move's form.
const CONVERT_SHORTCUT = "convert";
const INCIDENT_SHORTCUT = "incident";
const MOVE_SHORTCUT = "move";
const MOVE_VIEW = "move:form";

// Added to a moved message, so it can be passed over without opening it.
const MOVED_REACTION = "outbox_tray";

// How much of a message a shortcut carries to be quoted: a form's
// private_metadata holds at most 3,000 characters.
const MAX_QUOTED = 2000;

const NOT_IN_THREAD = "Reply `@Cade move` in the thread of the message you want to move.";
const NO_OPEN = "There are no open tasks there. Start one with `/cade task`.";

const OPEN_STATUSES = Object.keys(STATUSES).filter((status) => status !== "DONE");

// The open tasks in the dev channel `channel`, incidents included, newest
// first: at most 100, as many as a Slack menu takes.
async function openTasks(env, channel) {
  return (await tasksWithStatus(env, channel, OPEN_STATUSES))
    .reverse()
    .slice(0, 100)
    .map(({ ts, task }) => ({ ts, ...task }));
}

function taskOption(task) {
  const label = `${statusName(task.status)} · ${task.incident ? "Incident · " : ""}${task.title}`;
  return { text: plainText(optionText(label)), value: task.ts };
}

// More about a task sometimes arrives as a message of its own. `@Cade move`,
// replied in that message's thread in a dev channel, asks privately which
// open task it belongs to. Slack can't move messages, so Move copies it into
// that thread, quoted and credited to whoever wrote it, replies under the
// original with a link to the copy, asking people to carry on there, and
// reacts to the original with :outbox_tray:. Only the message moves, not its
// replies, which the copy's link back still reaches. A bot token can't
// delete people's messages, so the original stays, unpinned if it was
// pinned.
//
// `@Cade move <link>`, with a link to a task's message or any reply in its
// thread, moves it there straight away, with a ✅ on the command, so it can
// be pasted into old threads one after another. Without a link, it asks as
// above.
//
// The message shortcuts work on any message, anywhere: a dev channel, any
// other channel, a DM. New task and New incident open the task or
// incident form, named from the message's first line; Move to existing
// opens a form to pick an open task. Outside a dev channel, with more than
// one group, each form asks for the project too, and Move to existing then
// lists that project's open tasks. The message is copied as above, so it can be read in the task's
// thread even by people who can't see where it was written; the link back
// to it, and the note and reaction under it, work only where they can.
// Adding 🎫 or 🔀 to a message in a dev channel (see REACTIONS) does
// the same in one click from Slack's hover bar, with a private reply
// instead of a form (see reacted).
//
// A message posted on its own in a dev channel, not in a thread, gets a
// private question for whoever posted it: track it as a task, report it as
// an incident, or move it to an open task. `@Cade task` and `@Cade
// incident`, replied in a message's thread, offer the same (see offerStart).
export default {
  name: "move",
  description: "Move a message into a task's thread",
  usage: "@Cade move [message link]",
  section: "message",
  channel: "channel",
  async run(command, { env }) {
    const inThread = command.threadTs && command.threadTs !== command.ts;
    if (!inThread) return NOT_IN_THREAD;
    const { problem, moved } = await checkRoot(env, command.channel, command.threadTs);
    if (moved) return privately(env, command, { text: moved });
    if (problem) return problem;
    const link = linkedThread(command.text);
    if (link) return moveToLinked(env, command, link);
    const open = await openTasks(env, command.channel);
    if (!open.length) return NO_OPEN;
    await privately(env, command, picker(command.channel, command.threadTs, open));
  },
  shortcuts: {
    [CONVERT_SHORTCUT]: (payload, { env }) => openStartForm(payload, env, trackView),
    [INCIDENT_SHORTCUT]: (payload, { env }) => openStartForm(payload, env, incidentView),
    [MOVE_SHORTCUT]: (payload, { env }) => openMoveForm(payload, env),
  },
  reactions: (event, { env }) => reacted(env, event),
  views: { [MOVE_VIEW]: submitMoveForm },
  intents: [
    intent({
      name: "new-thread",
      order: 50,
      // Not a suggestion kind: messages posted on their own are asked about
      // even with `taskStatusChangeDetection` off, unless `newMessageTaskDetection` is false.
      match: (message) => !message.inThread,
      handle: (message, { env }) => offerThread(env, message),
    }),
  ],
  actions: {
    [INCIDENT_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: incidentView(env, prompted(payload)) });
      await respondLater(payload.response_url, { delete_original: true });
    },
    [TRACK_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: trackView(env, prompted(payload)) });
      await respondLater(payload.response_url, { delete_original: true });
    },
    // The form must open within Slack's three seconds of the click.
    [EXISTING_ACTION]: (payload, { env }) => offerExisting(env, payload),
    [DISMISS_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    // Choosing a project on Move's form lists its open tasks.
    [PROJECT_ACTION]: async (payload, { env }) => {
      const meta = JSON.parse(payload.view.private_metadata);
      const project = chosenProject(payload.view.state.values);
      await callSlack(env, "views.update", {
        view_id: payload.view.id,
        hash: payload.view.hash,
        view: await moveForm(env, meta, project),
      });
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

// The message a shortcut was chosen on, as the `from` moveMessage takes,
// with what to quote, so it can be moved from places Cade can't read; or,
// if it can't be, null, having told whoever chose it why, privately. In a
// dev channel only messages posted in the channel itself count, not
// replies, and not tasks. A form must open within Slack's three seconds of
// the click, so these are quick checks.
async function shortcutMessage(payload, env) {
  const channel = payload.channel.id;
  const { ts, thread_ts: threadTs, text = "", user, files, pinned_to: pinnedTo } = payload.message;
  if (roleOf(env, channel) === "channel") {
    let problem = threadTs && threadTs !== ts && "I can only do that with messages posted in the channel itself, not replies in a thread.";
    if (!problem) {
      const checked = await checkRoot(env, channel, ts);
      problem = checked.problem ?? checked.moved;
    }
    if (problem) {
      await tell(env, payload, problem);
      return null;
    }
  }
  const quoted = text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text;
  return {
    channel,
    ts,
    threadTs: threadTs ?? ts,
    author: user,
    text: quoted,
    files: Boolean(files?.length) || quoted !== text,
    pinned: Boolean(pinnedTo?.includes(channel)),
    link: messageLink(payload),
  };
}

// A link to the shortcut's message that opens its thread, from the
// workspace's address. It works only for people who can see the message.
function messageLink({ team, channel, message }) {
  if (!team?.domain) return undefined;
  const threadTs = message.thread_ts ?? message.ts;
  return `https://${team.domain}.slack.com/archives/${channel.id}/p${message.ts.replace(".", "")}?thread_ts=${threadTs}&cid=${channel.id}`;
}

// Tells whoever chose a shortcut, privately, wherever it was chosen.
async function tell(env, payload, text) {
  if (payload.response_url) await respondLater(payload.response_url, { text });
  else await callSlack(env, "chat.postEphemeral", { channel: payload.channel.id, user: payload.user.id, text });
}

// The dev channel a shortcut's form is for, so it needn't ask for the
// project: the one it was chosen in, or the only group's; undefined when
// there's a choice to make.
function knownProject(env, channel) {
  if (roleOf(env, channel) === "channel") return channel;
  const groups = projects(env);
  return groups.length === 1 ? groups[0].channel : undefined;
}

// New task and New incident: their form, named from the message's first
// line, for the known project, or asking for it.
async function openStartForm(payload, env, view) {
  const from = await shortcutMessage(payload, env);
  if (!from) return;
  const channel = knownProject(env, from.channel);
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: view(env, { channel, move: from, title: firstLine(from.text) }),
  });
}

// Move to existing: a form to choose the open task the message goes to, in
// the known project, or in the project chosen on it.
async function openMoveForm(payload, env) {
  const from = await shortcutMessage(payload, env);
  if (!from) return;
  const channel = knownProject(env, from.channel);
  const meta = { from, responseUrl: payload.response_url, ...(channel && { channel }) };
  if (channel && !(await openTasks(env, channel)).length) return tell(env, payload, NO_OPEN);
  await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: await moveForm(env, meta, channel) });
}

// Move's form for the project whose dev channel is `project`, if one is
// chosen: the project picker, unless the project is known already
// (`meta.channel`), then its open tasks.
async function moveForm(env, meta, project) {
  const open = project ? await openTasks(env, project) : [];
  const tasks = open.length
    ? {
        type: "input",
        block_id: "target",
        label: plainText("Move it to"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("Choose a task"),
          options: open.map(taskOption),
        },
      }
    : { type: "context", elements: [mrkdwn(project ? NO_OPEN : "Choose a project to see its open tasks.")] };
  return {
    type: "modal",
    callback_id: MOVE_VIEW,
    private_metadata: JSON.stringify(meta),
    title: plainText("Move to existing"),
    submit: plainText("Move"),
    close: plainText("Cancel"),
    blocks: [
      ...(meta.channel ? [] : [projectBlock(env, { actionId: PROJECT_ACTION, initial: project })]),
      tasks,
      { type: "context", elements: [mrkdwn(optionText(meta.title ?? firstLine(meta.from.text)) || "_The message_")] },
    ],
  };
}

// Moves the message as Move on the picker would, telling only whoever chose
// it if it couldn't.
function submitMoveForm(payload, context) {
  const { from, responseUrl, channel = chosenProject(payload.view.state.values) } = JSON.parse(payload.view.private_metadata);
  const targetTs = payload.view.state.values.target?.value.selected_option?.value;
  if (!targetTs) return { response_action: "errors", errors: { project: "Choose a project with open tasks." } };
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const problem = await moveMessage(context.env, { from, target: { channel, ts: targetTs }, user });
      if (problem && responseUrl) await respondLater(responseUrl, { text: problem });
    })(),
  );
}

// Someone added an emoji to a message in a dev channel. The convert emoji
// asks them, privately, whether to track it as a task, with a button that
// opens the form, since a reaction carries no trigger_id to open one; the
// move emoji shows them the picker `@Cade move` shows. Other emoji are left
// alone. Only messages posted in the channel itself count, and anything
// stopping it is said only to them.
async function reacted(env, event) {
  const emoji = event.reaction.split("::")[0];
  const { channel, ts } = event.item;
  const action = { [REACTIONS.convert]: "convert", [REACTIONS.move]: "move" }[emoji];
  if (!action) return;
  if (roleOf(env, channel) !== "channel") return;
  const user = event.user;
  const tell = (body) => callSlack(env, "chat.postEphemeral", { channel, user, ...body });

  const { problem, moved, root } = await checkRoot(env, channel, ts);
  if (problem || moved) return tell({ text: problem ?? moved });
  if (action === "move") {
    const open = await openTasks(env, channel);
    if (!open.length) return tell({ text: NO_OPEN });
    return tell(picker(channel, ts, open));
  }
  await tell(startQuestion("task", { channel, ts, title: firstLine(root.text ?? "") }));
}

function picker(channel, ts, open) {
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
            placeholder: plainText("Choose a task"),
            options: open.map(taskOption),
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
  task: { question: "Shall I track this message as a task?", button: "New task", action: TRACK_ACTION },
  incident: { question: "Shall I report an incident from this message?", button: "New incident", action: INCIDENT_ACTION },
};

// The question to start a `kind` from the message `value` ({ channel, ts,
// title }), with Not now.
function startQuestion(kind, value) {
  const { question, button, action } = STARTS[kind];
  const json = JSON.stringify(value);
  return {
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: action, text: plainText(button), style: "primary", value: json },
          { type: "button", action_id: DISMISS_ACTION, text: plainText("Not now"), value: json },
        ],
      },
    ],
  };
}

// The private question for a message posted on its own in a dev channel.
// Move to existing is there if there's anything open to move it to.
async function offerThread(env, message) {
  if (roleOf(env, message.channel) !== "channel") return;
  if (groupDisabled(env, message.channel, "newMessageTaskDetection", "NEW_MESSAGE_TASK_DETECTION")) return;
  const value = JSON.stringify({ channel: message.channel, ts: message.ts, title: firstLine(message.text) });
  const button = (action_id, text, style) => ({ type: "button", action_id, text: plainText(text), value, style });
  const open = await openTasks(env, message.channel);
  const text = "Is this a new task, a new incident, or part of an existing one?";
  const buttons = [
    button(TRACK_ACTION, "New task", "primary"),
    button(INCIDENT_ACTION, "New incident"),
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

// For `@Cade task` or `@Cade incident` replied in a message's thread:
// offers, privately, to start a `kind` from the thread's root message, or
// returns why it can't.
export async function offerStart(env, command, kind) {
  const { problem, moved, root } = await checkRoot(env, command.channel, command.threadTs);
  if (moved) return privately(env, command, { text: moved });
  if (problem) return problem;
  await privately(env, command, startQuestion(kind, { channel: command.channel, ts: command.threadTs, title: firstLine(root.text ?? "") }));
}

// Whether the root of the thread at `ts` in a dev channel can be moved, or
// have something started from it: { root } if so, or { problem } to reply
// with, or { moved } to tell the person privately where it went.
async function checkRoot(env, channel, ts) {
  if (await loadTask(env, channel, ts)) return { problem: "This is already a task thread." };
  const thread = await readThread(env, channel, ts);
  if (!thread || thread.root.bot_id) return { problem: "I can only move people's messages." };
  if (thread.movedTo) return { moved: `This message was already moved: <${thread.movedTo}|see it there>.` };
  return { root: thread.root };
}

// Moves the command's thread into the one `link` points to, acknowledging
// the command, or returns why it can't.
async function moveToLinked(env, command, link) {
  const task = await loadTask(env, link.channel, link.ts);
  if (!task) return "That link isn't to a task. Use Copy link on its message.";
  if (task.status === "DONE") return "That task is done, so I didn't move anything.";
  const problem = await moveMessage(env, {
    from: { channel: command.channel, ts: command.threadTs },
    target: link,
    user: command.user,
  });
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

// The form's origin, from a button on the question: the dev channel, the
// message to move into the new thread, and its first line.
function prompted(payload) {
  const { channel, ts, title } = JSON.parse(payload.actions[0].value);
  return { channel, move: { channel, ts }, title };
}

// Opens Move to existing's form, as the message shortcut does, and removes
// the question; or, if everything was closed since, says so in its place.
async function offerExisting(env, payload) {
  const { channel, ts, title } = JSON.parse(payload.actions[0].value);
  if (!(await openTasks(env, channel)).length) {
    await respondLater(payload.response_url, { replace_original: true, text: `Everything here has been closed since. ${NO_OPEN}` });
    return;
  }
  const meta = { from: { channel, ts }, channel, title, responseUrl: payload.response_url };
  await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: await moveForm(env, meta, channel) });
  await respondLater(payload.response_url, { delete_original: true });
}

// Moves the message the picker is for, then removes the picker, or says
// why it didn't.
async function movePicked(env, payload, targetTs) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const problem = await moveMessage(env, { from: { channel, ts }, target: { channel, ts: targetTs }, user: payload.user.id });
  await respondLater(
    payload.response_url,
    problem ? { replace_original: true, text: problem } : { delete_original: true },
  );
}

// Copies the message `from` into the thread of the task `target`, on behalf
// of `user`, then replies under the original and reacts to it. `from` is {
// channel, ts }, read from Slack; or, from a message shortcut, it carries
// the message too, as { threadTs, author, text, files, pinned, link }, since
// Cade may not be able to read it. The reply and reaction are only signals,
// so the move stands without them, where Cade can't post. Returns why it
// didn't move, or null if it did: the task may have been done or deleted,
// or the message deleted or moved, since the move was asked for.
export async function moveMessage(env, { from, target, user }) {
  const task = await loadTask(env, target.channel, target.ts);
  if (!task || task.status === "DONE") return "That task has been closed or deleted since, so I didn't move anything.";
  let message = from;
  if (from.text === undefined) {
    const thread = await readThread(env, from.channel, from.ts);
    if (!thread) return "That message has been deleted since, so there's nothing to move.";
    if (thread.movedTo) return `This message was already moved: <${thread.movedTo}|see it there>.`;
    const { root } = thread;
    message = {
      ...from,
      threadTs: from.ts,
      author: root.user,
      text: root.text ?? "",
      files: Boolean(root.files?.length),
      pinned: Boolean(root.pinned_to?.includes(from.channel)),
    };
  }

  // A message's link only scrolls to it; thread_ts opens its thread too,
  // where its replies stayed.
  let original = message.link;
  if (!original) {
    const { permalink } = await callSlack(env, "chat.getPermalink", { channel: from.channel, message_ts: from.ts });
    original = `${permalink}?thread_ts=${message.threadTs}&cid=${from.channel}`;
  }
  const quoted = message.text.split("\n").map((line) => `> ${line}`).join("\n");
  const files = message.files ? "\n_There's more in the original._" : "";
  const copy = await callSlack(env, "chat.postMessage", {
    channel: target.channel,
    thread_ts: target.ts,
    text: `Moved from <@${message.author}>'s <${original}|message>:\n${quoted}${files}`,
  });

  const { permalink: moved } = await callSlack(env, "chat.getPermalink", { channel: target.channel, message_ts: copy.ts });
  const noun = task.incident ? "incident" : "task";
  try {
    await callSlack(env, "chat.postMessage", {
      channel: from.channel,
      thread_ts: message.threadTs,
      text: `<@${user}> moved this message to the ${noun} thread <${moved}|${escapeSlack(task.title)}>. Please carry on the conversation there.`,
    });
    await callSlack(env, "reactions.add", { channel: from.channel, timestamp: from.ts, name: MOVED_REACTION });
  } catch (error) {
    console.warn("Could not mark the message moved", { ts: from.ts, error: error.message });
  }
  // A pinned original is now followed in the thread it moved to, so it no
  // longer needs its pin. setPinned only logs a failure.
  if (message.pinned) await setPinned(env, from.channel, from.ts, false);
  console.log("Message moved", { ts: from.ts, targetTs: target.ts, user });
  await suggestForCopy(env, { message, target, ts: copy.ts });
  return null;
}

// Cade's own posts are never read for suggestions (see plainMessage), but
// the copy of a moved message carries someone's words into the task's
// thread, so they're read as if their author had just posted them there.
// A failure here doesn't undo the move.
async function suggestForCopy(env, { message, target, ts }) {
  if (!message.text || !message.author) return;
  try {
    const { user_id: botUserId } = await callSlack(env, "auth.test", {});
    const copied = plainMessage(
      { text: message.text, user: message.author, channel: target.channel, ts, thread_ts: target.ts },
      botUserId,
    );
    // Imported when needed, as the registry lists this command.
    const { intents } = await import("./registry.js");
    const meant = copied && findIntent(intentsOn(env, intents, target.channel), copied);
    if (meant) await meant.handle(copied, { env });
  } catch (error) {
    console.warn("Could not read the moved message for suggestions", { ts, error: error.message });
  }
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
