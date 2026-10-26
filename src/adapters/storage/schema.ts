// 发布前的增量步骤已合并；沿用文件名以兼容 D1 已登记的迁移历史。
export const SCHEMA_VERSION = 4;
export const MIGRATIONS = [{ version: 4, file: '0001_initial.sql' }] as const;

export function pendingMigrations(version: number) {
  return MIGRATIONS.filter((migration) => migration.version > version);
}

export function readSchemaVersion(rows: { version: unknown }[]) {
  if (rows.length !== 1 || !Number.isInteger(rows[0]?.version))
    throw new Error('不支持的数据库版本');
  const version = Number(rows[0]!.version);
  if (version < MIGRATIONS[0].version || version > SCHEMA_VERSION)
    throw new Error('不支持的数据库版本；发布前旧结构请导出备份后恢复到新库');
  return version;
}
