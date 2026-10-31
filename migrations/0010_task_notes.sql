-- A task's page in its project's Google Doc (see src/notes.js): its address,
-- and the ID of its tab under the doc's Notes tab. Both are NULL until a
-- Refresh makes the page.
ALTER TABLE tasks ADD COLUMN notes_url TEXT;
ALTER TABLE tasks ADD COLUMN notes_tab TEXT;
