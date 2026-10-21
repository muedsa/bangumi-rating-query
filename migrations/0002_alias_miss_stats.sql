CREATE TABLE alias_miss_stats (
  normalized_name TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  miss_count INTEGER NOT NULL CHECK (miss_count > 0),
  first_missed_at INTEGER NOT NULL,
  last_missed_at INTEGER NOT NULL
);
CREATE INDEX alias_misses_count ON alias_miss_stats(miss_count DESC, last_missed_at DESC, normalized_name);
UPDATE schema_version SET version=2 WHERE version=1;
