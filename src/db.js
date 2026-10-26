// Tasks and requirements are stored in D1 (the DB binding). Each is stored
// before its root message is posted; once posted, it is found by the
// message's channel and ts. The root message and the Google Sheet row are
// rendered from the row after every change (see saveTask and
// saveRequirement). The schema is in migrations/.

// How many times Cade tries to post a root message before giving up: once
// when it is made, then on each retry (see retry.js).
export const POST_ATTEMPTS = 5;

// Returns the task whose root message is `ts`, or null if there is none or
// it was deleted. It comes with its releases, which its message shows.
export async function getTask(env, channel, ts) {
  const row = await env.DB.prepare(
    "SELECT * FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL",
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
     SELECT id, ?, ?, ?, ?, ? FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL
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

// Returns the task whose root message is `ts`, deleted or not, with
// `deleted` saying which, or null if there is none. A deleted task's
// messages may still be in Slack, if deleting them failed.
export async function getTaskIncludingDeleted(env, channel, ts) {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE channel = ? AND ts = ?")
    .bind(channel, ts)
    .first();
  return row ? { ...taskFromRow(row), deleted: Boolean(row.deleted_at) } : null;
}

// The posted task most recently tracked from the requirement thread
// `source` ({ channel, threadTs }), deleted or not, as { channel, ts, title,
// link, deleted }, or null. The requirement links to it too, unless storing
// that link failed.
export async function latestTaskFrom(env, source) {
  const row = await env.DB.prepare(
    `SELECT channel, ts, title, link, deleted_at FROM tasks
     WHERE source_channel = ? AND source_thread_ts = ? AND ts IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(source.channel, source.threadTs)
    .first();
  return row
    ? { channel: row.channel, ts: row.ts, title: row.title, link: row.link || undefined, deleted: Boolean(row.deleted_at) }
    : null;
}

// Marks deleted the tasks tracked from the thread that are waiting to be
// posted, so a retry doesn't post them.
export async function markUnpostedTasksDeleted(env, source) {
  await env.DB.prepare(
    `UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP
     WHERE source_channel = ? AND source_thread_ts = ? AND ts IS NULL AND deleted_at IS NULL`,
  )
    .bind(source.channel, source.threadTs)
    .run();
}

// The posted tasks in `channel` with one of `statuses`, as { ts, task },
// oldest first.
export async function tasksWithStatus(env, channel, statuses) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL
       AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY ts`,
  )
    .bind(channel, ...statuses)
    .all();
  return results.map((row) => ({ ts: row.ts, task: taskFromRow(row) }));
}

// Whether a task tracked from the thread is waiting to be posted.
export async function hasUnpostedTask(env, source) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM tasks
     WHERE source_channel = ? AND source_thread_ts = ? AND ts IS NULL AND deleted_at IS NULL`,
  )
    .bind(source.channel, source.threadTs)
    .first();
  return Boolean(row);
}

// The tasks whose root message Slack hasn't taken yet, as { id, channel,
// task, origin, attempts }, oldest first. Only those made a minute or more
// ago, so a post still under way isn't made twice.
export async function unpostedTasks(env) {
  const results = await unposted(env, "tasks");
  return results.map((row) => ({
    id: row.id,
    channel: row.channel,
    task: taskFromRow(row),
    origin: JSON.parse(row.origin ?? "{}"),
    attempts: row.post_attempts,
  }));
}

// Returns the requirement whose root message is `ts`, as getTask does.
export async function getRequirement(env, channel, ts) {
  const row = await env.DB.prepare(
    "SELECT * FROM requirements WHERE channel = ? AND ts = ? AND deleted_at IS NULL",
  )
    .bind(channel, ts)
    .first();
  return row ? requirementFromRow(row) : null;
}

// Stores a new requirement that is about to be posted, and returns its id.
export async function insertRequirement(env, channel, requirement) {
  return insert(env, "requirements", channel, requirementToRow(requirement));
}

export async function markRequirementPosted(env, id, ts) {
  await env.DB.prepare(
    "UPDATE requirements SET ts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(ts, id)
    .run();
}

export async function putRequirement(env, channel, ts, requirement) {
  await upsert(env, "requirements", channel, ts, requirementToRow(requirement));
}

export async function markRequirementDeleted(env, channel, ts) {
  await env.DB.prepare(
    "UPDATE requirements SET deleted_at = CURRENT_TIMESTAMP WHERE channel = ? AND ts = ?",
  )
    .bind(channel, ts)
    .run();
}

// The posted requirements and incidents in `channel` that aren't done or
// deleted, as { ts, title, incident }, newest first: at most 100, as many as
// a Slack menu takes.
export async function activeRequirements(env, channel) {
  const { results } = await env.DB.prepare(
    `SELECT ts, title, incident FROM requirements
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL AND status != 'DONE'
     ORDER BY id DESC LIMIT 100`,
  )
    .bind(channel)
    .all();
  return results.map((row) => ({ ts: row.ts, title: row.title, incident: Boolean(row.incident) }));
}

// The posted requirements and incidents in `channel` that aren't deleted,
// as { ts, requirement, updatedAt }, oldest first.
export async function postedRequirements(env, channel) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requirements
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL
     ORDER BY ts`,
  )
    .bind(channel)
    .all();
  return results.map((row) => ({ ts: row.ts, requirement: requirementFromRow(row), updatedAt: row.updated_at }));
}

// The id of the canvas Cade keeps the channel's summary in, or null.
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

// What was chosen for each requirement or task in the export `id`, keyed
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

// The requirements whose root message Slack hasn't taken yet, as { id,
// channel, requirement, attempts }, as for unpostedTasks.
export async function unpostedRequirements(env) {
  const results = await unposted(env, "requirements");
  return results.map((row) => ({
    id: row.id,
    channel: row.channel,
    requirement: requirementFromRow(row),
    attempts: row.post_attempts,
  }));
}

// Counts a post Slack refused, for the task or requirement `id` in `table`.
// After the last attempt it is given up: marked deleted, so it isn't tried
// again and its thread can be tracked afresh. Returns the attempts so far.
export async function countPostAttempt(env, table, id) {
  const { post_attempts: attempts } = await env.DB.prepare(
    `UPDATE ${table} SET post_attempts = post_attempts + 1,
       deleted_at = CASE WHEN post_attempts + 1 >= ? THEN CURRENT_TIMESTAMP END
     WHERE id = ? RETURNING post_attempts`,
  )
    .bind(POST_ATTEMPTS, id)
    .first();
  return attempts;
}

async function unposted(env, table) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table}
     WHERE ts IS NULL AND deleted_at IS NULL AND created_at <= datetime('now', '-1 minute')
     ORDER BY id`,
  ).all();
  return results;
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
    developers: JSON.stringify(task.people.developer),
    reviewers: JSON.stringify(task.people.reviewer),
    testers: JSON.stringify(task.people.tester),
    prs: JSON.stringify(task.prs ?? []),
    created_by: task.createdBy,
    completed_at: task.completedAt ?? "",
    source_channel: task.source?.channel ?? null,
    source_thread_ts: task.source?.threadTs ?? null,
    // A detached task keeps the link to where it was tracked from.
    source_link: (task.source ?? task.trackedFrom)?.link ?? null,
    source_incident: (task.source ?? task.trackedFrom)?.incident ? 1 : 0,
    link: task.link ?? null,
  };
}

function taskFromRow(row) {
  return {
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    people: {
      developer: JSON.parse(row.developers),
      reviewer: JSON.parse(row.reviewers),
      tester: JSON.parse(row.testers),
    },
    prs: JSON.parse(row.prs),
    createdBy: row.created_by,
    completedAt: row.completed_at,
    source: row.source_channel
      ? {
          channel: row.source_channel,
          threadTs: row.source_thread_ts,
          link: row.source_link || undefined,
          incident: Boolean(row.source_incident),
        }
      : undefined,
    // Where a task detached from its requirement or incident was tracked
    // from, as { link, incident }; only shown, as it no longer follows it.
    ...(!row.source_channel &&
      row.source_link && { trackedFrom: { link: row.source_link, incident: Boolean(row.source_incident) } }),
    link: row.link || undefined,
  };
}

function requirementToRow(requirement) {
  return {
    title: requirement.title,
    status: requirement.status,
    priority: requirement.priority ?? "",
    due_date: requirement.dueDate ?? "",
    created_by: requirement.createdBy,
    incident: requirement.incident ? 1 : 0,
    task_channel: requirement.task?.channel ?? null,
    task_ts: requirement.task?.ts ?? null,
    task_title: requirement.task?.title ?? null,
    task_link: requirement.task?.link ?? null,
    tracked_by: requirement.task?.trackedBy ?? null,
  };
}

function requirementFromRow(row) {
  return {
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    createdBy: row.created_by,
    incident: Boolean(row.incident),
    task: row.task_ts
      ? {
          channel: row.task_channel,
          ts: row.task_ts,
          title: row.task_title,
          link: row.task_link,
          trackedBy: row.tracked_by,
        }
      : undefined,
  };
}
