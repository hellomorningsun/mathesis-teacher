-- Library for Mathesis Teacher. Videos are YouTube links; only their details are stored here.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  youtube_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',      -- JSON array of topic names
  level TEXT NOT NULL DEFAULT '',          -- Class VI … Class XII, BSc Mathematics
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  published INTEGER NOT NULL DEFAULT 1,    -- 1 = visible to students
  duration_sec INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX videos_published ON videos (published);

-- Wrong-password counters, so the limit holds across Cloudflare's servers.
CREATE TABLE login_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);
