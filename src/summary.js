import { findPair, roleOf } from "./channels.js";
import { deleteCanvas, getCanvas, openRequirements, putCanvas } from "./db.js";
import { OPEN, byUrgency, groupTasks, threadLink } from "./commands/tasks.js";
import { REQUIREMENT_STATUSES } from "./requirements.js";
import { formatTime } from "./sheet.js";
import { callSlack } from "./slack.js";
import { PRIORITIES, STATUSES } from "./tasks.js";

// A summary is a table in a channel's canvas of what is open there, most
// urgent first: in an external channel its requirements and incidents, in
// a tasks channel the group's tasks, its incidents channel's too, as
// `/cade tasks` lists them. Incidents channels have none: every incident
// is in its external channel's. `/cade summary` puts it in the channel's
// canvas, making one if there is none, and saves which it is; from then on
// the table is rewritten whenever a task or requirement in its group
// changes. Channels without one are left alone.

// A canvas table holds at most 300 cells, header included, so longer
// summaries continue in another table.
const MAX_CELLS = 300;

const TASK_COLUMNS = ["Title", "Status", "Priority", "Dev", "Reviewer", "Tester", "Due date", "Thread"];
const REQUIREMENT_COLUMNS = ["Title", "Priority", "Due date", "Status", "Tracked", "Thread"];

// The channel's summary, as canvas markdown.
export async function summaryMarkdown(env, channel) {
  const group = findPair(env, channel);
  // Links are built from the workspace's address, as `/cade tasks` does.
  const { url } = await callSlack(env, "auth.test", {});
  const updated = `_Updated ${formatTime(env, new Date())}. Cade keeps this up to date._`;
  if (roleOf(env, channel) === "external") {
    const rows = (await openRequirements(env, channel))
      .map(({ ts, requirement }) => ({ incident: requirement.incident, task: requirement, link: threadLink(url, channel, ts) }))
      .sort(byUrgency)
      .map(({ task: requirement, incident, link }) => [
        title(requirement.title, incident),
        priority(requirement.priority),
        requirement.dueDate || "—",
        REQUIREMENT_STATUSES[requirement.status],
        requirement.task ? ":white_check_mark: Yes" : "Not yet",
        `[Go to thread](${link})`,
      ]);
    return document(`Open ${group.name} requirements`, updated, REQUIREMENT_COLUMNS, rows, "No open requirements or incidents.");
  }
  const rows = (await groupTasks(env, group, OPEN, url)).sort(byUrgency).map(({ task, incident, link }) => [
    title(task.title, incident),
    STATUSES[task.status],
    priority(task.priority),
    people(task.people.developer),
    people(task.people.reviewer),
    people(task.people.tester),
    task.dueDate || "—",
    `[Go to thread](${link})`,
  ]);
  return document(`Open ${group.name} tasks`, updated, TASK_COLUMNS, rows, "No open tasks.");
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
// canvas held is replaced. Returns what happened, to tell whoever asked.
export async function publishSummary(env, channel, user) {
  const markdown = await summaryMarkdown(env, channel);
  const canvasId = await getCanvas(env, channel);
  if (canvasId) {
    try {
      await writeCanvas(env, canvasId, markdown);
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
  await putCanvas(env, channel, existing, user);
  return "Added the summary to this channel's canvas. I'll keep it up to date.";
}

async function writeCanvas(env, canvasId, markdown) {
  await callSlack(env, "canvases.edit", {
    canvas_id: canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
  });
}

// The heading, when it was updated, and the rows in as many tables as they
// need.
function document(heading, updated, columns, rows, empty) {
  const count = rows.length ? `${rows.length} open, most urgent first.` : empty;
  const perTable = Math.floor(MAX_CELLS / columns.length) - 1;
  const tables = [];
  for (let start = 0; start < rows.length; start += perTable) {
    tables.push(table(columns, rows.slice(start, start + perTable)));
  }
  return [`# ${heading}`, `${count} ${updated}`, ...tables].join("\n\n");
}

function table(columns, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join("\n");
}

// A title as a table cell: on one line, with its pipes escaped.
function title(text, incident) {
  const cell = text.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return incident ? `**Incident:** ${cell}` : cell;
}

function priority(name) {
  return PRIORITIES[name] ? `${PRIORITIES[name]} ${name}` : "—";
}

// People as canvas mentions, or a dash for no one.
function people(ids) {
  return ids.length ? ids.map((id) => `![](@${id})`).join(", ") : "—";
}
