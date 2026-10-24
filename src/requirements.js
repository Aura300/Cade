import { tasksChannelFor } from "./channels.js";
import { callSlack, escapeSlack, mrkdwn } from "./slack.js";
import { PRIORITIES, STATUSES, loadTask, saveTask } from "./tasks.js";

// A requirement is a root message Luma posts in an external channel for
// `/luma requirement`; its thread is where the requirement is discussed. Like
// tasks, its details live in the root message's metadata.
const REQUIREMENT_EVENT_TYPE = "luma_requirement";

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

export const NOT_A_REQUIREMENT =
  "This thread is not a requirement. Use `/luma requirement` to start one, then change its priority and due date in its thread.";

export function requirementMessage(requirement) {
  // Three lines, then who started it: the requirement; its status, priority
  // and due date (from the requirement form, then from the task once one is
  // tracked); then the task.
  const { priority, task } = requirement;
  const details = [
    `*Status:* ${REQUIREMENT_STATUSES[requirement.status]}`,
    `*Priority:* ${priority ? `${PRIORITIES[priority]} ${priority}` : "_None_"}`,
    `*Due:* ${requirement.dueDate || "_None_"}`,
  ].join("  ·  ");
  const tracked = task
    ? `*Tracked task:* <${task.link}|${escapeSlack(task.title)}> by <@${task.trackedBy}>`
    : "*Tracked task:* _None yet. Discuss it in this thread, then send `@LUMA track` here._";
  return {
    text: `Requirement: ${requirement.title}`,
    blocks: [
      { type: "section", text: mrkdwn(`*:memo: ${escapeSlack(requirement.title)}*`) },
      { type: "section", text: mrkdwn(details) },
      { type: "section", text: mrkdwn(tracked) },
      { type: "context", elements: [mrkdwn(`Started by <@${requirement.createdBy}>`)] },
    ],
    metadata: {
      event_type: REQUIREMENT_EVENT_TYPE,
      event_payload: {
        title: requirement.title,
        status: requirement.status,
        priority: requirement.priority ?? "",
        due_date: requirement.dueDate ?? "",
        created_by: requirement.createdBy,
        // The task most recently tracked from the thread.
        task_channel: requirement.task?.channel ?? "",
        task_ts: requirement.task?.ts ?? "",
        task_title: requirement.task?.title ?? "",
        task_link: requirement.task?.link ?? "",
        tracked_by: requirement.task?.trackedBy ?? "",
      },
    },
  };
}

// Returns the requirement whose root message is `ts`, or null if it is not one.
export async function loadRequirement(env, channel, ts) {
  const { messages = [] } = await callSlack(env, "conversations.replies", {
    channel,
    ts,
    limit: 1,
    include_all_metadata: true,
  });
  const root = messages[0];
  if (root?.ts !== ts || root.metadata?.event_type !== REQUIREMENT_EVENT_TYPE) {
    return null;
  }

  const payload = root.metadata.event_payload;
  return {
    title: payload.title,
    status: payload.status,
    priority: payload.priority ?? "",
    dueDate: payload.due_date ?? "",
    createdBy: payload.created_by,
    task: payload.task_ts
      ? {
          channel: payload.task_channel,
          ts: payload.task_ts,
          title: payload.task_title,
          link: payload.task_link,
          trackedBy: payload.tracked_by,
        }
      : undefined,
  };
}

export async function saveRequirement(env, channel, ts, requirement) {
  await callSlack(env, "chat.update", { channel, ts, ...requirementMessage(requirement) });
  console.log("Requirement saved", { ts, status: requirement.status });
}

// Updates the requirement a task was tracked from, if it was. `change` gets
// the requirement and returns its new state, or null to leave it. The root
// message is a summary, so failures are logged rather than failing the command.
export async function updateRequirement(env, source, change) {
  if (!source?.requirement) return;
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
export async function findDetails(env, channel, threadTs) {
  if (tasksChannelFor(env, channel) === channel) {
    const task = await loadTask(env, channel, threadTs);
    if (!task) return null;
    const kind = task.source?.requirement ? "client" : "task";
    return { kind, channel, ts: threadTs, item: task };
  }

  const requirement = await loadRequirement(env, channel, threadTs);
  if (!requirement) return null;
  const found = { kind: "requirement", channel, ts: threadTs, item: requirement };
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
