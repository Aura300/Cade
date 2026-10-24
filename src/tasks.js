import { pairFor } from "./channels.js";
import { formatTime, sendRow, sheetEnabled, userNames } from "./sheet.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText } from "./slack.js";

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
  let thread = "the request thread";
  if (task.source?.incident) thread = "the incident thread";
  else if (task.source?.requirement) thread = "the requirement thread";
  const from = task.source?.link ? ` from <${task.source.link}|${thread}>` : "";
  // The title, the task's details, who works on it, its linked pull requests
  // (when it has any), then who tracked it.
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
      ...(task.prs?.length
        ? [{ type: "section", text: mrkdwn(`*PRs:* ${task.prs.map(prLink).join(", ")}`) }]
        : []),
      {
        type: "context",
        elements: [
          mrkdwn(
            `Tracked by <@${task.createdBy}>${from}`,
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
        // Linked pull requests' addresses, comma separated.
        prs: (task.prs ?? []).join(","),
        created_by: task.createdBy,
        // When the task was last set to DONE, as an ISO timestamp.
        completed_at: task.completedAt ?? "",
        // The external thread the task was tracked from, for the
        // announcement when it is deleted.
        source_channel: task.source?.channel ?? "",
        source_thread_ts: task.source?.threadTs ?? "",
        source_link: task.source?.link ?? "",
        // "true" when the source thread is a requirement started with
        // `/luma requirement`, whose root message follows the task.
        source_requirement: task.source?.requirement ? "true" : "",
        // "true" when that requirement is an incident.
        source_incident: task.source?.incident ? "true" : "",
      },
    },
  };
}

// Pull request addresses on GitHub, GitLab and Bitbucket: the repository's
// name and the request's number.
const PULL_REQUEST = /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+?([^/\s]+)\/(?:pull|-\/merge_requests|pull-requests)\/(\d+)\b/;

// Returns { url, repo, number } for a pull request address, or null. `url`
// is the request's own address, without a tab such as /files after it.
export function parsePullRequest(url) {
  const match = PULL_REQUEST.exec(url);
  return match ? { url: match[0], repo: match[1], number: match[2] } : null;
}

// A pull request as reponame/number, linking to it.
export function prLink(url) {
  const pr = parsePullRequest(url);
  return pr ? `<${url}|${escapeSlack(pr.repo)}/${pr.number}>` : `<${url}>`;
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
  return root?.ts === ts ? taskFromMessage(root) : null;
}

// Returns the task a root message holds, or null if it is not a task. The
// message must have been read with include_all_metadata.
export function taskFromMessage(message) {
  // Some methods, such as pins.list, return a message's metadata type without
  // its payload; such a message has to be loaded to read the task.
  const payload = message.metadata?.event_payload;
  if (message.metadata?.event_type !== TASK_EVENT_TYPE || !payload) return null;

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
    prs: list(payload.prs),
    createdBy: payload.created_by,
    completedAt: payload.completed_at ?? "",
    // Tasks tracked before the source thread was stored have none.
    source: payload.source_channel
      ? {
          channel: payload.source_channel,
          threadTs: payload.source_thread_ts,
          link: payload.source_link || undefined,
          requirement: payload.source_requirement === "true",
          incident: payload.source_incident === "true",
        }
      : undefined,
  };
}

export async function saveTask(env, channel, ts, task) {
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  console.log("Task saved", { ts, people: task.people });
  await syncTask(env, channel, ts, task);
}

// Records the task's current state in the Google Sheet. The sheet is a
// record, so failures are logged rather than failing the command.
export async function syncTask(env, channel, ts, task, { deleted = false } = {}) {
  if (!sheetEnabled(env)) return;
  try {
    const { permalink } = await callSlack(env, "chat.getPermalink", {
      channel,
      message_ts: ts,
    });
    const names = (ids) => (ids.length ? userNames(env, ids) : "Unassigned");
    await sendRow(env, pairFor(env, channel).name, {
      "Task ID": `${channel}:${ts}`,
      Title: task.title,
      Status: deleted ? "Deleted" : statusName(task.status),
      Priority: task.priority,
      "Due date": task.dueDate,
      Developer: await names(task.people.developer),
      Reviewer: await names(task.people.reviewer),
      Tester: await names(task.people.tester),
      "Tracked by": await userNames(env, [task.createdBy]),
      // A Slack message timestamp is the time it was posted.
      "Tracked at": formatTime(env, new Date(Number(ts) * 1000)),
      "Completed at": task.completedAt ? formatTime(env, new Date(task.completedAt)) : "",
      "Task link": deleted ? "" : permalink,
      "Request link": task.source?.link ?? "",
    });
    console.log("Task synced to sheet", { ts, status: task.status, deleted });
  } catch (error) {
    console.warn("Could not sync task to sheet", { ts, error: error.message });
  }
}

// The status label without its emoji, for the sheet.
export function statusName(status) {
  return STATUSES[status].replace(/^:[a-z0-9_+-]+:\s*/, "");
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

// The title, due date and priority fields shared by the task and requirement
// forms. `initial` fills them in: { title, dueDate (DD/MM/YYYY), priority }.
// Without `details` the form asks only for the title, for a task whose
// priority and due date come from its requirement.
export function taskFormBlocks(titleLabel, initial = {}, { details = true } = {}) {
  const option = (priority) => ({
    text: { ...plainText(`${PRIORITIES[priority]} ${priority}`), emoji: true },
    value: priority,
  });
  const title = {
    type: "input",
    block_id: "title",
    label: plainText(titleLabel),
    element: {
      type: "plain_text_input",
      action_id: "value",
      max_length: 150,
      initial_value: initial.title?.slice(0, 150) || undefined,
    },
  };
  if (!details) return [title];
  return [
    title,
    {
      type: "input",
      block_id: "due_date",
      optional: true,
      label: plainText("Due date"),
      element: {
        type: "datepicker",
        action_id: "value",
        placeholder: plainText("Select a date"),
        initial_date: pickerDate(initial.dueDate),
      },
    },
    {
      type: "input",
      block_id: "priority",
      label: plainText("Priority"),
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: plainText("Select a priority"),
        options: Object.keys(PRIORITIES).map(option),
        initial_option: PRIORITIES[initial.priority] ? option(initial.priority) : undefined,
      },
    },
  ];
}

// Reads the fields from taskFormBlocks. `errors` is keyed by block_id, as a
// modal's response_action "errors" expects, or null when there are none. A
// form without details gives no priority or due date.
export function readTaskForm(values, titleError) {
  const title = values.title.value.value?.trim() ?? "";
  // The date picker gives YYYY-MM-DD, or null when no date was chosen.
  const dueDate = formatDueDate(values.due_date?.value.selected_date);
  const priority = values.priority?.value.selected_option?.value;

  const errors = {};
  if (!title) errors.title = titleError;
  if (values.priority && !PRIORITIES[priority]) errors.priority = "Select a priority.";
  return { title, dueDate, priority, errors: Object.keys(errors).length ? errors : null };
}

// Turns DD/MM/YYYY back into the date picker's YYYY-MM-DD (undefined when
// there is none).
export function pickerDate(dueDate) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

// Turns the date picker's YYYY-MM-DD into DD/MM/YYYY ("" when there is none).
export function formatDueDate(selectedDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selectedDate ?? "");
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}
