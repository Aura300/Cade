import { markRequirementDeleted } from "../db.js";
import { loadRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mrkdwn } from "../slack.js";
import { NOT_A_TASK, loadTask, refreshSummary, saveTask, setPinned } from "../tasks.js";

// `@Cade detach` in the thread of a task tracked from a requirement or
// incident ends the link between the two. The task stays in
// the dev or incidents channel as the team's own, with its priority and due
// date changed from its thread from then on. The requirement's message is
// kept, saying where the work went, and Cade no longer tracks it: it counts
// as deleted, so it leaves the summaries and `/cade exec`, and nothing
// reaches its thread any more.
//
// It is the team taking the work over, so it is sent from the task's
// thread, where the team works, never from the client's.
export default {
  name: "detach",
  description: "Unlink a task from its requirement or incident, so the team owns it (in its thread)",
  usage: "@Cade detach",
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  run: (command, { env }) => fromTask(env, command),
};

async function fromTask(env, command) {
  const task = await loadTask(env, command.channel, command.threadTs);
  if (!task) return NOT_A_TASK;
  if (!task.source) return "This task isn't linked to a requirement or incident, so there's nothing to detach.";
  const { source } = task;
  await detach(env, command.channel, command.threadTs, task, command.user);

  // The requirement is closed only if this is the task it follows; one
  // already deleted is left alone.
  const requirement = await loadRequirement(env, source.channel, source.threadTs);
  if (requirement?.task?.ts === command.threadTs) {
    await closeRequirement(env, source.channel, source.threadTs, requirement, requirement.task, command.user);
    await callSlack(env, "chat.postMessage", {
      channel: source.channel,
      thread_ts: source.threadTs,
      text: `<@${command.user}> detached the task. The team tracks it in <${requirement.task.link}|its own thread> from now on.`,
    });
  }
  return detachedFromTask(command.user, source);
}

function detachedFromTask(user, source) {
  const noun = source?.incident ? "incident" : "requirement";
  const thread = source?.link ? `<${source.link}|its ${noun} thread>` : `its ${noun} thread`;
  return `<@${user}> detached this task from ${thread}. Its priority and due date are set here now.`;
}

// Drops the task's link to its requirement, and renders it without one.
async function detach(env, channel, ts, task, user) {
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
