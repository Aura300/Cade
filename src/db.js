// Tasks and requirements are stored in D1 (the DB binding). Each is stored
// before its root message is posted; once posted, it is found by the
// message's channel and ts. The root message and the Google Sheet row are
// rendered from the row after every change (see saveTask and
// saveRequirement). The schema is in migrations/.

// How many times Cade tries to post a root message before giving up: once
// when it is made, then on each retry (see retry.js).
export const POST_ATTEMPTS = 5;

// Returns the task whose root message is `ts`, or null if there is none or
// it was deleted.
export async function getTask(env, channel, ts) {
  const row = await env.DB.prepare(
    "SELECT * FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL",
  )
    .bind(channel, ts)
    .first();
  return row ? taskFromRow(row) : null;
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

// The posted tasks in `channel` that are not Done, as { ts, task }, oldest
// first.
export async function openTasks(env, channel) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND status != 'DONE' AND deleted_at IS NULL
     ORDER BY ts`,
  )
    .bind(channel)
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
    source_link: task.source?.link ?? null,
    source_incident: task.source?.incident ? 1 : 0,
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
