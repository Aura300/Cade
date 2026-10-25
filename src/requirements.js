import { pairFor, roleOf } from "./channels.js";
import { getRequirement, getTask, putRequirement } from "./db.js";
import { callSlack, escapeSlack, mrkdwn } from "./slack.js";
import { PRIORITY_COLORS, STATUSES, loadTask, metaLine, prLines, refreshSummary, saveTask, smallText } from "./tasks.js";

// A requirement is a root message Cade posts in an external channel for
// `/cade requirement`; its thread is where the requirement is discussed. Like
// tasks, it is stored in D1 and its root message is rendered from it.

// A requirement is in discussion until a task is tracked from its thread.
// After that it shows the task's status as the client sees it: the team's
// own stages (To do, In review, In testing) all show as In progress.
export const REQUIREMENT_STATUSES = {
  DISCUSSION: ":speech_balloon: In discussion",
  IN_PROGRESS: STATUSES.IN_PROGRESS,
  CLIENT_REVIEW: STATUSES.CLIENT_REVIEW,
  DONE: STATUSES.DONE,
};

// The requirement status that shows a task's status.
export function clientStatus(taskStatus) {
  return REQUIREMENT_STATUSES[taskStatus] && taskStatus !== "DISCUSSION" ? taskStatus : "IN_PROGRESS";
}

// Whether `user`, writing in the external channel `channel`, is on the team
// rather than the client: a member of the pair's tasks or incidents channel.
// Slack can't tell them apart otherwise, so the team's suggestions in a
// requirement thread are only offered to the team. If the members can't be
// read (the app was installed without channels:read and groups:read),
// everyone counts, as before.
export async function onTheTeam(env, channel, user) {
  const { tasks, incidents } = pairFor(env, channel);
  try {
    for (const teamChannel of [tasks, incidents].filter(Boolean)) {
      let cursor;
      do {
        const page = await callSlack(env, "conversations.members", { channel: teamChannel, limit: "1000", cursor });
        if (page.members.includes(user)) return true;
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
    return false;
  } catch (error) {
    console.warn("Could not read the team's channel members", { error: error.message });
    return true;
  }
}

// An incident is a requirement started with `/cade incident`. It is always
// urgent and fixed as soon as possible, and is tracked straight away in the
// pair's incidents channel.
export const INCIDENT = { priority: "Urgent", dueDate: "Immediate" };

export const INCIDENT_IS_FIXED =
  "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.";

export const NOT_A_REQUIREMENT =
  "Hmm, this thread isn't a requirement. Start one with `/cade requirement`, then you can change its priority and due date in its thread.";

export function requirementMessage(requirement, trackedTask) {
  // The requirement, then in small text its status, priority and due date
  // (from the requirement form, then from the task once one is tracked), as
  // on a task's card; the tracked task's PRs, approved, pending approval
  // and pending, as on its card.
  // Below them, in small text, who started it and who tracked it, linking to
  // the task the way a task links to its requirement thread. All but the
  // title sit in an attachment, whose strip down the side has the
  // priority's colour.
  const { priority, task } = requirement;
  // Requirements and incidents share the external channel, so each message
  // starts by saying which it is.
  const label = requirement.incident ? "Incident" : "Requirement";
  const people = [
    `${requirement.incident ? "Reported" : "Started"} by <@${requirement.createdBy}>`,
    task
      ? `tracked by <@${task.trackedBy}> in <${task.link}|the task thread>`
      : "not tracked yet. Talk it through here, then send `@Cade track` when it's ready.",
  ];
  const lines = trackedTask ? prLines(trackedTask) : [];
  const card = [
    { type: "context", elements: [metaLine(REQUIREMENT_STATUSES[requirement.status], priority, requirement.dueDate)] },
    ...(lines.length ? [smallText(lines)] : []),
    smallText([people.join("  ·  ")]),
  ];
  return {
    text: `${label}: ${requirement.title}`,
    blocks: [{ type: "section", text: mrkdwn(`${label}  ·  *${escapeSlack(requirement.title)}*`) }],
    attachments: [{ color: PRIORITY_COLORS[priority], blocks: card }],
  };
}

// Returns the requirement whose root message is `ts`, or null if it is not one.
export async function loadRequirement(env, channel, ts) {
  return getRequirement(env, channel, ts);
}

// Stores the requirement, then renders it to its root message, with its
// task's releases, and to the summary.
export async function saveRequirement(env, channel, ts, requirement) {
  await putRequirement(env, channel, ts, requirement);
  const task = requirement.task && (await getTask(env, requirement.task.channel, requirement.task.ts));
  await callSlack(env, "chat.update", { channel, ts, ...requirementMessage(requirement, task) });
  console.log("Requirement saved", { ts, status: requirement.status });
  await refreshSummary(env, channel);
}

// Updates the requirement (or incident) a task was tracked from, if it was. `change` gets
// the requirement and returns its new state, or null to leave it. The root
// message is a summary, so failures are logged rather than failing the command.
export async function updateRequirement(env, source, change) {
  if (!source) return;
  try {
    const requirement = await loadRequirement(env, source.channel, source.threadTs);
    if (!requirement) return;
    const updated = change(requirement);
    if (updated) await saveRequirement(env, source.channel, source.threadTs, updated);
  } catch (error) {
    console.warn("Could not update requirement", { ts: source.threadTs, error: error.message });
  }
}

// Copies `fields` to the task's requirement, unless a newer task has been
// tracked from the requirement's thread since.
export async function reflectOnRequirement(env, ts, task, fields) {
  await updateRequirement(env, task.source, (requirement) =>
    requirement.task?.ts === ts ? { ...requirement, ...fields } : null,
  );
}

// Finds whose priority and due date a thread changes. The client owns a
// requirement's, so they are changed in the requirement's thread, before and
// after a task is tracked from it; the tracked task follows. The dev team
// owns those of tasks with no requirement. Returns { kind, channel, ts, item },
// or null when the thread is neither a task nor a requirement:
//   "requirement"  a requirement thread; `task` is its tracked task, if any,
//                  as { channel, ts, item }
//   "task"         a task thread for a task with no requirement
//   "client"       a task thread for a task tracked from a requirement, whose
//                  priority and due date cannot be changed there
//   "incident"     an incident's thread, in either channel, or its task's
//                  while linked to it, whose priority and due date are fixed
export async function findDetails(env, channel, threadTs) {
  const role = roleOf(env, channel);
  if (role !== "external") {
    const task = await loadTask(env, channel, threadTs);
    if (!task) return null;
    // A task detached from its incident is the team's own, like any other.
    let kind = task.source ? "client" : "task";
    if (role === "incidents" && task.source) kind = "incident";
    return { kind, channel, ts: threadTs, item: task };
  }

  const requirement = await loadRequirement(env, channel, threadTs);
  if (!requirement) return null;
  const kind = requirement.incident ? "incident" : "requirement";
  const found = { kind, channel, ts: threadTs, item: requirement };
  if (requirement.task) {
    const { channel: taskChannel, ts } = requirement.task;
    const task = await loadTask(env, taskChannel, ts);
    if (task) found.task = { channel: taskChannel, ts, item: task };
  }
  return found;
}

// Saves a priority or due date change, on the requirement's tracked task too.
export async function saveDetails(env, found, fields) {
  Object.assign(found.item, fields);
  if (found.kind !== "requirement") {
    await saveTask(env, found.channel, found.ts, found.item);
    return;
  }
  await saveRequirement(env, found.channel, found.ts, found.item);
  if (found.task) {
    Object.assign(found.task.item, fields);
    await saveTask(env, found.task.channel, found.task.ts, found.task.item);
  }
}
