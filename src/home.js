import { channelPairs } from "./channels.js";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.js";
import { formatTime } from "./sheet.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.js";
import { PRIORITIES, ROLES, STATUSES } from "./tasks.js";

// The Home tab of Cade's app: what the person has open, by what they do on
// it, most urgent first. It is only another view of the tasks Cade already
// stores, drawn when they open it, and again for the people on a task when
// who works on it, its status, priority or due date changes (see refreshHomes).

// What each role is doing, and the statuses in which the task is waiting on
// them. Tasks in other statuses are theirs but not yet, and are listed
// after the ones to act on.
const SECTIONS = [
  { role: "owner", emoji: ":hammer_and_wrench:", title: "To work on", ready: ["TODO", "IN_PROGRESS"], empty: "Nothing to work on." },
  { role: "reviewer", emoji: ":eyes:", title: "To review", ready: ["IN_REVIEW"], empty: "Nothing to review." },
  { role: "tester", emoji: ":test_tube:", title: "To test", ready: ["IN_TESTING"], empty: "Nothing to test." },
];

// A view holds 100 blocks and each task takes one, so long lists are cut
// short.
const MAX_READY = 15;
const MAX_LATER = 5;

// A button that opens a task's thread. Slack still sends its click to
// Cade, which has nothing to do (see handleInteraction).
export const OPEN_ACTION = "home:open";

// Draws `user`'s Home tab.
export async function publishHome(env, user) {
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user) });
}

// Redraws the Home tab of the people a change to a task touches, if it
// touches them: `before` and `after` are the task as it was and as it is,
// either null for a task that is new or gone. A task's people changing
// redraws those it had and those it has; its status, priority or due date
// changing, those it has. Other changes, such as its title, leave the tab
// as it is. It is a convenience, so failures are logged rather than failing
// the change.
export async function refreshHomes(env, before, after) {
  const users = homeUsers(before, after);
  await Promise.all(
    users.map((user) =>
      publishHome(env, user).catch((error) => console.warn("Could not update the Home tab", { user, error: error.message })),
    ),
  );
}

// The people whose Home tab the change from `before` to `after` touches.
export function homeUsers(before, after) {
  const people = (task) => (task ? [...new Set(Object.keys(ROLES).flatMap((role) => task.people[role]))] : []);
  const was = people(before);
  const is = people(after);
  const peopleChanged = Object.keys(ROLES).some((role) => {
    const a = before?.people[role] ?? [];
    const b = after?.people[role] ?? [];
    return a.length !== b.length || a.some((id) => !b.includes(id));
  });
  if (!before || !after || peopleChanged) return [...new Set([...was, ...is])];
  // What the tab shows of a task: where it is, how urgent and when due.
  const shown = ["status", "priority", "dueDate"];
  return shown.some((field) => before[field] !== after[field]) ? is : [];
}

export async function homeView(env, user) {
  const { url } = await callSlack(env, "auth.test", {});
  const groups = channelPairs(env);
  const entries = (await Promise.all(groups.map((group) => groupTasks(env, group, OPEN, url))))
    .flatMap((found, i) => found.map((entry) => ({ ...entry, group: groups[i].name })))
    .filter((entry) => Object.keys(ROLES).some((role) => entry.task.people[role].includes(user)));
  const today = todayIn(env);
  const showGroup = groups.length > 1;

  const sections = SECTIONS.map((section) => {
    const theirs = entries.filter((entry) => entry.task.people[section.role].includes(user)).sort(byUrgency);
    return {
      ...section,
      ready: theirs.filter((entry) => section.ready.includes(entry.task.status)),
      later: theirs.filter((entry) => !section.ready.includes(entry.task.status)),
    };
  });
  const overdue = new Set(entries.filter((entry) => isOverdue(entry.task, today)).map((entry) => entry.ts + entry.channel));

  const counts = sections.map((section) => `*${section.ready.length}* ${section.title.toLowerCase()}`);
  const status = [counts.join("  ·  "), overdue.size ? `:warning: *${overdue.size}* overdue` : ""].filter(Boolean).join("  ·  ");

  const blocks = [
    { type: "header", text: plainText("Your tasks") },
    { type: "context", elements: [mrkdwn(status)] },
  ];
  for (const section of sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "header", text: { type: "plain_text", text: `${section.emoji} ${section.title} (${section.ready.length})`, emoji: true } });
    blocks.push(...list(section, today, showGroup));
  }
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [mrkdwn(`Updated ${formatTime(env, new Date())}  ·  \`/cade tasks\` filters by status and due date, or shows someone else's.`)],
  });
  return { type: "home", blocks };
}

// A section's tasks: those to act on, most urgent first, then those coming
// up.
function list({ role, ready, later, empty, emoji }, today, showGroup) {
  const blocks = [];
  if (!ready.length) blocks.push({ type: "section", text: mrkdwn(`_${empty}_ :tada:`) });
  blocks.push(...ready.slice(0, MAX_READY).map((entry) => card(entry, role, today, showGroup)));
  if (ready.length > MAX_READY) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${ready.length - MAX_READY} more to do._`)] });
  }
  if (later.length) {
    blocks.push({ type: "context", elements: [mrkdwn(`${emoji} *Coming up* (${later.length}): yours, but not waiting on you yet`)] });
    blocks.push(...later.slice(0, MAX_LATER).map((entry) => card(entry, role, today, showGroup)));
    if (later.length > MAX_LATER) blocks.push({ type: "context", elements: [mrkdwn(`_…and ${later.length - MAX_LATER} more._`)] });
  }
  return blocks;
}

// A task as a block: two lines, its priority and title, then where it is,
// and a button to its thread. The button's id names the section too, as a
// task is listed under each role the person has on it.
function card({ ts, channel, task, link, incident, group }, role, today, showGroup) {
  const title = `${incident ? ":rotating_light: *Incident:* " : `${PRIORITIES[task.priority] ?? ":white_circle:"} `}*${escapeSlack(task.title)}*`;
  const due = task.dueDate ? `Due ${task.dueDate}${isOverdue(task, today) ? " :warning: *overdue*" : ""}` : "_No due date_";
  const details = [STATUSES[task.status], due, showGroup ? group : ""].filter(Boolean).join("  ·  ");
  return {
    type: "section",
    text: mrkdwn(`${title}\n${details}`),
    accessory: {
      type: "button",
      action_id: `${OPEN_ACTION}:${role}:${channel}:${ts}`,
      text: plainText("Open thread"),
      url: link,
    },
  };
}

// Whether the task's due date has passed. An incident, due Immediate, never
// has.
function isOverdue(task, today) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
  return Boolean(match) && `${match[3]}-${match[2]}-${match[1]}` < today;
}
