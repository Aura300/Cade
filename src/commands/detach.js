import { roleOf } from "../channels.js";
import { markRequirementDeleted } from "../db.js";
import { loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, linkedThread, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, loadTask, refreshSummary, saveTask, setPinned } from "../tasks.js";

const NOT_LINKED = "This task isn't linked to a requirement or incident, so there's nothing to detach.";
const NO_LINK =
  "Paste the link to the task's thread: `/cade detach <link>`, with the link from Copy link on the task's message in the dev or incidents channel.";
const NOT_A_TASK_LINK = "That link isn't to a task's thread. Use Copy link on the task's message.";

const DETACH_ACTION = "detach:confirm";
const CANCEL_ACTION = "detach:cancel";

// `@Cade detach` in the thread of a task tracked from a requirement or
// incident ends the link between the two. The task stays in
// the dev or incidents channel as the team's own, with its priority and due
// date changed from its thread from then on; its message still links to
// the thread it was tracked from. The requirement's message is
// kept, saying where the work went, and Cade no longer tracks it: it counts
// as deleted, so it leaves the summaries and `/cade export`, and nothing
// reaches its thread any more.
//
// It is the team taking the work over, so it is sent from the task's
// thread, where the team works, never from the client's. Whoever sent it is
// asked first, privately, with Cancel and Detach, and Detach asks again;
// once detached, both threads are told.
//
// `/cade detach <link>`, with a link to the task's thread, asks the same
// from anywhere, then detaches quietly: nothing is posted in either thread,
// so no one is notified, and only whoever sent it is told. It suits
// detaching many threads at once. The messages Cade edits notify no one
// either.
export default {
  name: "detach",
  description: "Unlink a task from its requirement or incident, so the team owns it (in its thread, or quietly with a link)",
  usage: "@Cade detach",
  slashUsage: "/cade detach <link>",
  section: "thread",
  channel: ["tasks", "incidents"],
  slashChannel: [],
  inThread: true,
  async run(command, { env }) {
    const asked = { channel: command.channel, ts: command.threadTs, user: command.user };
    await callSlack(env, "chat.postEphemeral", {
      channel: command.channel,
      thread_ts: command.threadTs,
      user: command.user,
      ...(await question(env, asked, NOT_A_TASK)),
    });
  },
  async slash(command, context) {
    const link = linkedThread(command.text);
    if (!link || !["tasks", "incidents"].includes(roleOf(context.env, link.channel))) return NO_LINK;
    const asked = { channel: link.channel, ts: link.ts, user: command.user, quiet: true };
    context.waitUntil(
      (async () => respondLater(command.responseUrl, await question(context.env, asked, NOT_A_TASK_LINK)))(),
    );
  },
  actions: {
    // The question is private, so only whoever asked can click; it is
    // replaced by how it went.
    [DETACH_ACTION]: async (payload, context) => {
      const asked = JSON.parse(payload.actions[0].value);
      context.waitUntil(
        (async () => {
          const text = await confirmed(context.env, asked, payload.user.id);
          await respondLater(payload.response_url, { replace_original: true, text });
        })(),
      );
    },
    [CANCEL_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// The private question for detaching the task at `asked` ({ channel, ts,
// user, quiet }), or why it can't be detached. `notTask` is what to say
// when there's no task there.
async function question(env, asked, notTask) {
  const task = await loadTask(env, asked.channel, asked.ts);
  if (!task) return { text: notTask };
  if (!task.source) return { text: NOT_LINKED };
  const noun = task.source.incident ? "incident" : "requirement";
  const text = `Should I detach ${taskName(task)} from its ${noun}? The team owns it from then on, and I stop updating the ${noun}.`;
  const value = JSON.stringify(asked);
  const told = asked.quiet
    ? "Nothing is posted in either thread."
    : "Both threads are told.";
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        // Cancel comes first and stands out, so the safe choice is the easy
        // one; Detach is plain and asks again.
        elements: [
          { type: "button", action_id: CANCEL_ACTION, text: plainText("Cancel"), style: "primary", value },
          {
            type: "button",
            action_id: DETACH_ACTION,
            text: plainText("Detach"),
            value,
            confirm: {
              title: plainText("Detach task?"),
              text: plainText(`The task stops following its ${noun}, whose message will say where the work went. ${told} There's no undo.`),
              confirm: plainText("Detach"),
              deny: plainText("Keep linked"),
              style: "danger",
            },
          },
        ],
      },
    ],
  };
}

// Detaches the task once confirmed, if it still can be, and returns what to
// tell whoever asked. Unless quiet, the task's thread is told too.
async function confirmed(env, asked, user) {
  const { channel, ts } = asked;
  const task = await loadTask(env, channel, ts);
  if (!task) return NOT_A_TASK;
  if (!task.source) return NOT_LINKED;
  const { source } = task;
  const name = taskName(task);
  const noun = source.incident ? "incident" : "requirement";
  await detachTask(env, channel, ts, task, user, { quiet: asked.quiet });
  if (asked.quiet) return `Detached ${name} from its ${noun}. I didn't post in either thread.`;
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: detachedFromTask(user, source) });
  return `Detached ${name} from its ${noun}.`;
}

function taskName(task) {
  const title = escapeSlack(task.title);
  return task.link ? `<${task.link}|${title}>` : `*${title}*`;
}

// Detaches the task and closes the requirement, if this is the task it
// follows; one already deleted is left alone. Unless `quiet`, the
// requirement's thread is told.
async function detachTask(env, channel, ts, task, user, { quiet = false } = {}) {
  const { source } = task;
  await detach(env, channel, ts, task, user);
  const requirement = await loadRequirement(env, source.channel, source.threadTs);
  if (requirement?.task?.ts !== ts) return;
  await closeRequirement(env, source.channel, source.threadTs, requirement, requirement.task, user);
  if (quiet) return;
  await callSlack(env, "chat.postMessage", {
    channel: source.channel,
    thread_ts: source.threadTs,
    text: `<@${user}> detached the task. The team tracks it in <${requirement.task.link}|its own thread> from now on.`,
  });
}

function detachedFromTask(user, source) {
  const noun = source?.incident ? "incident" : "requirement";
  const thread = source?.link ? `<${source.link}|its ${noun} thread>` : `its ${noun} thread`;
  return `<@${user}> detached this task from ${thread}. Its priority and due date are set here now.`;
}

// Drops the task's link to its requirement, keeping only where it was
// tracked from, to show, and renders it.
async function detach(env, channel, ts, task, user) {
  const { link, incident } = task.source;
  if (link) task.trackedFrom = { link, incident };
  delete task.source;
  await saveTask(env, channel, ts, task);
  console.log("Task detached", { ts, user });
}

// Leaves the requirement's message saying where the work went, unpinned,
// and stops tracking it.
async function closeRequirement(env, channel, ts, requirement, tracked, user) {
  const label = requirement.incident ? "Incident" : "Requirement";
  const note = `Moved to <${tracked.link}|its task> in <#${tracked.channel}> by <@${user}>, where the team tracks it now.`;
  await callSlack(env, "chat.update", {
    channel,
    ts,
    text: `${label}: ${requirement.title}`,
    blocks: [
      { type: "section", text: mrkdwn(`${label}  ·  *${escapeSlack(requirement.title)}*`) },
      { type: "context", elements: [mrkdwn(note)] },
    ],
    attachments: [],
  });
  await setPinned(env, channel, ts, false);
  await markRequirementDeleted(env, channel, ts);
  await refreshSummary(env, channel);
}
