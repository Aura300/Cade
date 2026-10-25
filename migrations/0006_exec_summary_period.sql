-- An executive summary covers a period, picked when it is written: `since`
-- is the start of its first day and `until` the end of its last, as ISO
-- timestamps, in the TIMEZONE the days are counted in.
ALTER TABLE exec_summaries ADD COLUMN until TEXT;
