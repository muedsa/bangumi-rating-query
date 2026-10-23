export const SCHEMA_VERSION = 4;
export const MIGRATIONS = [
  '0001_initial.sql',
  '0002_alias_miss_stats.sql',
  '0003_alias_miss_planned.sql',
  '0004_alias_name_unique.sql',
] as const;

export function readSchemaVersion(rows: { version: unknown }[]) {
  if (rows.length !== 1 || !Number.isInteger(rows[0]?.version))
    throw new Error('不支持的数据库版本');
  const version = Number(rows[0]!.version);
  if (version < 1 || version > SCHEMA_VERSION) throw new Error('不支持的数据库版本');
  return version;
}
