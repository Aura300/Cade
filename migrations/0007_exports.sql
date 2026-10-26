-- Executive summaries are exported to the group's Google Doc rather than
-- posted in Slack, and what the client call added to them is imported back
-- (see src/commands/brief.js and src/commands/debrief.js). None were written
-- before this, so the old tables are replaced rather than changed.
DROP TABLE exec_summary_items;
DROP TABLE exec_summaries;

-- `/cade brief` starts a draft; its items are what was chosen for each
-- requirement or task on the way through. Once exported, its period's end is
-- where the next one starts, and its items fill in the next one's health and
-- progress.
CREATE TABLE exports (
  id INTEGER PRIMARY KEY,
  -- The channel pair's name.
  group_name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- The period it covers: the start of its first day and the end of its
  -- last, as ISO timestamps, in the TIMEZONE the days are counted in.
  since TEXT NOT NULL,
  until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- When it was added to the doc, as an ISO timestamp, set as it is being
  -- added so it is added once.
  exported_at TEXT,
  -- The doc and its Summary tab's address, once added, and the text of each
  -- line Cade wrote, as a JSON array, so what was added after can be told
  -- apart.
  doc_id TEXT,
  doc_url TEXT,
  doc_lines TEXT
);

CREATE INDEX exports_done ON exports (group_name, exported_at);

CREATE TABLE export_items (
  export_id INTEGER NOT NULL REFERENCES exports (id),
  -- Requirements and incidents by their message in the external channel,
  -- tasks with no requirement by theirs in the dev channel.
  task_channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  -- For active work: ON_TRACK, AT_RISK, DELAYED or BLOCKED.
  health TEXT,
  -- Free text, such as 3/5.
  progress TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (export_id, task_channel, task_ts)
);

-- What `/cade debrief` found added to an export's section of the doc:
--   POINT        a line under one of its requirements or tasks, to post in
--                its thread (`channel`, `ts`)
--   REQUIREMENT  a line of its own, with no link, to start as a requirement;
--                `details` are the lines under it
-- Each is suggested until it is APPLIED or DISCARDED, and found only once.
CREATE TABLE import_suggestions (
  id INTEGER PRIMARY KEY,
  export_id INTEGER NOT NULL REFERENCES exports (id),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE (export_id, kind, channel, ts, text)
);
