import { channelPairs } from "./channels.js";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.js";
import { formatTime } from "./sheet.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText } from "./slack.js";
import { PRIORITIES, ROLES, STATUSES } from "./tasks.js";

// The Home tab of Cade's app: what the person has open, by what they do on
// it, most urgent first. It is only another view of the tasks Cade already
// stores, drawn when they open it or press Refresh.

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
export const REFRESH_ACTION = "home:refresh";

// Draws `user`'s Home tab.
export async function publishHome(env, user) {
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user) });
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

  const waiting = sections.reduce((sum, section) => sum + section.ready.length, 0);
  const summary = waiting
    ? `*${waiting}* waiting on you${overdue.size ? `  ·  :warning: *${overdue.size}* overdue` : ""}`
    : "You're all caught up :tada:";

  const blocks = [
    { type: "header", text: plainText("Your tasks") },
    { type: "context", elements: [mrkdwn(summary)] },
    { type: "actions", elements: [{ type: "button", action_id: REFRESH_ACTION, text: plainText("Refresh") }] },
  ];
  for (const section of sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "header", text: { type: "plain_text", text: `${section.emoji} ${section.title} (${section.ready.length})`, emoji: true } });
    blocks.push(...list(section, today, showGroup, user));
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A section's tasks: those waiting on the person as cards, most urgent
// first, then the rest as small lines.
function list({ role, ready, later, empty }, today, showGroup, user) {
  const blocks = [];
  if (!ready.length) blocks.push({ type: "context", elements: [mrkdwn(`_${empty}_`)] });
  blocks.push(...ready.slice(0, MAX_READY).map((entry) => card(entry, role, today, showGroup, user)));
  if (ready.length > MAX_READY) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${ready.length - MAX_READY} more._`)] });
  }
  if (later.length) {
    const lines = later.slice(0, MAX_LATER).map(({ task, link }) => `<${link}|${escapeSlack(task.title)}>  ·  ${STATUSES[task.status]}`);
    if (later.length > MAX_LATER) lines.push(`_…and ${later.length - MAX_LATER} more._`);
    blocks.push({ type: "context", elements: [mrkdwn(`*Coming up*\n${lines.join("\n")}`)] });
  }
  return blocks;
}

// A task as a card: its priority and title, then its status, when it is due
// and who else is on it, with a button to its thread. The button's id names
// the section too, as a task is listed under each role the person has on it.
function card({ ts, channel, task, link, incident, group }, role, today, showGroup, user) {
  const title = `${incident ? ":rotating_light:" : (PRIORITIES[task.priority] ?? ":white_circle:")} *${escapeSlack(task.title)}*`;
  const due = task.dueDate && (isOverdue(task, today) ? `:warning: *Overdue* ${task.dueDate}` : `Due ${task.dueDate}`);
  const others = [...new Set(Object.keys(ROLES).flatMap((one) => task.people[one]))].filter((id) => id !== user);
  const details = [STATUSES[task.status], due, others.length && mentions(others), showGroup && group].filter(Boolean).join("  ·  ");
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
