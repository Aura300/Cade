import { callSlack, escapeSlack, mentions, mrkdwn } from "./slack.js";

// Task details live in the root message's metadata, so assignments can be
// updated without a separate datastore.
const TASK_EVENT_TYPE = "luma_task";

// Slack cannot colour text, so each value is shown with a coloured emoji.
export const PRIORITIES = {
  Urgent: ":red_circle:",
  High: ":large_orange_circle:",
  Medium: ":large_yellow_circle:",
  Low: ":large_green_circle:",
};

export const STATUSES = {
  TODO: ":white_circle: To do",
  IN_PROGRESS: ":large_blue_circle: In progress",
  IN_REVIEW: ":large_purple_circle: In review",
  IN_TESTING: ":large_orange_circle: In testing",
  CLIENT_REVIEW: ":large_yellow_circle: Client review",
  DONE: ":white_check_mark: Done",
};

// Each task has a list of people per role; the keys are what people type in
// `@LUMA assign developer @person`.
export const ROLES = {
  developer: "Developer",
  reviewer: "Reviewer",
  tester: "Tester",
};

export const NOT_A_TASK = "This thread is not a tracked task.";

// Returns the first role named in `text` ("developers" works too), or null.
export function parseRole(text) {
  const words = text.toLowerCase().split(/\s+/).filter((word) => !word.startsWith("<@"));
  return words.map((word) => word.replace(/s$/, "")).find((word) => ROLES[word]) ?? null;
}

export function noPeople() {
  return Object.fromEntries(Object.keys(ROLES).map((role) => [role, []]));
}

export function taskMessage(task) {
  const from = task.source?.link ? ` from <${task.source.link}|the request thread>` : "";
  // Four lines: the title, the task's details, who works on it, then who
  // tracked it and how to update it.
  const details = [
    `*Status:* ${STATUSES[task.status]}`,
    `*Priority:* ${PRIORITIES[task.priority]} ${task.priority}`,
    `*Due:* ${task.dueDate || "_None_"}`,
  ].join("  ·  ");
  const people = Object.entries(ROLES)
    .map(([role, label]) => {
      const ids = task.people[role];
      return `*${label}:* ${ids.length ? mentions(ids) : "_Unassigned_"}`;
    })
    .join("  ·  ");
  return {
    text: `${task.priority} task: ${task.title}`,
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(task.title)}*`) },
      { type: "section", text: mrkdwn(details) },
      { type: "section", text: mrkdwn(people) },
      {
        type: "context",
        elements: [
          mrkdwn(
            `Tracked by <@${task.createdBy}>${from} · reply here with \`@LUMA assign developer @person\`, \`@LUMA status\` or \`@LUMA help\``,
          ),
        ],
      },
    ],
    metadata: {
      event_type: TASK_EVENT_TYPE,
      event_payload: {
        title: task.title,
        priority: task.priority,
        status: task.status,
        due_date: task.dueDate,
        developers: task.people.developer.join(","),
        reviewers: task.people.reviewer.join(","),
        testers: task.people.tester.join(","),
        created_by: task.createdBy,
        // The external thread the task was tracked from, for the
        // announcement when it is deleted.
        source_channel: task.source?.channel ?? "",
        source_thread_ts: task.source?.threadTs ?? "",
        source_link: task.source?.link ?? "",
      },
    },
  };
}

// Returns the task whose root message is `ts`, or null if it is not a task.
export async function loadTask(env, channel, ts) {
  const { messages = [] } = await callSlack(env, "conversations.replies", {
    channel,
    ts,
    limit: 1,
    include_all_metadata: true,
  });
  const root = messages[0];
  if (root?.ts !== ts || root.metadata?.event_type !== TASK_EVENT_TYPE) {
    return null;
  }

  const payload = root.metadata.event_payload;
  return {
    title: payload.title,
    priority: payload.priority,
    status: payload.status,
    dueDate: payload.due_date ?? "",
    people: {
      // Tasks tracked before roles existed stored everyone as `assignees`;
      // they are treated as developers.
      developer: list(payload.developers ?? payload.assignees),
      reviewer: list(payload.reviewers),
      tester: list(payload.testers),
    },
    createdBy: payload.created_by,
    // Tasks tracked before the source thread was stored have none.
    source: payload.source_channel
      ? {
          channel: payload.source_channel,
          threadTs: payload.source_thread_ts,
          link: payload.source_link || undefined,
        }
      : undefined,
  };
}

export async function saveTask(env, channel, ts, task) {
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  console.log("Task saved", { ts, people: task.people });
}

function list(value) {
  return value ? value.split(",") : [];
}

// Open tasks are pinned in the dev channel; done tasks are unpinned. Pinning
// is a convenience, so failures are logged rather than failing the command.
export async function setPinned(env, channel, ts, pinned) {
  const method = pinned ? "pins.add" : "pins.remove";
  try {
    await callSlack(env, method, { channel, timestamp: ts });
  } catch (error) {
    if (/already_pinned|no_pin/.test(error.message)) return;
    console.warn("Could not update pin", { ts, pinned, error: error.message });
  }
}

// Turns the date picker's YYYY-MM-DD into DD/MM/YYYY ("" when there is none).
export function formatDueDate(selectedDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selectedDate ?? "");
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}
