import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/adapters/storage/schema.ts';
import { postgresTestDatabase } from './helpers/postgres.ts';

for (const kind of ['sqlite', 'postgres'] as const) {
  test(`${kind}: 初始化直接包含完整结构，重复启动保留数据，旧结构拒绝自动升级`, async (t) => {
    const pg = kind === 'postgres' ? await postgresTestDatabase(false) : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    t.after(() => (pg ? pg.close() : driver.close()));
    const repo = new SqlRepository(driver);
    const query = (sql: string) => driver.query({ sql, params: [] });
    await driver.migrate();
    assert.equal(await repo.ready(), true);
    await query(
      "INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'已初始化的数据',1,1)",
    );
    const manual = await repo.addManualAlias(1, '同名', 1);
    await assert.rejects(
      query("INSERT INTO subject_aliases VALUES('duplicate',1,'同名','同名','bangumi',2,2)"),
    );
    await query(
      "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('planned','Planned',1,1,1)",
    );
    assert.equal((await repo.aliasMissStats())[0]?.planned, true);
    await repo.setAliasMissPlanned('planned', false);
    await repo.recordAliasMisses(['Missing', 'ＭＩＳＳＩＮＧ'], 100);
    await repo.recordAliasMisses(['missing'], 50);
    const miss = (await repo.aliasMissStats(true))[0]!;
    assert.equal(miss.missCount, 2);
    assert.equal(miss.firstMissedAt, 50);
    assert.equal(miss.lastMissedAt, 100);
    await repo.setState('checkpoint', 'keep');
    const before = JSON.stringify(await repo.exportPage(0));
    // 已有当前结构不再执行 SQL，也不依赖初始化文件仍可读取。
    await driver.migrate('missing-migration-directory');
    assert.equal(JSON.stringify(await repo.exportPage(0)), before);
    assert.equal((await repo.aliasMissStats(false))[0]?.planned, false);
    assert.equal(await repo.getState('checkpoint'), 'keep');
    assert.equal((await repo.listAliases(1))[0]?.id, manual.id);
    for (const version of [1, 2, 3, 99]) {
      await query(`UPDATE schema_version SET version=${version}`);
      assert.equal(await repo.ready(), false);
      await assert.rejects(async () => driver.migrate(), /不支持的数据库版本/);
      assert.equal((await query('SELECT version FROM schema_version'))[0]?.version, version);
      assert.equal(JSON.stringify(await repo.exportPage(0)), before);
    }
    await query('DELETE FROM schema_version');
    await assert.rejects(async () => driver.migrate(), /不支持的数据库版本/);
    await query(`INSERT INTO schema_version VALUES (${SCHEMA_VERSION}), (99)`);
    await assert.rejects(async () => driver.migrate(), /不支持的数据库版本/);
  });

  test(`${kind}: 合并后的初始迁移失败整批回滚，可重试`, async (t) => {
    const pg = kind === 'postgres' ? await postgresTestDatabase(false) : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    t.after(() => (pg ? pg.close() : driver.close()));
    const query = (sql: string) => driver.query({ sql, params: [] });
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-init-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const broken = join(dir, MIGRATIONS[0].file);
    const source = await readFile(
      `${kind === 'postgres' ? 'migrations/postgres' : 'migrations'}/${MIGRATIONS[0].file}`,
      'utf8',
    );
    await writeFile(broken, source + '\nINSERT INTO missing_table VALUES (1);');
    await assert.rejects(async () => driver.migrate(dir));
    const tables =
      kind === 'postgres'
        ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()'
        : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
    assert.deepEqual(await query(tables), []);
    await driver.migrate();
    assert.equal(await new SqlRepository(driver).ready(), true);
  });
}

test('D1 单份初始化 SQL 包含索引、外键、别名唯一和计划默认值，重复执行不覆盖数据', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: 'dist/worker.js',
      compatibilityDate: '2026-10-20',
      d1Databases: ['DB'],
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    const statements = (await readFile(`migrations/${MIGRATIONS[0].file}`, 'utf8'))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
    const ready = await mf.dispatchFetch('http://localhost/health/ready');
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { schemaVersion: number }).schemaVersion, SCHEMA_VERSION);
    await db
      .prepare("INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'已初始化的数据',1,1)")
      .run();
    await db
      .prepare("INSERT INTO subject_aliases VALUES('manual',1,'同名','同名','manual',1,1)")
      .run();
    await assert.rejects(
      db
        .prepare("INSERT INTO subject_aliases VALUES('official',1,'同名','同名','bangumi',2,2)")
        .run(),
    );
    await db
      .prepare(
        "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('missing','Missing',3,50,100)",
      )
      .run();
    assert.equal((await db.prepare('SELECT planned FROM alias_miss_stats').first())?.planned, 1);
    const indexes = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
    ).results.map((row) => row.name);
    for (const name of [
      'aliases_subject_name',
      'aliases_normalized',
      'aliases_subject',
      'alias_misses_count',
      'alias_misses_planned_count',
      'usage_daily_day',
    ])
      assert(indexes.includes(name));
    await assert.rejects(db.prepare('INSERT INTO subject_usage VALUES(999,1,1)').run());
    await assert.rejects(db.batch(statements.map((sql) => db.prepare(sql))));
    assert.equal(
      (await db.prepare('SELECT name FROM subjects WHERE id=1').first())?.name,
      '已初始化的数据',
    );
    await db.prepare('DELETE FROM subjects WHERE id=1').run();
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM subject_aliases').first())?.n, 0);
  } finally {
    await mf.dispose();
  }
});
