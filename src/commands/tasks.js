import { channelPairs } from "../channels.js";
import { formatTime } from "../sheet.js";
import { callSlack, escapeSlack, mrkdwn } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, loadTask, taskFromMessage } from "../tasks.js";

// What each role is doing, as the list's headings.
const DOING = {
  developer: "Developing",
  reviewer: "Reviewing",
  tester: "Testing",
};

// A section's text can hold 3,000 characters, so long lists are cut short.
const MAX_LISTED = 15;

// `tasks aura300` in a direct message with Luma (or `@LUMA tasks aura300`
// anywhere, or `/luma tasks aura300`) lists the open tasks you are assigned
// to in that group, the channel pair of that name: its dev channel and its
// incidents channel. They are grouped by your role (developing, reviewing,
// testing), incidents first, then by priority and due date. Done tasks are
// left out.
//
// The list is always sent to your direct messages with Luma, rather than
// shown to a channel. Each group has one list there, pinned, saying when it
// was last updated: a new list for a group is posted at the end of the
// conversation and pinned, and that group's earlier list is deleted.
export default {
  name: "tasks",
  description: "List your open tasks in a group by role (sent to your messages with Luma)",
  usage: "@LUMA tasks aura300",
  slashUsage: "/luma tasks aura300",
  async run(command, { env }) {
    const group = findGroup(env, command.text);
    if (!group) return askForGroup(env, command.text);
    await sendTaskList(env, command.user, group);
    if (!command.direct) {
      return `<@${command.user}>, I sent your ${group.name} tasks to your messages with Luma.`;
    }
  },
  async slash(command, context) {
    const group = findGroup(context.env, command.text);
    if (!group) return askForGroup(context.env, command.text);
    // Reading the channels can take longer than Slack waits for a slash
    // command's answer, so the list follows in the background.
    context.waitUntil(sendTaskList(context.env, command.user, group));
    // Slash commands sent in the conversation with Luma need no pointer to it.
    if (!command.channel?.startsWith("D")) {
      return `Sending your ${group.name} tasks to your messages with Luma.`;
    }
  },
};

// The channel pair named in `text`, ignoring case.
function findGroup(env, text) {
  const name = text.trim().split(/\s+/)[0]?.toLowerCase();
  return channelPairs(env).find((pair) => pair.name.toLowerCase() === name);
}

function askForGroup(env, text) {
  const names = channelPairs(env).map((pair) => `\`tasks ${pair.name}\``);
  const unknown = text.trim() ? `"${escapeSlack(text.trim())}" is not a group. ` : "";
  return `${unknown}Say which group: ${names.join(" or ")}.`;
}

// Each list's text starts with its group's name, so the group's earlier list
// can be told apart from other groups' in the conversation's pins.
function listPrefix(group) {
  return `${group.name}: `;
}

// Builds the user's list for a group and posts it in their direct messages
// with Luma, replacing that group's list before it.
async function sendTaskList(env, user, group) {
  // Luma's own user ID tells its pins from the user's, and the workspace's
  // address is used for the task links.
  const self = await callSlack(env, "auth.test", {});
  const list = await taskList(env, user, group, self.url);

  // Posting to a user ID posts in their direct messages with the app.
  const { channel, ts } = await callSlack(env, "chat.postMessage", { channel: user, ...list });

  // Replacing is a tidy-up, so failures are logged rather than reported. The
  // only pins Luma makes in the conversation are its lists. Its pinned lists
  // for this group, other than the new one, are replaced, as are lists from
  // before lists had groups; other groups' lists and the user's pins stay.
  try {
    await callSlack(env, "pins.add", { channel, timestamp: ts });
    const { items = [] } = await callSlack(env, "pins.list", { channel });
    const prefixes = channelPairs(env).map(listPrefix);
    const earlier = items.filter(({ created_by: by, message }) => {
      if (by !== self.user_id || !message || message.ts === ts) return false;
      const text = message.text ?? "";
      return text.startsWith(listPrefix(group)) || !prefixes.some((prefix) => text.startsWith(prefix));
    });
    for (const { message } of earlier) {
      // Deleting a message also removes its pin.
      await callSlack(env, "chat.delete", { channel, ts: message.ts });
    }
  } catch (error) {
    console.warn("Could not replace the earlier task list", { user, error: error.message });
  }
}

async function taskList(env, user, group, url) {
  const tasks = await assignedTasks(env, user, group, url);
  const updated = {
    type: "context",
    elements: [mrkdwn(`Updated ${formatTime(env, new Date())}. Send \`tasks ${group.name}\` to refresh it.`)],
  };
  const header = { type: "header", text: { type: "plain_text", text: `Your ${group.name} tasks` } };
  if (!tasks.length) {
    const text = `${listPrefix(group)}You have no open tasks.`;
    return { text, blocks: [header, { type: "section", text: mrkdwn("You have no open tasks.") }, updated] };
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
  blocks.push(updated);
  const count = `${tasks.length} open ${tasks.length === 1 ? "task" : "tasks"}`;
  return { text: `${listPrefix(group)}You have ${count}.`, blocks };
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
    const link = `${url}archives/${channel}/p${ts.replace(".", "")}`;
    found.push({ task, roles, link, incident });
  }
  return found;
}
