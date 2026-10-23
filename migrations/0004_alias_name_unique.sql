-- 旧版允许同名的不同来源并存，保留手动记录及其 ID，延续上游刷新保护。
DELETE FROM subject_aliases
WHERE source='bangumi' AND EXISTS (
  SELECT 1 FROM subject_aliases AS manual
  WHERE manual.subject_id=subject_aliases.subject_id
    AND manual.name=subject_aliases.name AND manual.source='manual'
);
CREATE UNIQUE INDEX aliases_subject_name ON subject_aliases(subject_id, name);
UPDATE schema_version SET version=4 WHERE version=3;
