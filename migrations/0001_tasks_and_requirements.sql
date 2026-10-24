-- Tasks and requirements. Each is stored before its Slack root message is
-- posted, so `ts` is NULL until then; a row Slack didn't take is posted again
-- later (see src/retry.js). The root messages and the Google Sheet are
-- rendered from these rows.

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  -- The tasks or incidents channel, and the root message's ts once posted.
  channel TEXT NOT NULL,
  ts TEXT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  due_date TEXT NOT NULL DEFAULT '',
  -- Slack user IDs and pull request addresses, as JSON arrays.
  developers TEXT NOT NULL DEFAULT '[]',
  reviewers TEXT NOT NULL DEFAULT '[]',
  testers TEXT NOT NULL DEFAULT '[]',
  prs TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  -- When the task was last set to DONE, as an ISO timestamp, or ''.
  completed_at TEXT NOT NULL DEFAULT '',
  -- The requirement or incident thread the task was tracked from, if any.
  source_channel TEXT,
  source_thread_ts TEXT,
  source_link TEXT,
  source_incident INTEGER NOT NULL DEFAULT 0,
  -- The root message's permalink, so the Sheet needn't look it up.
  link TEXT,
  -- Until it is posted: where it was tracked from, as JSON, for what
  -- follows the post, and how many posts Slack has refused.
  origin TEXT,
  post_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Deleted tasks are kept, as the Sheet keeps their rows.
  deleted_at TEXT,
  UNIQUE (channel, ts)
);

CREATE INDEX tasks_open ON tasks (channel, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_unposted ON tasks (created_at) WHERE ts IS NULL AND deleted_at IS NULL;

CREATE TABLE requirements (
  id INTEGER PRIMARY KEY,
  -- The external channel, and the root message's ts once posted.
  channel TEXT NOT NULL,
  ts TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  incident INTEGER NOT NULL DEFAULT 0,
  -- The task most recently tracked from the thread, if any.
  task_channel TEXT,
  task_ts TEXT,
  task_title TEXT,
  task_link TEXT,
  tracked_by TEXT,
  post_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (channel, ts)
);

CREATE INDEX requirements_unposted ON requirements (created_at) WHERE ts IS NULL AND deleted_at IS NULL;
