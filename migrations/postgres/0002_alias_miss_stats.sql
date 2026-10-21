CREATE TABLE alias_miss_stats (
  normalized_name TEXT COLLATE "C" PRIMARY KEY,
  name TEXT COLLATE "C" NOT NULL,
  miss_count BIGINT NOT NULL CHECK (miss_count > 0),
  first_missed_at BIGINT NOT NULL,
  last_missed_at BIGINT NOT NULL
);
CREATE INDEX alias_misses_count ON alias_miss_stats(miss_count DESC, last_missed_at DESC, normalized_name);
UPDATE schema_version SET version=2 WHERE version=1;
