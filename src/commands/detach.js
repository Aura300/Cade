import { roleOf } from "../channels.js";
import { markRequirementDeleted } from "../db.js";
import { loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn, respondLater } from "../slack.js";
import { NOT_A_TASK, loadTask, refreshSummary, saveTask, setPinned } from "../tasks.js";
import { linkedThread } from "./move.js";

const NOT_LINKED = "This task isn't linked to a requirement or incident, so there's nothing to detach.";
const NO_LINK =
  "Paste the link to the task's thread: `/cade detach <link>`, with the link from Copy link on the task's message in the dev or incidents channel.";

// `@Cade detach` in the thread of a task tracked from a requirement or
// incident ends the link between the two. The task stays in
// the dev or incidents channel as the team's own, with its priority and due
// date changed from its thread from then on; its message still links to
// the thread it was tracked from. The requirement's message is
// kept, saying where the work went, and Cade no longer tracks it: it counts
// as deleted, so it leaves the summaries and `/cade exec`, and nothing
// reaches its thread any more.
//
// It is the team taking the work over, so it is sent from the task's
// thread, where the team works, never from the client's, and both threads
// are told.
//
// `/cade detach <link>`, with a link to the task's thread, does the same
// quietly, from anywhere: nothing is posted in either thread, so no one is
// notified, and only whoever sent it is told. It suits detaching many
// threads at once. The messages Cade edits notify no one either.
export default {
  name: "detach",
  description: "Unlink a task from its requirement or incident, so the team owns it (in its thread, or quietly with a link)",
  usage: "@Cade detach",
  slashUsage: "/cade detach <link>",
  section: "thread",
  channel: ["tasks", "incidents"],
  slashChannel: [],
  inThread: true,
  run: (command, { env }) => fromTask(env, command),
  async slash(command, context) {
    const link = linkedThread(command.text);
    if (!link || !["tasks", "incidents"].includes(roleOf(context.env, link.channel))) return NO_LINK;
    // Detaching edits several messages, which can take longer than Slack
    // waits for a slash command's answer, so the reply follows.
    context.waitUntil(
      (async () => respondLater(command.responseUrl, { text: await quietly(context.env, link, command.user) }))(),
    );
  },
};

// Detaches the task at `link` without posting in either thread, and returns
// what to tell whoever asked.
async function quietly(env, link, user) {
  const task = await loadTask(env, link.channel, link.ts);
  if (!task) return "That link isn't to a task's thread. Use Copy link on the task's message.";
  if (!task.source) return NOT_LINKED;
  const noun = task.source.incident ? "incident" : "requirement";
  await detachTask(env, link.channel, link.ts, task, user, { quiet: true });
  const title = escapeSlack(task.title);
  const name = task.link ? `<${task.link}|${title}>` : `*${title}*`;
  return `Detached ${name} from its ${noun}. I didn't post in either thread.`;
}

async function fromTask(env, command) {
  const task = await loadTask(env, command.channel, command.threadTs);
  if (!task) return NOT_A_TASK;
  if (!task.source) return NOT_LINKED;
  const { source } = task;
  await detachTask(env, command.channel, command.threadTs, task, command.user);
  return detachedFromTask(command.user, source);
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
