import { channelPairs, groupEnabled, pairFor } from "./channels.js";
import { getTask, putTask } from "./db.js";
import { formatTime, sendRow, sheetEnabled, userNames } from "./sheet.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText } from "./slack.js";

// Tasks are stored in D1 (see db.js). The root message in the tasks channel
// and the task's row in the Google Sheet are rendered from the stored task.

// Slack cannot colour text, so each value is shown with a coloured emoji
// in menus and lists. Task messages show the priority as the colour of the
// strip down their side instead, the same colours. Other
// values use emoji that aren't coloured circles, so they can't be taken
// for a priority.
export const PRIORITY_COLORS = {
  Urgent: "#E01E5A",
  High: "#F26A1B",
  Medium: "#F5D020",
  Low: "#2EB67D",
};

export const PRIORITIES = {
  Urgent: ":red_circle:",
  High: ":large_orange_circle:",
  Medium: ":large_yellow_circle:",
  Low: ":large_green_circle:",
};

export const STATUSES = {
  TODO: ":memo: To do",
  IN_PROGRESS: ":arrow_forward: In progress",
  IN_REVIEW: ":eyes: In review",
  IN_TESTING: ":test_tube: In testing",
  CLIENT_REVIEW: ":raising_hand: Client review",
  DONE: ":white_check_mark: Done",
};

// Each task has a list of people per role; the keys are what people type in
// `@Cade assign owner @person`. The owner does the work, whatever it is.
export const ROLES = {
  owner: "Owner",
  reviewer: "Reviewer",
  tester: "Tester",
};

// The roles as a task's card shows them, by who works on it.
const SHORT_ROLES = { owner: "Owner", reviewer: "Review", tester: "Test" };

export const NOT_A_TASK = "Hmm, I'm not tracking a task in this thread.";

// An incident is a task reported with `/cade incident`. It is always urgent
// and fixed as soon as possible, so its priority and due date never change.
export const INCIDENT = { priority: "Urgent", dueDate: "Immediate" };

export const INCIDENT_IS_FIXED =
  "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.";

// The task's pull requests that are pending: not sent for approval, nor
// approved.
export function unsentPrs(task) {
  const sent = new Set((task.releases ?? []).flatMap((release) => release.prs));
  return task.prs.filter((url) => !sent.has(url));
}

// The task's PRs for its card, a line each for those
// approved, pending approval and pending, leaving out the empty ones:
//   Approved: Login (cade/42, web/7) · Profile page (web/9)
//   Pending approval: Search (web/11)
//   Pending: web/12, web/13
// A PR goes from pending to pending approval, once sent with `@Cade
// release` (see release.js) and recorded in the task's `releases`, to
// approved by the client. Releases are named by what they complete; the
// labels say where each PR is, so PRs have no emoji. Once the task is Done,
// all of them are approved, with the PRs never sent as the rest of the
// task.
export function prLines(task) {
  const done = task.status === "DONE";
  const releases = task.releases ?? [];
  const group = (prs, note) => `${escapeSlack(note.replace(/\s+/g, " "))} (${prs.map(prLink).join(", ")})`;
  const groups = (status) =>
    releases.filter((release) => done || release.status === status).map((release) => group(release.prs, release.note));
  const approved = groups("APPROVED");
  const unsent = unsentPrs(task);
  if (done && unsent.length) approved.push(group(unsent, releases.length ? "The rest of the task" : "The task"));
  const awaiting = done ? [] : groups("PENDING_APPROVAL");
  const pending = done ? [] : unsent;
  return [
    approved.length && `*Approved:* ${approved.join("  ·  ")}`,
    awaiting.length && `*Pending approval:* ${awaiting.join("  ·  ")}`,
    pending.length && `*Pending:* ${pending.map(prLink).join(", ")}`,
  ].filter(Boolean);
}

// Other words for each role, besides its name: `@Cade assign dev @rex`, as
// owners were called developers before.
const ROLE_WORDS = { dev: "owner", developer: "owner", review: "reviewer", rev: "reviewer", test: "tester", qa: "tester" };

// Returns the first role named in `text` ("owners", "dev" and "qa" work
// too), or null.
export function parseRole(text) {
  const words = text.toLowerCase().split(/\s+/).filter((word) => !word.startsWith("<@"));
  return (
    words
      .map((word) => word.replace(/s$/, ""))
      .map((word) => ROLE_WORDS[word] ?? word)
      .find((word) => ROLES[word]) ?? null
  );
}

export function noPeople() {
  return Object.fromEntries(Object.keys(ROLES).map((role) => [role, []]));
}

// Who has each role on the task, as "Owner @a  ·  Review @b", leaving out
// roles with no one; empty if no one has any. `viewer`, if given, is
// written as "you".
export function peopleLine(task, viewer) {
  return Object.entries(SHORT_ROLES)
    .filter(([role]) => task.people[role].length)
    .map(([role, label]) => `${label} ${task.people[role].map((id) => (id === viewer ? "you" : `<@${id}>`)).join(", ")}`)
    .join("  ·  ");
}

export function taskMessage(task, { archivedBy } = {}) {
  // The title, led by its priority, then in small text its status and due date, its
  // linked pull requests (when it has any) by whether they're approved, and
  // who works on it and who tracked it. All but the title sit in an
  // attachment, whose strip down the side has the priority's colour. Roles
  // with no one are left out. An archived task's card says who archived it
  // in place of its status, and has no menu, as Cade no longer tracks it.
  const people = peopleLine(task);
  const card = [
    { type: "context", elements: [metaLine(archivedBy ? `:file_cabinet: Archived by <@${archivedBy}>` : STATUSES[task.status], task.dueDate)] },
    ...(task.prs?.length ? [smallText(prLines(task))] : []),
    smallText([people || "_Unassigned_", `${task.incident ? "Reported" : "Tracked"} by <@${task.createdBy}>`]),
  ];
  // Incidents share the dev channel with the rest of the work, so their
  // cards say which they are.
  const label = `[${task.priority.toUpperCase()}] ${task.incident ? "[Incident] " : ""}`;
  return {
    text: `${task.priority} ${task.incident ? "incident" : "task"}: ${task.title}`,
    blocks: [{ type: "section", text: mrkdwn(`${label}*${escapeSlack(task.title)}*`), ...(!archivedBy && { accessory: taskMenu(task) }) }],
    attachments: [{ color: PRIORITY_COLORS[task.priority], blocks: card }],
  };
}

// The ⋯ menu on a task's card, so people change it without typing a command
// in its thread (see menu.js): Edit, one form for everything; Release, while
// it has PRs not sent for approval; Refresh, to redraw the card; and
// Archive, when it's no longer needed (see archive.js).
export const TASK_MENU_ACTION = "task:menu";

function taskMenu(task) {
  const choices = [
    ["edit", "Edit"],
    task.prs?.length && unsentPrs(task).length && ["release", "Release"],
    ["refresh", "Refresh"],
    ["archive", "Archive"],
  ].filter(Boolean);
  return {
    type: "overflow",
    action_id: TASK_MENU_ACTION,
    options: choices.map(([value, text]) => ({ text: plainText(text), value })),
  };
}

// Lines of a card in small text, as its status line is. A context element
// holds up to 3,000 characters.
export function smallText(lines) {
  return { type: "context", elements: [mrkdwn(lines.join("\n").slice(0, 3000))] };
}

// A card's line under its title, in small text: the status and due date, leaving out those not set.
export function metaLine(status, dueDate) {
  return mrkdwn([status, dueDate && `Due ${dueDate}`].filter(Boolean).join("  ·  "));
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
  return getTask(env, channel, ts);
}

// Stores the task, then renders it to its root message, the Sheet and the
// summaries.
export async function saveTask(env, channel, ts, task) {
  await putTask(env, channel, ts, task);
  console.log("Task saved", { ts, people: task.people });
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  await syncTask(env, channel, ts, task);
  await refreshSummary(env, channel);
}

// Rewrites the summary a change in `channel` touches (see summary.js); with
// `create`, for a new task, making its canvas if it has none. It is
// imported when needed, as summary.js uses this module's exports when it
// loads. Only a group with `canvas` on (CANVAS for every group) has one.
export async function refreshSummary(env, channel, options) {
  if (!groupEnabled(env, channel, "canvas", "CANVAS")) return;
  const summary = await import("./summary.js");
  await summary.refreshSummary(env, channel, options);
}

// Records the task's current state in the Google Sheet. The sheet is a
// record, so failures are logged rather than failing the command.
export async function syncTask(env, channel, ts, task, { deleted = false, archived = false } = {}) {
  const group = pairFor(env, channel);
  if (!sheetEnabled(env, group)) return;
  try {
    // Tasks keep their link from when they were created; this is in case
    // looking it up failed then.
    if (!task.link && !deleted) {
      ({ permalink: task.link } = await callSlack(env, "chat.getPermalink", {
        channel,
        message_ts: ts,
      }));
      await putTask(env, channel, ts, task);
    }
    const names = (ids) => (ids.length ? userNames(env, ids) : "Unassigned");
    await sendRow(env, group, {
      "Task ID": `${channel}:${ts}`,
      Title: task.title,
      Status: deleted ? "Deleted" : archived ? "Archived" : statusName(task.status),
      Priority: task.priority,
      "Due date": task.dueDate,
      Owner: await names(task.people.owner),
      Reviewer: await names(task.people.reviewer),
      Tester: await names(task.people.tester),
      "Tracked by": await userNames(env, [task.createdBy]),
      // A Slack message timestamp is the time it was posted.
      "Tracked at": formatTime(env, new Date(Number(ts) * 1000)),
      "Completed at": task.completedAt ? formatTime(env, new Date(task.completedAt)) : "",
      "Task link": deleted ? "" : task.link,
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

// Open tasks are pinned in the dev channel; done tasks are unpinned. Pinning
// is a convenience, so failures are logged rather than failing the command.
// Only a group with `pinning` on (PINNING for every group) is pinned.
export async function setPinned(env, channel, ts, pinned) {
  if (!groupEnabled(env, channel, "pinning", "PINNING")) return;
  const method = pinned ? "pins.add" : "pins.remove";
  try {
    await callSlack(env, method, { channel, timestamp: ts });
  } catch (error) {
    if (/already_pinned|no_pin/.test(error.message)) return;
    console.warn("Could not update pin", { ts, pinned, error: error.message });
  }
}

// The title, due date and priority fields of the task form. `initial` fills
// them in: { title, dueDate (DD/MM/YYYY), priority }. Without `details` the
// form asks only for the title, for an incident, whose are fixed.
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
  if (values.priority && !PRIORITIES[priority]) errors.priority = "Please pick a priority.";
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

// The Project picker on forms opened outside a dev channel, such as from a
// message shortcut in a DM: each group by name, its value the group's dev
// channel. The only group is picked to begin with. With `actionId`,
// choosing one sends that action, for a form that changes with it.
export function projectBlock(env, { actionId, initial } = {}) {
  const groups = channelPairs(env);
  const option = (group) => ({ text: plainText(group.name.slice(0, 75)), value: group.tasks });
  const picked = groups.find((group) => group.tasks === initial) ?? (groups.length === 1 ? groups[0] : null);
  return {
    type: "input",
    block_id: "project",
    label: plainText("Project"),
    ...(actionId && { dispatch_action: true }),
    element: {
      type: "static_select",
      action_id: actionId ?? "value",
      placeholder: plainText("Choose a project"),
      options: groups.map(option),
      ...(picked && { initial_option: option(picked) }),
    },
  };
}

// The dev channel of the project chosen on a form, or undefined.
export function chosenProject(values) {
  return Object.values(values.project ?? {})[0]?.selected_option?.value;
}

// The approval forms' picker for who approves or rejects: the client, or
// whoever handles them.
export function approverBlock(initialUser) {
  return {
    type: "input",
    block_id: "approver",
    label: plainText("Who approves"),
    element: {
      type: "users_select",
      action_id: "value",
      placeholder: plainText("Choose a person"),
      ...(initialUser && { initial_user: initialUser }),
    },
  };
}

export function readApprover(values) {
  return values.approver?.value?.selected_user ?? null;
}

// Whether `payload`'s Approve or Not approve click came from someone other
// than `approver`, who alone decides; they are told so, privately. Buttons
// from before an approver was picked have none, and anyone may click them.
export async function notTheApprover(env, payload, approver) {
  if (!approver || payload.user.id === approver) return false;
  await callSlack(env, "chat.postEphemeral", {
    channel: payload.channel.id,
    thread_ts: payload.message.thread_ts,
    user: payload.user.id,
    text: `Only <@${approver}> can approve or reject this.`,
  });
  return true;
}
