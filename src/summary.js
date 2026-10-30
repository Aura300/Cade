import { findProject } from "./channels.js";
import { archivedTasks, deleteCanvas, getCanvas, putCanvas } from "./db.js";
import { byUrgency, groupTasks, threadLink } from "./commands/tasks.js";
import { formatTime, sheetEnabled, sheetId } from "./sheet.js";
import { callSlack } from "./slack.js";
import { PRIORITIES, STATUSES } from "./tasks.js";

// A summary is a dev channel's canvas listing what is open there, most
// urgent first, then what is closed (Done), most recently first, then what
// was archived (see archive.js), most recently first, each in tables: the group's tasks, incidents too, as `/cade tasks` lists them.
// Every group has one: when a task is made, Cade puts it in the channel's
// canvas, making one if there is none, and saves which it is; from then on
// the table is rewritten whenever a task changes.
// `/cade resync summary` rewrites it in full (see resync.js).

// A canvas table holds at most 300 cells, header included, so longer
// summaries continue in another table.
const MAX_CELLS = 300;

// The Closed and Archived sections list only the most recent, so they don't
// grow without end.
const MAX_CLOSED = 50;

const TASK_COLUMNS = ["Title", "Status", "Priority", "Due date", "Owner", "Reviewer", "Tester"];

// The canvas's title, which heads the summary.
export function summaryTitle(env, channel) {
  const { name } = findProject(env, channel);
  return `${name} tasks`;
}

// The channel's summary, as canvas markdown.
export async function summaryMarkdown(env, channel) {
  const group = findProject(env, channel);
  // Links are built from the workspace's address, as `/cade tasks` does.
  const { url } = await callSlack(env, "auth.test", {});
  const updated = `_Updated ${formatTime(env, new Date())}. Cade keeps this up to date._`;
  const tasks = (await groupTasks(env, group, Object.keys(STATUSES), url)).map((entry) => ({
    ...entry,
    closedAt: entry.task.completedAt,
  }));
  const row = ({ task, incident, link }) => [
    title(task.title, incident, link),
    unbroken(STATUSES[task.status]),
    priority(task.priority),
    task.dueDate || "—",
    people(task.people.owner),
    people(task.people.reviewer),
    people(task.people.tester),
  ];
  // The Closed section is cut short, so the group's Google Sheet, which has
  // every task, is linked when it has one.
  const sheet = sheetEnabled(env, group)
    ? ` [All tasks in the Google Sheet](https://docs.google.com/spreadsheets/d/${sheetId(group.sheet)}/edit).`
    : "";
  const archived = (await archivedTasks(env, group.channel, MAX_CLOSED)).map(({ ts, task }) => ({
    task,
    incident: task.incident,
    link: threadLink(url, group.channel, ts),
  }));
  return document(`${updated}${sheet}`, TASK_COLUMNS, { ...sections(tasks, row), archived: archived.map(row) }, "tasks");
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

// Rewrites the summary of `channel`'s group; with `create`, for a new task,
// making its canvas if it has none. A summary is a convenience, so failures
// are logged rather than failing the command.
export async function refreshSummary(env, channel, { create = false } = {}) {
  const group = findProject(env, channel);
  if (!group) return;
  try {
    if (create || (await getCanvas(env, group.channel))) await writeSummary(env, group.channel);
  } catch (error) {
    console.warn("Could not update the summary", { channel: group.channel, error: error.message });
  }
}

// Writes the dev channel `channel`'s summary to its canvas, the one Slack
// shows in the channel's header, making it if there is none, or taking
// over the canvas the channel has. A canvas it makes or takes over gets the
// summary's title and is made read-only for the channel, as Cade rewrites
// it on every change anyway (see lockCanvas); with `full`, as for `/cade
// resync summary`, the one it keeps does too. `user` is who asked, if
// anyone. Returns what happened, to tell them.
export async function writeSummary(env, channel, { full = false, user = "" } = {}) {
  const title = summaryTitle(env, channel);
  const markdown = await summaryMarkdown(env, channel);
  const canvasId = await getCanvas(env, channel);
  if (canvasId) {
    try {
      await writeCanvas(env, canvasId, markdown);
      if (!full) return "Updated the summary in this channel's canvas.";
      await renameCanvas(env, canvasId, title);
      return `Resynced the summary in this channel's canvas.${await lockCanvas(env, canvasId, channel)}`;
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
    return `Added the summary to this channel's canvas. I'll keep it up to date.${await lockCanvas(env, created, channel)}`;
  } catch (error) {
    if (!/channel_canvas_already_exists|free_team_canvas_tab_already_exists/.test(error.message)) {
      if (/team_tier_cannot_create_channel_canvases|canvas_disabled/.test(error.message)) {
        return "Sorry, this workspace can't have channel canvases, so I can't keep the summary.";
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
  return `Added the summary to this channel's canvas. I'll keep it up to date.${await lockCanvas(env, existing, channel)}`;
}

// Makes the canvas read-only for the channel's members, as Slack's own
// "Can view" does, so edits that would be overwritten aren't made. Cade
// stays able to write it, as its owner. Slack may refuse, such as on a
// free workspace or for a canvas someone else made; the summary works the
// same either way, so that is only logged. Returns what to add to the
// reply.
async function lockCanvas(env, canvasId, channel) {
  try {
    await callSlack(env, "canvases.access.set", { canvas_id: canvasId, access_level: "read", channel_ids: [channel] });
    return " Only I can edit it.";
  } catch (error) {
    console.warn("Could not make the summary read-only", { channel, error: error.message });
    return "";
  }
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

// When it was updated, then an Open, a Closed and an Archived section, each
// with its rows in as many tables as they need. `noun` names what they
// list.
function document(updated, columns, { open, closed, archived }, noun) {
  return [
    updated,
    "## Open",
    open.length ? `${open.length} open, most urgent first.` : `No open ${noun}.`,
    ...tables(columns, open),
    "---",
    "## Closed",
    closed.length ? `The last ${closed.length} done, most recently first.` : `No closed ${noun} yet.`,
    ...tables(columns, closed),
    "---",
    "## Archived",
    archived.length ? `The last ${archived.length} archived, most recently first.` : `No archived ${noun}.`,
    ...tables(columns, archived),
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
