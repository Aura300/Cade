-- A task's thread, exported to its project's Google Doc (see src/export.js):
-- the address of its page and the ID of its tab under the doc's Export tab.
-- Both are NULL until someone chooses Export thread on the task's card.
ALTER TABLE tasks ADD COLUMN export_url TEXT;
ALTER TABLE tasks ADD COLUMN export_tab TEXT;
