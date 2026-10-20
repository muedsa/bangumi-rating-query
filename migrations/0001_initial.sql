PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_cn TEXT NOT NULL DEFAULT '',
  air_date TEXT,
  platform TEXT NOT NULL DEFAULT '',
  metadata_at INTEGER NOT NULL,
  cached_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);
CREATE TABLE subject_aliases (
  id TEXT PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bangumi', 'manual')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_id, name, source)
);
CREATE INDEX aliases_normalized ON subject_aliases(normalized_name, subject_id);
CREATE INDEX aliases_subject ON subject_aliases(subject_id);

CREATE TABLE ratings_current (
  subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  votes INTEGER NOT NULL CHECK (votes >= 0),
  rank INTEGER,
  source TEXT NOT NULL CHECK (source IN ('archive', 'api')),
  data_as_of INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE subject_usage (
  subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  last_accessed_at INTEGER NOT NULL,
  total_hits INTEGER NOT NULL CHECK (total_hits >= 0)
);
CREATE TABLE subject_usage_daily (
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0),
  PRIMARY KEY(subject_id, day)
);
CREATE INDEX usage_daily_day ON subject_usage_daily(day);
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
