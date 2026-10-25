-- The channel canvases Cade keeps a summary in: open requirements in an
-- external channel, open tasks in a tasks or incidents channel (see
-- src/summary.js). A channel is listed once `/cade summary` has made or
-- taken over its canvas; only these are rewritten as things change.
CREATE TABLE canvases (
  channel TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
