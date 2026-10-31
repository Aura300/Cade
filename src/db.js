// Tasks are stored in D1 (the DB binding). Each is stored before its root
// message is posted; once posted, it is found by the message's channel and
// ts. The root message and the Google Sheet row are rendered from the row
// after every change (see saveTask). The schema is in migrations/; the
// requirements table, and tasks' source_channel, source_thread_ts and
// source_link, are left from when a client channel could be paired, and no
// longer read.

// How many times Cade tries to post a root message before giving up: once
// when it is made, then on each retry (see retry.js).
export const POST_ATTEMPTS = 5;

// Returns the task whose root message is `ts`, or null if there is none or
// it was deleted. It comes with its releases, which its message shows.
export async function getTask(env, channel, ts) {
  const row = await env.DB.prepare(
    "SELECT * FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL AND archived_at IS NULL",
  )
    .bind(channel, ts)
    .first();
  return row ? { ...taskFromRow(row), releases: await releasesOf(env, row.id) } : null;
}

// The task's releases that aren't NOT_APPROVED, oldest first, as
// { id, prs, note, status, sentBy, sentAt, decidedBy, decidedAt }.
async function releasesOf(env, taskId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM releases WHERE task_id = ? AND status != 'NOT_APPROVED' ORDER BY id",
  )
    .bind(taskId)
    .all();
  return results.map((row) => ({
    id: row.id,
    prs: JSON.parse(row.prs),
    note: row.note,
    status: row.status,
    sentBy: row.sent_by,
    sentAt: row.sent_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  }));
}

// Stores a release of the task whose root message is `ts`, and returns its
// id. `release` is { prs, note, status, sentBy, decidedBy? }.
export async function insertRelease(env, channel, ts, release) {
  const { id } = await env.DB.prepare(
    `INSERT INTO releases (task_id, prs, note, status, sent_by, decided_by)
     SELECT id, ?, ?, ?, ?, ? FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL AND archived_at IS NULL
     RETURNING id`,
  )
    .bind(JSON.stringify(release.prs), release.note, release.status, release.sentBy, release.decidedBy ?? null, channel, ts)
    .first();
  return id;
}

// Records the client's decision on a release waiting for one: APPROVED or
// NOT_APPROVED. Returns false if it was decided already, by another click.
export async function decideRelease(env, id, status, user) {
  const row = await env.DB.prepare(
    `UPDATE releases SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'PENDING_APPROVAL' RETURNING id`,
  )
    .bind(status, user, id)
    .first();
  return Boolean(row);
}

// Stores a new task that is about to be posted in `channel`, with `origin`,
// what follows the post (see publishTask), and returns its id.
export async function insertTask(env, channel, task, origin) {
  return insert(env, "tasks", channel, { ...taskToRow(task), origin: JSON.stringify(origin) });
}

// Records that the task's root message was posted as `ts`.
export async function markTaskPosted(env, id, ts, link) {
  await env.DB.prepare(
    `UPDATE tasks SET ts = ?, link = ?, origin = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(ts, link ?? null, id)
    .run();
}

// Saves a posted task.
export async function putTask(env, channel, ts, task) {
  await upsert(env, "tasks", channel, ts, taskToRow(task));
}

export async function markTaskDeleted(env, channel, ts) {
  await env.DB.prepare(
    "UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE channel = ? AND ts = ?",
  )
    .bind(channel, ts)
    .run();
}

// Stops tracking the task, keeping it for the summary's Archived section
// (see archive.js).
export async function markTaskArchived(env, channel, ts, user) {
  await env.DB.prepare(
    "UPDATE tasks SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE channel = ? AND ts = ?",
  )
    .bind(user, channel, ts)
    .run();
}

// The archived tasks in `channel` that weren't deleted since, as { ts,
// task, archivedAt, archivedBy }, most recently archived first: at most
// `limit`.
export async function archivedTasks(env, channel, limit) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NOT NULL
     ORDER BY archived_at DESC, id DESC LIMIT ?`,
  )
    .bind(channel, limit)
    .all();
  return results.map((row) => ({ ts: row.ts, task: taskFromRow(row), archivedAt: row.archived_at, archivedBy: row.archived_by }));
}

// Returns the task whose root message is `ts`, deleted, archived or not,
// with `deleted` saying whether it was deleted, or null if there is none. A deleted task's
// messages may still be in Slack, if deleting them failed.
export async function getTaskIncludingDeleted(env, channel, ts) {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE channel = ? AND ts = ?")
    .bind(channel, ts)
    .first();
  return row ? { ...taskFromRow(row), deleted: Boolean(row.deleted_at) } : null;
}

// The posted tasks in `channel` with one of `statuses`, as { ts, task },
// oldest first.
export async function tasksWithStatus(env, channel, statuses) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
       AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY ts`,
  )
    .bind(channel, ...statuses)
    .all();
  return results.map((row) => ({ ts: row.ts, task: taskFromRow(row) }));
}

// The tasks whose root message Slack hasn't taken yet, as { id, channel,
// task, origin, attempts }, oldest first. Only those made a minute or more
// ago, so a post still under way isn't made twice.
export async function unpostedTasks(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE ts IS NULL AND deleted_at IS NULL AND created_at <= datetime('now', '-1 minute')
     ORDER BY id`,
  ).all();
  return results.map((row) => ({
    id: row.id,
    channel: row.channel,
    task: taskFromRow(row),
    origin: JSON.parse(row.origin ?? "{}"),
    attempts: row.post_attempts,
  }));
}

// The id of the canvas Cade keeps the channel's summary in, or null.
// The group name the person's Home tab shows, or null for every group.
export async function getHomeProject(env, user) {
  const row = await env.DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind(user).first();
  return row?.home_project ?? null;
}

export async function setHomeProject(env, user, project) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_project = excluded.home_project`,
  )
    .bind(user, project)
    .run();
}

// The Home tab view the person last used, or null.
export async function getHomeTab(env, user) {
  const row = await env.DB.prepare("SELECT home_tab FROM user_preferences WHERE user_id = ?").bind(user).first();
  return row?.home_tab ?? null;
}

export async function setHomeTab(env, user, tab) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_tab) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_tab = excluded.home_tab`,
  )
    .bind(user, tab)
    .run();
}

export async function getCanvas(env, channel) {
  const row = await env.DB.prepare("SELECT canvas_id FROM canvases WHERE channel = ?").bind(channel).first();
  return row?.canvas_id ?? null;
}

export async function putCanvas(env, channel, canvasId, user) {
  await env.DB.prepare(
    `INSERT INTO canvases (channel, canvas_id, created_by) VALUES (?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET canvas_id = excluded.canvas_id, created_by = excluded.created_by`,
  )
    .bind(channel, canvasId, user)
    .run();
}

export async function deleteCanvas(env, channel) {
  await env.DB.prepare("DELETE FROM canvases WHERE channel = ?").bind(channel).run();
}

// The group's last export, as getExport gives it, or null. Its `until` is
// where the next one's period starts.
export async function lastExport(env, group) {
  const row = await env.DB.prepare(
    `SELECT id FROM exports
     WHERE group_name = ? AND exported_at IS NOT NULL AND doc_url IS NOT NULL
     ORDER BY exported_at DESC LIMIT 1`,
  )
    .bind(group)
    .first();
  return row ? getExport(env, row.id) : null;
}

// Starts an export draft, `draft` being { group, createdBy, since, until },
// and returns its id. `since` and `until` bound its period.
export async function insertExport(env, draft) {
  const { id } = await env.DB.prepare(
    "INSERT INTO exports (group_name, created_by, since, until) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(draft.group, draft.createdBy, draft.since, draft.until)
    .first();
  return id;
}

// The export `id`, as { id, group, createdBy, since, until, exportedAt,
// docId, docUrl, docLines }, or null. The doc fields say where it was added
// in its group's Google Doc, once it was (see recordExportDoc).
export async function getExport(env, id) {
  const row = await env.DB.prepare("SELECT * FROM exports WHERE id = ?").bind(id).first();
  return row
    ? {
        id: row.id,
        group: row.group_name,
        createdBy: row.created_by,
        since: row.since,
        until: row.until,
        exportedAt: row.exported_at,
        docId: row.doc_id,
        docUrl: row.doc_url,
        docLines: row.doc_lines ? JSON.parse(row.doc_lines) : [],
      }
    : null;
}

// What was chosen for each task in the export `id`, keyed
// by its message's "channel:ts", as { included, health, progress, notes }.
export async function exportItems(env, id) {
  const { results } = await env.DB.prepare("SELECT * FROM export_items WHERE export_id = ?").bind(id).all();
  return Object.fromEntries(
    results.map((row) => [
      `${row.task_channel}:${row.task_ts}`,
      { included: Boolean(row.included), health: row.health, progress: row.progress, notes: row.notes },
    ]),
  );
}

// Sets the period the draft `id` covers.
export async function setExportPeriod(env, id, since, until) {
  await env.DB.prepare("UPDATE exports SET since = ?, until = ? WHERE id = ? AND exported_at IS NULL")
    .bind(since, until, id)
    .run();
}

export async function putExportItem(env, id, channel, ts, item) {
  await env.DB.prepare(
    `INSERT INTO export_items (export_id, task_channel, task_ts, included, health, progress, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (export_id, task_channel, task_ts) DO UPDATE SET
       included = excluded.included, health = excluded.health,
       progress = excluded.progress, notes = excluded.notes`,
  )
    .bind(id, channel, ts, item.included ? 1 : 0, item.health ?? null, item.progress ?? "", item.notes ?? "")
    .run();
}

// Claims the draft for adding to the doc at `exportedAt`. Returns false if
// it was claimed already, by another click.
export async function claimExport(env, id, exportedAt) {
  const row = await env.DB.prepare(
    "UPDATE exports SET exported_at = ? WHERE id = ? AND exported_at IS NULL RETURNING id",
  )
    .bind(exportedAt, id)
    .first();
  return Boolean(row);
}

// Gives up the claim, when adding it to the doc failed, so it can be tried
// again.
export async function releaseExport(env, id) {
  await env.DB.prepare("UPDATE exports SET exported_at = NULL WHERE id = ? AND doc_url IS NULL").bind(id).run();
}

// Records that the export was added to the doc `docId`, its tab being at
// `url`, with `lines`, the text of each line written.
export async function recordExportDoc(env, id, docId, url, lines) {
  await env.DB.prepare("UPDATE exports SET doc_id = ?, doc_url = ?, doc_lines = ? WHERE id = ?")
    .bind(docId, url, JSON.stringify(lines), id)
    .run();
}

// Stores what an import found, `suggestion` being { kind, channel?, ts?,
// title?, text, details? }, unless it was found before.
export async function insertSuggestion(env, exportId, suggestion) {
  await env.DB.prepare(
    `INSERT INTO import_suggestions (export_id, kind, channel, ts, title, text, details)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(
      exportId,
      suggestion.kind,
      suggestion.channel ?? "",
      suggestion.ts ?? "",
      suggestion.title ?? "",
      suggestion.text,
      suggestion.details ?? "",
    )
    .run();
}

// All the export's suggestions, however they were decided.
export async function suggestions(env, exportId) {
  const { results } = await env.DB.prepare("SELECT * FROM import_suggestions WHERE export_id = ? ORDER BY id")
    .bind(exportId)
    .all();
  return results.map(suggestionFromRow);
}

// The export's suggestions still to decide, in the order they were found.
export async function pendingSuggestions(env, exportId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM import_suggestions WHERE export_id = ? AND status = 'PENDING' ORDER BY id",
  )
    .bind(exportId)
    .all();
  return results.map(suggestionFromRow);
}

export async function getSuggestion(env, id) {
  const row = await env.DB.prepare("SELECT * FROM import_suggestions WHERE id = ?").bind(id).first();
  return row ? suggestionFromRow(row) : null;
}

// Decides a pending suggestion: APPLIED or DISCARDED. Returns false if it
// was decided already, by another click.
export async function decideSuggestion(env, id, status, user) {
  const row = await env.DB.prepare(
    `UPDATE import_suggestions SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'PENDING' RETURNING id`,
  )
    .bind(status, user, id)
    .first();
  return Boolean(row);
}

function suggestionFromRow(row) {
  return {
    id: row.id,
    exportId: row.export_id,
    kind: row.kind,
    channel: row.channel,
    ts: row.ts,
    title: row.title,
    text: row.text,
    details: row.details,
    status: row.status,
  };
}

// Counts a post Slack refused, for the task `id`. After the last attempt it
// is given up: marked deleted, so it isn't tried again. Returns the attempts
// so far.
export async function countPostAttempt(env, id) {
  const { post_attempts: attempts } = await env.DB.prepare(
    `UPDATE tasks SET post_attempts = post_attempts + 1,
       deleted_at = CASE WHEN post_attempts + 1 >= ? THEN CURRENT_TIMESTAMP END
     WHERE id = ? RETURNING post_attempts`,
  )
    .bind(POST_ATTEMPTS, id)
    .first();
  return attempts;
}

async function insert(env, table, channel, row) {
  const columns = Object.keys(row);
  const { id } = await env.DB.prepare(
    `INSERT INTO ${table} (channel, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})
     RETURNING id`,
  )
    .bind(channel, ...Object.values(row))
    .first();
  return id;
}

// Writes `row` as the posted root message's row, adding it or replacing it.
async function upsert(env, table, channel, ts, row) {
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (channel, ts, ${columns.join(", ")})
     VALUES (?, ?, ${columns.map(() => "?").join(", ")})
     ON CONFLICT (channel, ts) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, ts, ...Object.values(row))
    .run();
}

function taskToRow(task) {
  return {
    title: task.title,
    priority: task.priority,
    status: task.status,
    due_date: task.dueDate ?? "",
    // The owners are kept in the developers column, from before the role
    // was renamed.
    developers: JSON.stringify(task.people.owner),
    reviewers: JSON.stringify(task.people.reviewer),
    testers: JSON.stringify(task.people.tester),
    prs: JSON.stringify(task.prs ?? []),
    created_by: task.createdBy,
    completed_at: task.completedAt ?? "",
    source_incident: task.incident ? 1 : 0,
    link: task.link ?? null,
    notes_url: task.notes?.url ?? null,
    notes_tab: task.notes?.tab ?? null,
  };
}

function taskFromRow(row) {
  return {
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    people: {
      owner: JSON.parse(row.developers),
      reviewer: JSON.parse(row.reviewers),
      tester: JSON.parse(row.testers),
    },
    prs: JSON.parse(row.prs),
    createdBy: row.created_by,
    completedAt: row.completed_at,
    // Whether it is an incident: always urgent and due immediately.
    incident: Boolean(row.source_incident),
    link: row.link || undefined,
    // The task's page in its project's Google Doc, once made (see notes.js).
    notes: row.notes_url ? { url: row.notes_url, tab: row.notes_tab } : undefined,
  };
}
