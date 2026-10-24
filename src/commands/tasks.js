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

// The words `/luma tasks <role>` takes for each role.
const ROLE_WORDS = {
  developer: ["development", "developing", "developer", "dev"],
  reviewer: ["review", "reviewing", "reviewer"],
  tester: ["testing", "test", "tester"],
};

// `/luma tasks` in any channel lists the open tasks you are assigned to, by
// group (channel pair): each group's dev channel's and incidents channel's.
// They are grouped by your role (developing, reviewing, testing), incidents
// first, then by priority and due date, each linking to its thread. Done
// tasks are left out. `/luma tasks development` (or `review`, `testing`)
// shows only that role.
//
// In a group's channel the list shows that group; elsewhere it shows every
// group. The list is shown only to you, in the channel you asked in, and is
// not kept: ask again for a fresh one. (Slack does not allow slash commands
// in threads.)
export default {
  name: "tasks",
  description: "Show your open tasks by role, only to you (`development`, `review` or `testing` for one)",
  slashUsage: "/luma tasks",
  section: "work",
  async slash(command, context) {
    const roles = findRoles(command.text);
    if (!roles) return askForRole(command.text);
    const own = findPair(context.env, command.channel);
    const groups = own ? [own] : channelPairs(context.env);
    // Reading the channels can take longer than Slack waits for a slash
    // command's answer, so the list follows through its response_url.
    context.waitUntil(
      (async () =>
        respondLater(command.responseUrl, await taskLists(context.env, command.user, groups, roles)))(),
    );
  },
};

// The role named in the command, as a list, or every role when none is
// named. Null when the word is not a role.
function findRoles(text) {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return Object.keys(ROLES);
  const role = Object.keys(ROLE_WORDS).find((name) => ROLE_WORDS[name].includes(word));
  return role ? [role] : null;
}

function askForRole(text) {
  return `"${escapeSlack(text.trim())}" is not a role. Use \`/luma tasks\` for all your tasks, or \`/luma tasks development\`, \`review\` or \`testing\` for one role.`;
}

// One list per group, one after the other.
async function taskLists(env, user, groups, roles) {
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const lists = await Promise.all(groups.map((group) => taskList(env, user, group, roles, url)));
  return {
    text: lists.map((list) => list.text).join(" "),
    blocks: lists.flatMap((list, i) => (i ? [{ type: "divider" }, ...list.blocks] : list.blocks)),
  };
}

async function taskList(env, user, group, roles, url) {
  const tasks = (await assignedTasks(env, user, group, url)).filter((entry) =>
    entry.roles.some((role) => roles.includes(role)),
  );
  // One role's list says which: "Your aura300 tasks: Reviewing".
  const which = roles.length === 1 ? `: ${DOING[roles[0]]}` : "";
  const header = { type: "header", text: { type: "plain_text", text: `Your ${group.name} tasks${which}` } };
  const kind = roles.length === 1 ? `${DOING[roles[0]].toLowerCase()} ` : "";
  if (!tasks.length) {
    const text = `You have no open ${group.name} ${kind}tasks.`;
    return { text, blocks: [header, { type: "section", text: mrkdwn("You have no open tasks.") }] };
  }

  const blocks = [header];
  for (const role of roles) {
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
  const count = `${tasks.length} open ${group.name} ${kind}${tasks.length === 1 ? "task" : "tasks"}`;
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
