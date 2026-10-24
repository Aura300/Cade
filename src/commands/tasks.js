import { channelPairs, findPair } from "../channels.js";
import { callSlack, escapeSlack, mrkdwn, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, loadTask, taskFromMessage } from "../tasks.js";

// What each role is doing, as the list's headings.
const DOING = {
  developer: "Developing",
  reviewer: "Reviewing",
  tester: "Testing",
};

// A section's text can hold 3,000 characters, so long lists are cut short.
const MAX_LISTED = 15;

// `/luma tasks` in any channel lists the open tasks you are assigned to, by
// group (channel pair): each group's dev channel's and incidents channel's.
// They are grouped by your role (developing, reviewing, testing), incidents
// first, then by priority and due date, each linking to its thread. Done
// tasks are left out.
//
// In a group's channel the list shows that group; elsewhere it shows every
// group. `/luma tasks aura300` shows the group named. The list is shown only
// to you, in the channel you asked in, and is not kept: ask again for a fresh
// one. (Slack does not allow slash commands in threads.)
export default {
  name: "tasks",
  description: "Show your open tasks by role, only to you",
  slashUsage: "/luma tasks",
  async slash(command, context) {
    const groups = findGroups(context.env, command);
    if (!groups) return askForGroup(context.env, command.text);
    // Reading the channels can take longer than Slack waits for a slash
    // command's answer, so the list follows through its response_url.
    context.waitUntil(
      (async () => respondLater(command.responseUrl, await taskLists(context.env, command.user, groups)))(),
    );
  },
};

// The group named in the command, ignoring case; else the channel's group;
// else every group. Null when the name is not a group.
function findGroups(env, command) {
  const name = command.text.trim().split(/\s+/)[0]?.toLowerCase();
  const pairs = channelPairs(env);
  if (name) {
    const named = pairs.find((pair) => pair.name.toLowerCase() === name);
    return named ? [named] : null;
  }
  const own = findPair(env, command.channel);
  return own ? [own] : pairs;
}

function askForGroup(env, text) {
  const names = channelPairs(env).map((pair) => `\`/luma tasks ${pair.name}\``);
  return `"${escapeSlack(text.trim())}" is not a group. Use ${names.join(" or ")}.`;
}

// One list per group, one after the other.
async function taskLists(env, user, groups) {
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const lists = await Promise.all(groups.map((group) => taskList(env, user, group, url)));
  return {
    text: lists.map((list) => list.text).join(" "),
    blocks: lists.flatMap((list, i) => (i ? [{ type: "divider" }, ...list.blocks] : list.blocks)),
  };
}

async function taskList(env, user, group, url) {
  const tasks = await assignedTasks(env, user, group, url);
  const header = { type: "header", text: { type: "plain_text", text: `Your ${group.name} tasks` } };
  if (!tasks.length) {
    const text = `You have no open ${group.name} tasks.`;
    return { text, blocks: [header, { type: "section", text: mrkdwn("You have no open tasks.") }] };
  }

  const blocks = [header];
  for (const role of Object.keys(ROLES)) {
    const mine = tasks.filter((entry) => entry.roles.includes(role)).sort(byUrgency);
    const lines = mine.slice(0, MAX_LISTED).map(line);
    if (mine.length > MAX_LISTED) lines.push(`_…and ${mine.length - MAX_LISTED} more._`);
    blocks.push({
      type: "section",
      text: mrkdwn(
        `*${DOING[role]}${mine.length ? ` (${mine.length})` : ""}*\n${lines.join("\n") || "_Nothing assigned._"}`,
      ),
    });
  }
  const count = `${tasks.length} open ${group.name} ${tasks.length === 1 ? "task" : "tasks"}`;
  return { text: `You have ${count}.`, blocks };
}

function line({ task, link, incident }) {
  const label = incident ? "*Incident:* " : "";
  return [
    `• ${label}<${link}|${escapeSlack(task.title)}>`,
    STATUSES[task.status],
    `${PRIORITIES[task.priority]} ${task.priority}`,
    `Due ${task.dueDate || "_none_"}`,
  ].join("  ·  ");
}

// Incidents first, then by priority, then the soonest due date. "Immediate"
// is the soonest; no due date is the latest.
function byUrgency(a, b) {
  const order = Object.keys(PRIORITIES);
  return (
    Number(b.incident) - Number(a.incident) ||
    order.indexOf(a.task.priority) - order.indexOf(b.task.priority) ||
    dueOrder(a.task.dueDate) - dueOrder(b.task.dueDate)
  );
}

function dueOrder(dueDate) {
  if (dueDate === "Immediate") return -Infinity;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? Date.UTC(match[3], match[2] - 1, match[1]) : Infinity;
}

// Returns the open tasks `user` is assigned to, as { task, roles, link,
// incident }, from the group's tasks and incidents channels. Open
// tasks are the pinned ones, since Luma unpins a task when it is Done, so
// only pins are read. A task someone unpinned by hand is left out.
// Links are built from the workspace's address, `url`, rather than looked up
// one by one, which would take a Slack call per task.
async function assignedTasks(env, user, group, url) {
  const channels = [
    { channel: group.tasks, incident: false },
    ...(group.incidents ? [{ channel: group.incidents, incident: true }] : []),
  ];
  const found = await Promise.all(channels.map((place) => tasksIn(env, place, user, url)));
  return found.flat();
}

async function tasksIn(env, { channel, incident }, user, url) {
  const { items = [] } = await callSlack(env, "pins.list", { channel });
  const pinned = items.map((item) => item.message).filter(Boolean);
  const tasks = await Promise.all(
    // A pin may not carry the task's details; then the task is loaded.
    pinned.map(async (message) => ({
      ts: message.ts,
      task: taskFromMessage(message) ?? (await loadTask(env, channel, message.ts)),
    })),
  );

  const found = [];
  for (const { ts, task } of tasks) {
    if (!task || task.status === "DONE") continue;
    const roles = Object.keys(ROLES).filter((role) => task.people[role].includes(user));
    if (!roles.length) continue;
    // Opens the task's thread, not just its message.
    const link = `${url}archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;
    found.push({ task, roles, link, incident });
  }
  return found;
}
