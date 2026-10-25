import { findPair, roleOf } from "./channels.js";
import { deleteCanvas, getCanvas, postedRequirements, putCanvas } from "./db.js";
import { byUrgency, groupTasks, threadLink } from "./commands/tasks.js";
import { REQUIREMENT_STATUSES } from "./requirements.js";
import { formatTime } from "./sheet.js";
import { callSlack } from "./slack.js";
import { PRIORITIES, STATUSES } from "./tasks.js";

// A summary is a channel's canvas listing what is open there, most urgent
// first, then what is closed (Done), most recently first, each in tables:
// in an external channel its requirements and incidents, in
// a tasks channel the group's tasks, its incidents channel's too, as
// `/cade tasks` lists them. Incidents channels have none: every incident
// is in its external channel's. `/cade summary` puts it in the channel's
// canvas, making one if there is none, and saves which it is; from then on
// the table is rewritten whenever a task or requirement in its group
// changes. Channels without one are left alone.

// A canvas table holds at most 300 cells, header included, so longer
// summaries continue in another table.
const MAX_CELLS = 300;

// The Closed section lists only the most recently closed, so it doesn't
// grow without end.
const MAX_CLOSED = 50;

const TASK_COLUMNS = ["Title", "Status", "Priority", "Due date", "Dev", "Reviewer", "Tester"];
const REQUIREMENT_COLUMNS = ["Title", "Priority", "Due date", "Status", "Tracked"];

// The canvas's title, which heads the summary.
export function summaryTitle(env, channel) {
  const { name } = findPair(env, channel);
  return roleOf(env, channel) === "external" ? `${name} requirements` : `${name} tasks`;
}

// The channel's summary, as canvas markdown.
export async function summaryMarkdown(env, channel) {
  const group = findPair(env, channel);
  // Links are built from the workspace's address, as `/cade tasks` does.
  const { url } = await callSlack(env, "auth.test", {});
  const updated = `_Updated ${formatTime(env, new Date())}. Cade keeps this up to date._`;
  if (roleOf(env, channel) === "external") {
    const requirements = (await postedRequirements(env, channel)).map(({ ts, requirement, updatedAt }) => ({
      incident: requirement.incident,
      task: requirement,
      link: threadLink(url, channel, ts),
      // A requirement is last changed when it is done.
      closedAt: updatedAt,
    }));
    const row = ({ task: requirement, incident, link }) => [
      title(requirement.title, incident, link),
      priority(requirement.priority),
      requirement.dueDate || "—",
      unbroken(REQUIREMENT_STATUSES[requirement.status]),
      requirement.task ? ":white_check_mark: Yes" : "Not yet",
    ];
    return document(updated, REQUIREMENT_COLUMNS, sections(requirements, row), "requirements or incidents");
  }
  const tasks = (await groupTasks(env, group, Object.keys(STATUSES), url)).map((entry) => ({
    ...entry,
    closedAt: entry.task.completedAt,
  }));
  const row = ({ task, incident, link }) => [
    title(task.title, incident, link),
    unbroken(STATUSES[task.status]),
    priority(task.priority),
    task.dueDate || "—",
    people(task.people.developer),
    people(task.people.reviewer),
    people(task.people.tester),
  ];
  return document(updated, TASK_COLUMNS, sections(tasks, row), "tasks");
}

// The rows of the open entries, most urgent first, and of the last
// MAX_CLOSED closed ones, most recently closed first.
function sections(entries, row) {
  const open = entries.filter((entry) => entry.task.status !== "DONE").sort(byUrgency);
  const closed = entries
    .filter((entry) => entry.task.status === "DONE")
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, MAX_CLOSED);
  return { open: open.map(row), closed: closed.map(row) };
}

// Rewrites the summary a change in `channel` touches: the external
// channel's for a requirement, the tasks channel's for a task.
// A summary is a convenience, so failures are logged rather than failing
// the command.
export async function refreshSummary(env, channel) {
  const group = findPair(env, channel);
  if (!group) return;
  const summaryChannel = roleOf(env, channel) === "external" ? group.external : group.tasks;
  try {
    const canvasId = await getCanvas(env, summaryChannel);
    if (canvasId) await writeCanvas(env, canvasId, await summaryMarkdown(env, summaryChannel));
  } catch (error) {
    console.warn("Could not update the summary", { channel: summaryChannel, error: error.message });
  }
}

// For `/cade summary`: writes the channel's summary to its canvas, the one
// Slack shows in the channel's header, making it if there is none. What the
// canvas held is replaced, and it takes the summary's title. Returns what
// happened, to tell whoever asked.
export async function publishSummary(env, channel, user) {
  const title = summaryTitle(env, channel);
  const markdown = await summaryMarkdown(env, channel);
  const canvasId = await getCanvas(env, channel);
  if (canvasId) {
    try {
      await writeCanvas(env, canvasId, markdown);
      await renameCanvas(env, canvasId, title);
      return "Updated the summary in this channel's canvas.";
    } catch (error) {
      // Deleted by hand: a new one is made below.
      if (!/canvas_not_found|canvas_deleted|file_not_found/.test(error.message)) throw error;
      await deleteCanvas(env, channel);
    }
  }
  try {
    const { canvas_id: created } = await callSlack(env, "conversations.canvases.create", {
      channel_id: channel,
      title,
      document_content: { type: "markdown", markdown },
    });
    await putCanvas(env, channel, created, user);
    return "Added the summary to this channel's canvas. I'll keep it up to date.";
  } catch (error) {
    if (!/channel_canvas_already_exists|free_team_canvas_tab_already_exists/.test(error.message)) {
      if (/team_tier_cannot_create_channel_canvases|canvas_disabled/.test(error.message)) {
        return "Sorry, this workspace can't have channel canvases, so I can't add the summary.";
      }
      throw error;
    }
  }
  const { channel: info } = await callSlack(env, "conversations.info", { channel });
  const existing = info.properties?.canvas?.file_id;
  if (!existing) throw new Error("conversations.info gave no canvas for a channel that has one");
  await writeCanvas(env, existing, markdown);
  await renameCanvas(env, existing, title);
  await putCanvas(env, channel, existing, user);
  return "Added the summary to this channel's canvas. I'll keep it up to date.";
}

async function writeCanvas(env, canvasId, markdown) {
  await callSlack(env, "canvases.edit", {
    canvas_id: canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
  });
}

async function renameCanvas(env, canvasId, title) {
  await callSlack(env, "canvases.edit", {
    canvas_id: canvasId,
    changes: [{ operation: "rename", title_content: { type: "markdown", markdown: title } }],
  });
}

// When it was updated, then an Open and a Closed section, each with its
// rows in as many tables as they need. `noun` names what they list.
function document(updated, columns, { open, closed }, noun) {
  return [
    updated,
    "## Open",
    open.length ? `${open.length} open, most urgent first.` : `No open ${noun}.`,
    ...tables(columns, open),
    "---",
    "## Closed",
    closed.length ? `The last ${closed.length} done, most recently first.` : `No closed ${noun} yet.`,
    ...tables(columns, closed),
  ].join("\n\n");
}

// The rows in as many tables as they need.
function tables(columns, rows) {
  const perTable = Math.floor(MAX_CELLS / columns.length) - 1;
  const found = [];
  for (let start = 0; start < rows.length; start += perTable) {
    found.push(table(columns, rows.slice(start, start + perTable)));
  }
  return found;
}

function table(columns, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join("\n");
}

// A title as a table cell linking to its thread: on one line, with what
// would end the link or the cell escaped.
function title(text, incident, link) {
  const cell = `[${text.replace(/\s+/g, " ").replace(/([[\]|\\])/g, "\\$1")}](${link})`;
  return incident ? `**Incident:** ${cell}` : cell;
}

function priority(name) {
  return PRIORITIES[name] ? unbroken(`${PRIORITIES[name]} ${name}`) : "—";
}

// Slack sizes a canvas table's columns itself, so a short value such as a
// priority could wrap; non-breaking spaces keep it on one line.
function unbroken(text) {
  return text.replace(/ /g, "\u00a0");
}

// People as canvas mentions, or a dash for no one.
function people(ids) {
  return ids.length ? ids.map((id) => `![](@${id})`).join(", ") : "—";
}
