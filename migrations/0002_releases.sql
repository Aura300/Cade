-- Partial releases: some of a requirement task's PRs, sent to the client for
-- approval before the whole task is done (see src/commands/release.js). The
-- PRs are a JSON array of addresses, as in tasks.prs. A release the client
-- doesn't approve is kept as NOT_APPROVED, and its PRs can be sent again.
CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  prs TEXT NOT NULL DEFAULT '[]',
  -- What the release completes, as the team described it.
  note TEXT NOT NULL,
  -- PENDING_APPROVAL, APPROVED or NOT_APPROVED.
  status TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Who approved or turned it down in the requirement thread, and when.
  decided_by TEXT,
  decided_at TEXT
);

CREATE INDEX releases_by_task ON releases (task_id);
