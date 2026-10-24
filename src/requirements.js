import { roleOf } from "./channels.js";
import { getRequirement, putRequirement } from "./db.js";
import { callSlack, escapeSlack, mrkdwn } from "./slack.js";
import { PRIORITIES, STATUSES, loadTask, saveTask } from "./tasks.js";

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

// An incident is a requirement started with `/cade incident`. It is always
// urgent and fixed as soon as possible, and is tracked straight away in the
// pair's incidents channel.
export const INCIDENT = { priority: "Urgent", dueDate: "Immediate" };

export const INCIDENT_IS_FIXED =
  "Incidents are always :red_circle: Urgent and due Immediate, so their priority and due date can't be changed.";

export const NOT_A_REQUIREMENT =
  "This thread is not a requirement. Use `/cade requirement` to start one, then change its priority and due date in its thread.";

export function requirementMessage(requirement) {
  // The requirement, then its status, priority and due date (from the
  // requirement form, then from the task once one is tracked). Below them, in
  // small text, who started it and who tracked it, linking to the task the
  // way a task links to its requirement thread.
  const { priority, task } = requirement;
  // Requirements and incidents share the external channel, so each message
  // starts by saying which it is.
  const label = requirement.incident ? "Incident" : "Requirement";
  const details = [
    `*Status:* ${REQUIREMENT_STATUSES[requirement.status]}`,
    `*Priority:* ${PRIORITIES[priority]} ${priority}`,
    `*Due:* ${requirement.dueDate || "_None_"}`,
  ].join("  ·  ");
  const people = [
    `${requirement.incident ? "Reported" : "Started"} by <@${requirement.createdBy}>`,
    task
      ? `Tracked by <@${task.trackedBy}> in <${task.link}|the task thread>`
      : "Not tracked yet. Discuss it in this thread, then send `@Cade track` here.",
  ];
  return {
    text: `${label}: ${requirement.title}`,
    blocks: [
      { type: "section", text: mrkdwn(`*${label}:* ${escapeSlack(requirement.title)}`) },
      { type: "section", text: mrkdwn(details) },
      { type: "context", elements: [mrkdwn(people.join("\n"))] },
    ],
  };
}

// Returns the requirement whose root message is `ts`, or null if it is not one.
export async function loadRequirement(env, channel, ts) {
  return getRequirement(env, channel, ts);
}

// Stores the requirement, then renders it to its root message.
export async function saveRequirement(env, channel, ts, requirement) {
  await putRequirement(env, channel, ts, requirement);
  await callSlack(env, "chat.update", { channel, ts, ...requirementMessage(requirement) });
  console.log("Requirement saved", { ts, status: requirement.status });
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
//   "incident"     an incident's thread, in either channel, whose priority
//                  and due date are fixed
export async function findDetails(env, channel, threadTs) {
  const role = roleOf(env, channel);
  if (role !== "external") {
    const task = await loadTask(env, channel, threadTs);
    if (!task) return null;
    let kind = task.source ? "client" : "task";
    if (role === "incidents") kind = "incident";
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
