-- SQLite / Cloudflare D1 合并后的初始迁移，直接建立第 4 版完整结构。
-- 后续版本继续追加独立迁移，不再保留发布前的增量步骤。
PRAGMA foreign_keys = ON;

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
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX aliases_subject_name ON subject_aliases(subject_id, name);
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
CREATE TABLE alias_miss_stats (
  normalized_name TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  miss_count INTEGER NOT NULL CHECK (miss_count > 0),
  first_missed_at INTEGER NOT NULL,
  last_missed_at INTEGER NOT NULL,
  planned INTEGER NOT NULL DEFAULT 1 CHECK (planned IN (0, 1))
);
CREATE INDEX alias_misses_count ON alias_miss_stats(miss_count DESC, last_missed_at DESC, normalized_name);
CREATE INDEX alias_misses_planned_count ON alias_miss_stats(planned, miss_count DESC, last_missed_at DESC, normalized_name);

-- 所有业务表创建成功后才写入就绪标识。
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (4);
