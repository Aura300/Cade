import { channelPairs } from "./channels.js";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.js";
import { formatTime } from "./sheet.js";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.js";
import { PRIORITIES, peopleLine, ROLES, STATUSES } from "./tasks.js";

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

// Assign to me, on an unassigned task's card. Each card's button has its own
// id, ending in the task's channel and thread, as a view can't repeat one.
export const CLAIM_ACTION = "home:claim";

// The buttons along the top, each a view of the open tasks. Slack has no
// tabs in the Home tab, so a button draws the tab again with its view.
export const TABS = {
  mine: { action: "home:tab:mine", label: "My Tasks" },
  unassigned: { action: "home:tab:unassigned", label: "Unassigned" },
  all: { action: "home:tab:all", label: "All Tasks" },
};
const DEFAULT_TAB = "mine";

// The cards in the Unassigned and All Tasks views, two blocks each (three
// with the Assign to me button).
const MAX_LISTED = 20;

// Draws `user`'s Home tab, on the `tab` view.
export async function publishHome(env, user, tab = DEFAULT_TAB) {
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user, tab) });
}

export async function homeView(env, user, tab = DEFAULT_TAB) {
  if (!TABS[tab]) tab = DEFAULT_TAB;
  const { url } = await callSlack(env, "auth.test", {});
  const groups = channelPairs(env);
  const open = (await Promise.all(groups.map((group) => groupTasks(env, group, OPEN, url)))).flat();
  const today = todayIn(env);
  const tabs = {
    type: "actions",
    elements: [
      ...Object.entries(TABS).map(([name, { action, label }]) => ({
        type: "button",
        action_id: action,
        text: plainText(label),
        ...(name === tab && { style: "primary" }),
      })),
      { type: "button", action_id: REFRESH_ACTION, text: plainText("Refresh"), value: tab },
    ],
  };
  if (tab !== "mine") return listView(env, tab, tabs, open, today, user);

  const entries = open.filter((entry) => Object.keys(ROLES).some((role) => entry.task.people[role].includes(user)));

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
    tabs,
  ];
  for (const section of sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "header", text: { type: "plain_text", text: `${section.emoji} ${section.title} (${section.ready.length})`, emoji: true } });
    blocks.push(...list(section, today, user));
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// The Unassigned and All Tasks views: the open tasks as cards, most urgent
// first. Unassigned ones have an Assign to me button there, and only there.
function listView(env, tab, tabs, open, today, user) {
  const unassigned = tab === "unassigned";
  const entries = (unassigned ? open.filter((entry) => !Object.keys(ROLES).some((role) => entry.task.people[role].length)) : open).sort(byUrgency);
  const blocks = [
    { type: "header", text: plainText(unassigned ? "Unassigned tasks" : "All open tasks") },
    { type: "context", elements: [mrkdwn(`*${entries.length}* open`)] },
    tabs,
    { type: "divider" },
  ];
  if (!entries.length) blocks.push({ type: "context", elements: [mrkdwn(`_${unassigned ? "Everything open has someone on it." : "Nothing is open."}_`)] });
  blocks.push(...entries.slice(0, MAX_LISTED).flatMap((entry) => card(entry, today, user, unassigned)));
  if (entries.length > MAX_LISTED) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${entries.length - MAX_LISTED} more._`)] });
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A section's tasks: those waiting on the person as cards, most urgent
// first, then the rest as small lines.
function list({ ready, later, empty }, today, user) {
  const blocks = [];
  if (!ready.length) blocks.push({ type: "context", elements: [mrkdwn(`_${empty}_`)] });
  blocks.push(...ready.slice(0, MAX_READY).flatMap((entry) => card(entry, today, user)));
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
// its priority, status and due date, and below them its owner, reviewers and
// testers (as on the task's message), in the smaller type of a context block.
// The title has no button beside it, which would leave a gap under it.
function card({ task, link, incident, channel, ts }, today, viewer, claim = false) {
  const title = `${incident ? ":rotating_light: " : ""}*<${link}|${escapeSlack(task.title)}>*`;
  const due = task.dueDate && (isOverdue(task, today) ? `:warning: *Overdue* ${task.dueDate}` : `Due ${task.dueDate}`);
  const details = [`${PRIORITIES[task.priority] ?? ""} ${task.priority}`.trim(), STATUSES[task.status], due].filter(Boolean).join("  ·  ");
  const people = peopleLine(task, viewer) || "_Unassigned_";
  if (claim) {
    return [
      { type: "section", text: mrkdwn(title) },
      { type: "context", elements: [mrkdwn(`${details}\n${people}`)] },
      { type: "actions", elements: [{ type: "button", action_id: `${CLAIM_ACTION}:${channel}:${ts}`, text: plainText("Assign to me") }] },
    ];
  }
  return [
    { type: "section", text: mrkdwn(title) },
    // The blank last line (a braille blank, as Slack trims plain ones) puts
    // a gap before the next card.
    { type: "context", elements: [mrkdwn(`${details}\n${people}\n\u2800`)] },
  ];
}

// Whether the task's due date has passed. An incident, due Immediate, never
// has.
function isOverdue(task, today) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
  return Boolean(match) && `${match[3]}-${match[2]}-${match[1]}` < today;
}
