import { tasksChannelFor } from "./channels.js";
import { callSlack, escapeSlack, mrkdwn } from "./slack.js";
import { PRIORITIES, STATUSES, loadTask, saveTask } from "./tasks.js";

// A requirement is a root message Luma posts in an external channel for
// `/luma requirement`; its thread is where the requirement is discussed. Like
// tasks, its details live in the root message's metadata.
const REQUIREMENT_EVENT_TYPE = "luma_requirement";

// A requirement is in discussion until a task is tracked from its thread.
// After that it shows In progress, then the task statuses the dev channel
// informs the thread of.
export const REQUIREMENT_STATUSES = {
  DISCUSSION: ":speech_balloon: In discussion",
  ...STATUSES,
};

export const NOT_A_TRACKED_REQUIREMENT =
  "This thread is not a requirement with a tracked task. Use `/luma requirement` to start one, then `@LUMA track` in its thread.";

export function requirementMessage(requirement) {
  // Three lines, then who started it: the requirement; its status, priority
  // and due date (taken from the task once one is tracked); then the task.
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

// Finds the task a thread is about: the task itself in a tasks channel, or
// the task tracked from a requirement thread in an external channel. Returns
// { channel, ts, task } or null.
export async function findTask(env, channel, threadTs) {
  if (tasksChannelFor(env, channel) === channel) {
    const task = await loadTask(env, channel, threadTs);
    return task && { channel, ts: threadTs, task };
  }
  const requirement = await loadRequirement(env, channel, threadTs);
  if (!requirement?.task) return null;
  const { channel: taskChannel, ts } = requirement.task;
  const task = await loadTask(env, taskChannel, ts);
  return task && { channel: taskChannel, ts, task };
}

// Saves a task's priority or due date on the task and on its requirement.
export async function saveTaskDetails(env, { channel, ts, task }) {
  await saveTask(env, channel, ts, task);
  await reflectOnRequirement(env, ts, task, {
    priority: task.priority,
    dueDate: task.dueDate,
  });
}
