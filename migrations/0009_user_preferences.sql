-- What a person has chosen in Cade, kept for next time. For now it is what
-- their Home tab shows (see src/home.js): the project (group name; none
-- means every project) and the view (none means My Tasks).
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY,
  home_project TEXT,
  home_tab TEXT
);
