ALTER TABLE alias_miss_stats ADD COLUMN planned INTEGER NOT NULL DEFAULT 1 CHECK (planned IN (0, 1));
CREATE INDEX alias_misses_planned_count ON alias_miss_stats(planned, miss_count DESC, last_missed_at DESC, normalized_name);
UPDATE schema_version SET version=3 WHERE version=2;
