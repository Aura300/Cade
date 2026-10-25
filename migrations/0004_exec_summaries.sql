-- Executive summaries (see src/commands/exec.js). `/cade exec` starts a
-- draft; its items are what was chosen for each task on the way through.
-- Once posted, a summary's time is where the next one starts, and its items
-- fill in the next one's health and progress.
CREATE TABLE exec_summaries (
  id INTEGER PRIMARY KEY,
  -- The channel pair's name.
  group_name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Tasks done since then are offered as completed, as an ISO timestamp.
  since TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- When and where it was posted, the time as an ISO timestamp.
  posted_at TEXT,
  posted_channel TEXT,
  posted_ts TEXT
);

CREATE INDEX exec_summaries_posted ON exec_summaries (group_name, posted_at);

CREATE TABLE exec_summary_items (
  summary_id INTEGER NOT NULL REFERENCES exec_summaries (id),
  -- The task's root message.
  task_channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  -- For an active task: ON_TRACK, AT_RISK, DELAYED or BLOCKED.
  health TEXT,
  -- Free text, such as 3/5.
  progress TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (summary_id, task_channel, task_ts)
);
