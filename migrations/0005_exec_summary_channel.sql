-- An executive summary is written in any channel and posted there, so each
-- draft remembers which. Its items (exec_summary_items) are requirements and
-- incidents, by their message in the external channel, and tasks with no
-- requirement, by theirs in the dev channel.
ALTER TABLE exec_summaries ADD COLUMN channel TEXT;
