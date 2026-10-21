import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStorageConfig } from '../src/adapters/storage/node.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { parsePostgresInteger, PostgresDriver } from '../src/adapters/storage/postgres.ts';
import { sql } from '../src/adapters/storage/sql.ts';
import { postgresTestDatabase } from './helpers/postgres.ts';
import type { ImportRecord } from '../src/core/models.ts';

test('PostgreSQL 配置显式选择驱动、校验连接串和连接池，不暴露无效 URL', () => {
  assert.deepEqual(readStorageConfig({}), { driver: 'sqlite', path: './data/bangumi.sqlite' });
  assert.throws(() => readStorageConfig({ DATABASE_DRIVER: 'unknown' }));
  assert.throws(() => readStorageConfig({ DATABASE_DRIVER: 'postgres' }), /DATABASE_URL/);
  assert.throws(
    () =>
      readStorageConfig({
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'https://user:private-password@host/db',
      }),
    (error: unknown) => !String(error).includes('private-password'),
  );
  assert.deepEqual(
    readStorageConfig({
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://user:pass@localhost/db',
    }),
    { driver: 'postgres', url: 'postgresql://user:pass@localhost/db', poolSize: 10 },
  );
  for (const size of ['0', '-1', '1.5', '101'])
    assert.throws(() =>
      readStorageConfig({
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://localhost/db',
        DATABASE_POOL_SIZE: size,
      }),
    );
  assert.equal(parsePostgresInteger('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parsePostgresInteger('9007199254740992'), /安全范围/);
});

test('PostgreSQL 迁移幂等、事务回滚及错误版本拒绝', async () => {
  const target = await postgresTestDatabase(false);
  const repo = new SqlRepository(target.driver);
  try {
    const broken = await mkdtemp(join(tmpdir(), 'bangumi-postgres-migration-'));
    await writeFile(
      join(broken, '0001_initial.sql'),
      'CREATE TABLE schema_version(version INTEGER); INSERT INTO missing_table VALUES (1);',
    );
    await assert.rejects(target.driver.migrate(broken));
    assert.deepEqual(await repo.query(sql`SELECT to_regclass('schema_version') AS name`), [
      { name: null },
    ]);
    await target.driver.migrate();
    await target.driver.migrate();
    assert.equal(await repo.ready(), true);
    await assert.rejects(
      repo.batch([
        sql`INSERT INTO sync_state VALUES ('rollback', 'before', 1)`,
        sql`INSERT INTO subject_usage VALUES (999, 1, 1)`,
      ]),
    );
    assert.equal(await repo.getState('rollback'), null);
    await repo.setState('after_failure', 'ok');
    assert.equal(await repo.getState('after_failure'), 'ok');
    await repo.query(sql`UPDATE schema_version SET version=99`);
    await assert.rejects(target.driver.migrate(), /不支持的数据库版本/);
    assert.deepEqual(await repo.query(sql`SELECT version FROM schema_version`), [{ version: 99 }]);
  } finally {
    await target.close();
  }
});

test(
  'PostgreSQL 多实例并发迁移仅初始化一次',
  { skip: !process.env.TEST_POSTGRES_URL },
  async () => {
    // PGlite 的单连接多路复用不能验证多个服务端会话间的锁；此项由 CI 的真实 PostgreSQL 执行。
    const target = await postgresTestDatabase(false);
    const other = new PostgresDriver(target.url, 2);
    try {
      await Promise.all([target.driver.migrate(), other.migrate(), target.driver.migrate()]);
      assert.equal(await new SqlRepository(other).ready(), true);
    } finally {
      await other.close();
      await target.close();
    }
  },
);

test('PostgreSQL 数值精度、别名冲突、统计聚合与 SQLite 双向备份恢复', async () => {
  const target = await postgresTestDatabase();
  const repo = new SqlRepository(target.driver);
  const sqlite = new SqliteDriver(':memory:');
  sqlite.migrate();
  const other = new SqlRepository(sqlite);
  const now = Date.parse('2026-10-21T00:00:00Z');
  const id = Number.MAX_SAFE_INTEGER;
  const input: ImportRecord = {
    subject: {
      id,
      name: "问号? $1 ' 动画",
      nameCn: '中文',
      airDate: null,
      platform: 'TV',
      metadataAt: now,
      cachedAt: 1,
      pinned: false,
    },
    aliases: [],
    rating: {
      subjectId: id,
      score: 8.7,
      votes: 3000000000,
      rank: null,
      source: 'api',
      dataAsOf: now,
      fetchedAt: now,
    },
  };
  try {
    await repo.importRecord(input);
    assert.deepEqual((await repo.findSubjects([id]))[0], input.subject);
    assert.deepEqual((await repo.getRatings([id]))[0], input.rating);
    const alias = await repo.addManualAlias(id, '手动', now);
    await repo.addManualAlias(id, '重复', now);
    await assert.rejects(
      repo.updateManualAlias(alias.id, '重复', now),
      (error: unknown) => (error as { code: string }).code === 'ALIAS_EXISTS',
    );
    assert((await repo.listAliases(id)).some((row) => row.name === '手动'));
    await repo.recordHits([id, id], now);
    await repo.recordHits([id], now - 86400000);
    assert.deepEqual(await repo.stats(now), [
      {
        subjectId: id,
        name: input.subject.name,
        totalHits: 2,
        lastAccessedAt: now,
        hits7d: 2,
        hits30d: 2,
      },
    ]);
    assert.equal((await repo.retentionPreview(90, false, now)).candidates.length, 0);
    assert.equal((await repo.retentionPreview(90, true, now + 91 * 86400000)).candidates.length, 1);
    const backup = await repo.exportPage(0);
    for (const record of backup.records) await other.restoreRecord(record);
    // SQLite 返回无原型行对象；备份契约比较其实际 JSON 表示。
    assert.deepEqual(JSON.parse(JSON.stringify(await other.exportPage(0))), backup);
    // 外键级联删除后恢复，覆盖 PostgreSQL 的 JSON daily 导入路径。
    await repo.query(sql`DELETE FROM subjects WHERE id=${id}`);
    for (const record of (await other.exportPage(0)).records) await repo.restoreRecord(record);
    assert.deepEqual(await repo.exportPage(0), backup);
    await repo.query(sql`INSERT INTO subject_usage_daily
      SELECT ${id}, to_char(date '2000-01-01' + n, 'YYYY-MM-DD'), 1 FROM generate_series(0,1000) n`);
    assert.deepEqual(await repo.pruneDaily(90, now), { deleted: 1000, hasMore: true });
    assert.deepEqual(await repo.pruneDaily(90, now), { deleted: 1, hasMore: false });
    assert.deepEqual((await repo.exportPage(0)).records[0]?.daily, backup.records[0]?.daily);
    await assert.rejects(repo.query(sql`SELECT 9007199254740992::bigint AS unsafe`), /安全范围/);
    assert.equal(await repo.ready(), true);
  } finally {
    sqlite.close();
    await target.close();
  }
});

test('PostgreSQL CLI: 自动迁移、Archive 检查点续跑、别名和跨库备份', async () => {
  const target = await postgresTestDatabase(false);
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-postgres-cli-'));
  const file = join(dir, 'subjects.jsonlines');
  await writeFile(file, await readFile('tests/fixtures/subject.jsonl'));
  const run = (args: string[], driver = 'postgres') =>
    promisify(execFile)(process.execPath, ['dist/node/cli.js', ...args], {
      timeout: 20000,
      env: {
        ...process.env,
        DATABASE_DRIVER: driver,
        DATABASE_URL: target.url,
        DATABASE_POOL_SIZE: '1',
        DATABASE_PATH: join(dir, 'roundtrip.sqlite'),
        STATS_ENABLED: 'false',
        ADMIN_TOKEN: '',
        CALENDAR_SYNC_ENABLED: 'false',
      },
    });
  try {
    await run(['migrate']);
    await new SqlRepository(target.driver).recordAliasMisses(['unknown'], 1);
    assert.equal(JSON.parse((await run(['alias-misses'])).stdout)[0].missCount, 1);
    const args = [
      'sync-archive',
      '--file',
      file,
      '--as-of',
      '2026-01-01T00:00:00Z',
      '--limit',
      '1',
      '--checkpoint-interval',
      '1',
    ];
    assert.equal(JSON.parse((await run(args)).stdout).imported, 1);
    const second = await run(args);
    assert.equal(JSON.parse(second.stdout).imported, 1);
    assert(second.stderr.includes('archive_checkpoint'));
    assert.equal(JSON.parse((await run(args)).stdout).imported, 0);
    await run(['alias-add', '--id', '100', '--name', '手动第二季']);
    const backup = join(dir, 'backup.jsonl');
    const roundtrip = join(dir, 'roundtrip.jsonl');
    await run(['export', '--out', backup]);
    assert.equal(
      JSON.parse((await run(['import', '--file', backup], 'sqlite')).stdout).restored,
      2,
    );
    await run(['export', '--out', roundtrip], 'sqlite');
    assert.equal(await readFile(roundtrip, 'utf8'), await readFile(backup, 'utf8'));
    const repo = new SqlRepository(target.driver);
    await repo.query(sql`DELETE FROM subjects`);
    assert.equal(JSON.parse((await run(['import', '--file', roundtrip])).stdout).restored, 2);
    const restored = join(dir, 'restored.jsonl');
    await run(['export', '--out', restored]);
    assert.equal(await readFile(restored, 'utf8'), await readFile(backup, 'utf8'));
  } finally {
    await target.close();
  }
});
