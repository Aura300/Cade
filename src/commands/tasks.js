import { channelPairs, findPair } from "../channels.js";
import { tasksWithStatus } from "../db.js";
import { userNames } from "../sheet.js";
import { callSlack, escapeSlack, mentions, mrkdwn, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, statusName } from "../tasks.js";

// What each role is doing, as the list's headings.
const DOING = {
  developer: "Developing",
  reviewer: "Reviewing",
  tester: "Testing",
};

// A section's text can hold 3,000 characters, so long lists are cut short.
const MAX_LISTED = 15;

// The words `/cade tasks <role>` takes for each role.
const ROLE_WORDS = {
  developer: ["development", "developing", "developer", "dev"],
  reviewer: ["review", "reviewing", "reviewer"],
  tester: ["testing", "test", "tester"],
};

// Open tasks: every status but Done.
export const OPEN = Object.keys(STATUSES).filter((status) => status !== "DONE");

const USAGE =
  "Try `/cade tasks` for your open tasks, with any of: `development`, `review` or `testing` for one role; `@person` for theirs; `-all` for everyone's; `-unassigned` for those with no developer; `-status=in-progress` (or `todo`, `in-review`, `in-testing`, `client-review`, `done`, several with commas); `-due=@today`, `-due<@today`, `-due>=31/10/2026` or `-due=none`.";

// `/cade tasks` in any channel lists the open tasks you are assigned to, by
// group (channel pair): each group's dev channel's and incidents channel's.
// They are grouped by your role (developing, reviewing, testing), incidents
// first, then by priority and due date, each linking to its thread. Done
// tasks are left out. It takes, in any order (see parseTaskFilters):
//   development, review, testing   only that role
//   @person                        their tasks instead of yours
//   -all                           everyone's tasks, by status
//   -unassigned                    tasks with no developer, by status
//   -status=in-progress,…          only those statuses (Done too, if named)
//   -due=…, -due<…, -due>=…        by due date: a date, @today, @tomorrow,
//                                  or none
//
// In a group's channel the list shows that group; elsewhere it shows every
// group. The list is shown only to you, in the channel you asked in, and is
// not kept: ask again for a fresh one. (Slack does not allow slash commands
// in threads.)
export default {
  name: "tasks",
  description:
    "Show open tasks, only to you: yours by role, `@person`'s, `-all` or `-unassigned`; filter with `-status=in-progress` or `-due<@today`",
  slashUsage: "/cade tasks",
  section: "work",
  async slash(command, context) {
    const filters = parseTaskFilters(command.text);
    if (filters.error) return filters.error;
    const own = findPair(context.env, command.channel);
    const groups = own ? [own] : channelPairs(context.env);
    // Reading the channels can take longer than Slack waits for a slash
    // command's answer, so the list follows through its response_url.
    context.waitUntil(
      (async () =>
        respondLater(command.responseUrl, await taskLists(context.env, command.user, groups, filters)))(),
    );
  },
};

// Reads the command's words into { roles, user, all, unassigned, statuses,
// due }, or
// { error } saying what's wrong. `user` is the person named, if any; `due`
// is { op, value } where op is =, <, <=, > or >=, and value a date as
// YYYY-MM-DD, "@today", "@tomorrow" or "none".
export function parseTaskFilters(text) {
  // Slack sends <, > and & encoded, and may turn a typed -- into a dash.
  const words = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split(/\s+/)
    .filter(Boolean);
  const filters = {
    roles: Object.keys(ROLES),
    user: null,
    all: false,
    unassigned: false,
    statuses: OPEN,
    due: null,
  };
  const fail = (message) => ({ error: `${message} ${USAGE}` });
  let role = null;
  for (const word of words) {
    const person = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(word);
    const option = /^(?:--?|[—–])([a-z]+)(.*)$/i.exec(word);
    if (person) {
      if (filters.user && filters.user !== person[1]) return fail("I can only look up one person at a time.");
      filters.user = person[1];
    } else if (option) {
      const name = option[1].toLowerCase();
      const rest = option[2];
      if (name === "all" && !rest) {
        filters.all = true;
      } else if (name === "unassigned" && !rest) {
        filters.unassigned = true;
      } else if (name === "status") {
        const statuses = readStatuses(rest);
        if (!statuses) return fail(`I don't know "${escapeSlack(word)}" as a status filter.`);
        filters.statuses = statuses;
      } else if (name === "due") {
        const due = readDue(rest);
        if (!due) return fail(`I don't know "${escapeSlack(word)}" as a due date filter.`);
        filters.due = due;
      } else {
        return fail(`I don't know "${escapeSlack(word)}" as an option.`);
      }
    } else {
      const found = Object.keys(ROLE_WORDS).find((name) => ROLE_WORDS[name].includes(word.toLowerCase()));
      if (!found) return fail(`I don't know "${escapeSlack(word)}" as a role.`);
      if (role && role !== found) return fail("I can only show one role at a time.");
      role = found;
    }
  }
  if (filters.all && filters.unassigned) return fail("Use `-all` or `-unassigned`, not both.");
  if (filters.all && (role || filters.user)) {
    return fail("`-all` shows everyone's tasks, so it can't take a role or a person.");
  }
  if (filters.unassigned && (role || filters.user)) {
    return fail("`-unassigned` shows tasks with no developer, so it can't take a role or a person.");
  }
  if (role) filters.roles = [role];
  return filters;
}

// "=in-progress,todo" as status keys, or null.
function readStatuses(rest) {
  const match = /^=(.+)$/.exec(rest);
  if (!match) return null;
  const statuses = match[1]
    .split(",")
    .map((value) => value.toUpperCase().replace(/-/g, "_"))
    .map((status) => (status === "TO_DO" ? "TODO" : status));
  return statuses.every((status) => STATUSES[status]) ? [...new Set(statuses)] : null;
}

// "<@today" as { op: "<", value: "@today" }, or null.
function readDue(rest) {
  const match = /^(<=|>=|=|<|>)(.+)$/.exec(rest);
  if (!match) return null;
  const [, op, raw] = match;
  const value = raw.toLowerCase();
  if (value === "@today" || value === "@tomorrow") return { op, value };
  if (value === "none") return op === "=" ? { op, value } : null;
  const iso = readDate(raw);
  return iso ? { op, value: iso } : null;
}

// DD/MM/YYYY or YYYY-MM-DD as YYYY-MM-DD, or "" if it isn't a real date.
function readDate(text) {
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  let year, month, day;
  if (match) [, day, month, year] = match;
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) [, year, month, day] = match;
  else return "";
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : "";
}

// One list per group, one after the other.
async function taskLists(env, viewer, groups, filters) {
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const user = filters.user ?? viewer;
  // Someone else's list is headed with their name.
  const name = user === viewer ? null : await userNames(env, [user]);
  const lists = await Promise.all(
    groups.map((group) => taskList(env, { ...filters, user, name }, group, url)),
  );
  return {
    text: lists.map((list) => list.text).join(" "),
    blocks: lists.flatMap((list, i) => (i ? [{ type: "divider" }, ...list.blocks] : list.blocks)),
  };
}

async function taskList(env, filters, group, url) {
  const due = dueTest(env, filters.due);
  const found = (await groupTasks(env, group, filters.statuses, url)).filter((entry) =>
    due(entry.task.dueDate),
  );
  if (filters.unassigned) {
    const unassigned = found.filter((entry) => !entry.task.people.developer.length);
    return everyonesList(filters, group, unassigned, `Unassigned ${group.name} tasks`);
  }
  return filters.all ? everyonesList(filters, group, found) : personsList(filters, group, found);
}

// One person's tasks, by their role.
function personsList(filters, group, found) {
  const { roles, user, name } = filters;
  const tasks = found
    .map((entry) => ({
      ...entry,
      roles: Object.keys(ROLES).filter((role) => entry.task.people[role].includes(user)),
    }))
    .filter((entry) => entry.roles.some((role) => roles.includes(role)));
  // One role's list says which: "Your acme tasks: Reviewing".
  const which = roles.length === 1 ? `: ${DOING[roles[0]]}` : "";
  const blocks = [header(`${name ? `${name}'s` : "Your"} ${group.name} tasks${which}`), ...filterContext(filters)];
  const kind = roles.length === 1 ? `${DOING[roles[0]].toLowerCase()} ` : "";
  const subject = name ? `<@${user}> has` : "You have";
  if (!tasks.length) {
    const none = `${subject} no ${matching(filters)}tasks.`;
    return {
      text: summary(`${subject} no`, filters, group, kind, 0),
      blocks: [...blocks, { type: "section", text: mrkdwn(none) }],
    };
  }

  for (const role of roles) {
    const theirs = tasks.filter((entry) => entry.roles.includes(role)).sort(byUrgency);
    blocks.push(section(DOING[role], theirs, "_Nothing assigned._"));
  }
  return { text: summary(`${subject} ${tasks.length}`, filters, group, kind, tasks.length), blocks };
}

// Everyone's tasks (or those `found`), by status, each saying who works on
// it.
function everyonesList(filters, group, found, title = `All ${group.name} tasks`) {
  const blocks = [header(title), ...filterContext(filters)];
  if (!found.length) {
    return {
      text: summary("There are no", filters, group, filters.unassigned ? "unassigned " : "", 0),
      blocks: [...blocks, { type: "section", text: mrkdwn(`There are no ${matching(filters)}tasks.`) }],
    };
  }
  for (const status of filters.statuses) {
    const these = found.filter((entry) => entry.task.status === status).sort(byUrgency);
    if (these.length) blocks.push(section(statusName(status), these, "", { people: true }));
  }
  const kind = filters.unassigned ? "unassigned " : "";
  const start = found.length === 1 ? "There is 1" : `There are ${found.length}`;
  return { text: summary(start, filters, group, kind, found.length), blocks };
}

function header(text) {
  return { type: "header", text: { type: "plain_text", text } };
}

// A list's heading, its count and up to MAX_LISTED of its tasks.
function section(heading, entries, empty, options) {
  const lines = entries.slice(0, MAX_LISTED).map((entry) => line(entry, options));
  if (entries.length > MAX_LISTED) lines.push(`_…and ${entries.length - MAX_LISTED} more._`);
  const count = entries.length ? ` (${entries.length})` : "";
  return { type: "section", text: mrkdwn(`*${heading}${count}*\n${lines.join("\n") || empty}`) };
}

// Under the header, the filters used, if any.
function filterContext(filters) {
  const label = filterLabel(filters);
  return label ? [{ type: "context", elements: [mrkdwn(label)] }] : [];
}

// "In progress  ·  Due before today", or "" for open tasks with any due date.
function filterLabel({ statuses, due }) {
  const parts = [];
  if (statuses !== OPEN) parts.push(statuses.map(statusName).join(", "));
  if (due) parts.push(dueLabel(due));
  return parts.join("  ·  ");
}

function dueLabel({ op, value }) {
  if (value === "none") return "No due date";
  const when = value.startsWith("@") ? value.slice(1) : formatDate(value);
  const words = { "=": "Due", "<": "Due before", "<=": "Due by", ">": "Due after", ">=": "Due from" };
  return `${words[op]} ${when}`;
}

// "open " for open tasks with any due date; "matching " when filtered.
function matching(filters) {
  return filterLabel(filters) ? "matching " : "open ";
}

// "You have 3 open acme tasks." or, filtered, "You have 3 acme tasks: In
// progress  ·  Due before today."
function summary(start, filters, group, kind, count) {
  const noun = count === 1 ? "task" : "tasks";
  const label = filterLabel(filters);
  return label
    ? `${start} ${group.name} ${kind}${noun}: ${label}.`
    : `${start} open ${group.name} ${kind}${noun}.`;
}

export function line({ task, link, incident }, { people = false } = {}) {
  const label = incident ? "*Incident:* " : "";
  const parts = [
    `• ${label}<${link}|${escapeSlack(task.title)}>`,
    STATUSES[task.status],
    `${PRIORITIES[task.priority]} ${task.priority}`,
    `Due ${task.dueDate || "_none_"}`,
  ];
  if (people) {
    const ids = [...new Set(Object.keys(ROLES).flatMap((role) => task.people[role]))];
    parts.push(ids.length ? mentions(ids) : "_Unassigned_");
  }
  return parts.join("  ·  ");
}

// Incidents first, then by priority, then the soonest due date. "Immediate"
// is the soonest; no due date is the latest.
export function byUrgency(a, b) {
  const order = Object.keys(PRIORITIES);
  return (
    Number(b.incident) - Number(a.incident) ||
    order.indexOf(a.task.priority) - order.indexOf(b.task.priority) ||
    dueOrder(a.task.dueDate) - dueOrder(b.task.dueDate)
  );
}

function dueOrder(dueDate) {
  if (dueDate === "Immediate") return -Infinity;
  const iso = isoDate(dueDate);
  return iso ? Date.parse(iso) : Infinity;
}

// Whether a task's due date (DD/MM/YYYY, "Immediate" or "") passes `due`.
// "Immediate" counts as today; a task with no due date passes only =none.
function dueTest(env, due) {
  if (!due) return () => true;
  if (due.value === "none") return (dueDate) => !dueDate;
  const today = todayIn(env);
  const target = { "@today": today, "@tomorrow": nextDay(today) }[due.value] ?? due.value;
  const compare = {
    "=": (a, b) => a === b,
    "<": (a, b) => a < b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    ">=": (a, b) => a >= b,
  }[due.op];
  return (dueDate) => {
    const date = dueDate === "Immediate" ? today : isoDate(dueDate);
    return Boolean(date) && compare(date, target);
  };
}

// Today's date in TIMEZONE (UTC by default), as YYYY-MM-DD.
export function todayIn(env, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE || "UTC" }).format(now);
}

function nextDay(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

// DD/MM/YYYY as YYYY-MM-DD, or "" for anything else.
function isoDate(dueDate) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

// A link to the message `ts` that opens its thread, not just the message,
// from the workspace's address, `url`.
export function threadLink(url, channel, ts) {
  return `${url}archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;
}

// The group's tasks with one of `statuses`, as { channel, ts, task, link,
// incident }, from its tasks and incidents channels. Links are built from
// the workspace's address, `url`, rather than looked up one by one, which
// would take a Slack call per task.
export async function groupTasks(env, group, statuses, url) {
  const channels = [
    { channel: group.tasks, incident: false },
    ...(group.incidents ? [{ channel: group.incidents, incident: true }] : []),
  ];
  const found = await Promise.all(
    channels.map(async ({ channel, incident }) =>
      (await tasksWithStatus(env, channel, statuses)).map(({ ts, task }) => ({
        channel,
        ts,
        task,
        incident,
        link: threadLink(url, channel, ts),
      })),
    ),
  );
  return found.flat();
}
