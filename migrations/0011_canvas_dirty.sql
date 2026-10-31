-- A summary is rewritten after a short delay, not on every change: a change
-- marks its channel's row with a new dirty_token, and whoever still holds the
-- latest token after the delay (or the cron, see src/retry.js) renders it. A
-- row for a channel whose first task was just made has no canvas yet, so
-- canvas_id may now be empty; the render makes it. Rebuilt, as SQLite can't
-- drop NOT NULL from a column.
CREATE TABLE canvases_new (
  channel TEXT PRIMARY KEY,
  canvas_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dirty_token TEXT
);
INSERT INTO canvases_new (channel, canvas_id, created_by, created_at)
  SELECT channel, canvas_id, created_by, created_at FROM canvases;
DROP TABLE canvases;
ALTER TABLE canvases_new RENAME TO canvases;
