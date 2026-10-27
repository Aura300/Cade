-- Archived tasks (see src/commands/archive.js): Cade stops tracking them,
-- as it does deleted ones, but keeps their card and thread, and lists them
-- in the summary's Archived section. A task deleted after it was archived
-- has deleted_at set too, and leaves that section.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN archived_by TEXT;
