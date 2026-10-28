import { channelPairs } from "./channels.js";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.js";
import { formatTime } from "./sheet.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.js";
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

// A view holds 100 blocks and each task takes two, so long lists are cut
// short.
const MAX_READY = 12;
const MAX_LATER = 5;

export const REFRESH_ACTION = "home:refresh";

// Draws `user`'s Home tab.
export async function publishHome(env, user) {
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user) });
}

export async function homeView(env, user) {
  const { url } = await callSlack(env, "auth.test", {});
  const groups = channelPairs(env);
  const entries = (await Promise.all(groups.map((group) => groupTasks(env, group, OPEN, url))))
    .flat()
    .filter((entry) => Object.keys(ROLES).some((role) => entry.task.people[role].includes(user)));
  const today = todayIn(env);

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
    blocks.push(...list(section, today));
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A section's tasks: those waiting on the person as cards, most urgent
// first, then the rest as small lines.
function list({ ready, later, empty }, today) {
  const blocks = [];
  if (!ready.length) blocks.push({ type: "context", elements: [mrkdwn(`_${empty}_`)] });
  blocks.push(...ready.slice(0, MAX_READY).flatMap((entry) => card(entry, today)));
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

// A task as a card, in two blocks: its title, linking to its thread, then
// its priority, status and due date in the smaller type of a context block.
// The title has no button beside it, which would leave a gap under it.
function card({ task, link, incident }, today) {
  const title = `${incident ? ":rotating_light: " : ""}*<${link}|${escapeSlack(task.title)}>*`;
  const due = task.dueDate && (isOverdue(task, today) ? `:warning: *Overdue* ${task.dueDate}` : `Due ${task.dueDate}`);
  const details = [`${PRIORITIES[task.priority] ?? ""} ${task.priority}`.trim(), STATUSES[task.status], due].filter(Boolean).join("  ·  ");
  return [
    { type: "section", text: mrkdwn(title) },
    // The blank last line (a braille blank, as Slack trims plain ones) puts
    // a gap before the next card.
    { type: "context", elements: [mrkdwn(`${details}\n\u2800`)] },
  ];
}

// Whether the task's due date has passed. An incident, due Immediate, never
// has.
function isOverdue(task, today) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
  return Boolean(match) && `${match[3]}-${match[2]}-${match[1]}` < today;
}
