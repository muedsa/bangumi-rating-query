import { test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  pendingMigrations,
  readSchemaVersion,
} from '../../src/adapters/storage/schema.ts';

test('迁移清单按目标版本选择，合并基线不再按数组下标推算', () => {
  expect(MIGRATIONS[0]).toEqual({ version: 4, file: '0001_initial.sql' });
  expect(MIGRATIONS.at(-1)!.version).toBe(SCHEMA_VERSION);
  expect(pendingMigrations(0)).toEqual([...MIGRATIONS]);
  expect(pendingMigrations(SCHEMA_VERSION)).toEqual([]);
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const current = MIGRATIONS[i]!;
    expect(pendingMigrations(current.version)).toEqual(MIGRATIONS.slice(i + 1));
    if (i > 0) expect(current.version).toBeGreaterThan(MIGRATIONS[i - 1]!.version);
  }
  const files = MIGRATIONS.map((migration) => migration.file).sort();
  for (const directory of ['migrations', 'migrations/postgres'])
    expect(
      readdirSync(directory)
        .filter((file) => file.endsWith('.sql'))
        .sort(),
    ).toEqual(files);
});

test('结构版本保留当前库兼容，拒绝发布前旧版、未知版及损坏的标识', () => {
  expect(readSchemaVersion([{ version: SCHEMA_VERSION }])).toBe(SCHEMA_VERSION);
  for (const version of [-1, 0, 1, 2, 3, 4.5, SCHEMA_VERSION + 1, '4', null])
    expect(() => readSchemaVersion([{ version }])).toThrow('不支持的数据库版本');
  expect(() => readSchemaVersion([])).toThrow('不支持的数据库版本');
  expect(() => readSchemaVersion([{ version: 4 }, { version: 4 }])).toThrow('不支持的数据库版本');
});
