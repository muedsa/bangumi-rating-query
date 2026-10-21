-- C 排序规则与 SQLite 的二进制文本排序一致，跨库备份保持稳定顺序。
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);

CREATE TABLE subjects (
  id BIGINT PRIMARY KEY,
  name TEXT COLLATE "C" NOT NULL,
  name_cn TEXT COLLATE "C" NOT NULL DEFAULT '',
  air_date TEXT COLLATE "C",
  platform TEXT COLLATE "C" NOT NULL DEFAULT '',
  metadata_at BIGINT NOT NULL,
  cached_at BIGINT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);
CREATE TABLE subject_aliases (
  id TEXT COLLATE "C" PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT COLLATE "C" NOT NULL,
  normalized_name TEXT COLLATE "C" NOT NULL,
  source TEXT COLLATE "C" NOT NULL CHECK (source IN ('bangumi', 'manual')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(subject_id, name, source)
);
CREATE INDEX aliases_normalized ON subject_aliases(normalized_name, subject_id);
CREATE INDEX aliases_subject ON subject_aliases(subject_id);

CREATE TABLE ratings_current (
  subject_id BIGINT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  votes BIGINT NOT NULL CHECK (votes >= 0),
  rank BIGINT,
  source TEXT COLLATE "C" NOT NULL CHECK (source IN ('archive', 'api')),
  data_as_of BIGINT NOT NULL,
  fetched_at BIGINT NOT NULL
);
CREATE TABLE subject_usage (
  subject_id BIGINT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  last_accessed_at BIGINT NOT NULL,
  total_hits BIGINT NOT NULL CHECK (total_hits >= 0)
);
CREATE TABLE subject_usage_daily (
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  day TEXT COLLATE "C" NOT NULL,
  hits BIGINT NOT NULL CHECK (hits >= 0),
  PRIMARY KEY(subject_id, day)
);
CREATE INDEX usage_daily_day ON subject_usage_daily(day);
CREATE TABLE sync_state (
  key TEXT COLLATE "C" PRIMARY KEY,
  value TEXT COLLATE "C" NOT NULL,
  updated_at BIGINT NOT NULL
);
