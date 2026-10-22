import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/adapters/storage/schema.ts';
import { postgresTestDatabase } from './helpers/postgres.ts';

test('SQLite 旧版库升级保留数据，失败回滚并可重试，旧版库暂不就绪', async () => {
  const driver = new SqliteDriver(':memory:');
  const repo = new SqlRepository(driver);
  try {
    driver.db.exec(await readFile('migrations/0001_initial.sql', 'utf8'));
    driver.db.exec("INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'旧数据',1,1)");
    assert.equal(await repo.ready(), false);
    const broken = await mkdtemp(join(tmpdir(), 'bangumi-schema-v2-'));
    await writeFile(
      join(broken, '0002_alias_miss_stats.sql'),
      'CREATE TABLE alias_miss_stats(id INTEGER); INSERT INTO missing_table VALUES(1);',
    );
    assert.throws(() => driver.migrate(broken));
    assert.equal(driver.db.prepare('SELECT version FROM schema_version').get()!.version, 1);
    assert.equal(
      driver.db.prepare("SELECT 1 FROM sqlite_master WHERE name='alias_miss_stats'").get(),
      undefined,
    );
    driver.migrate();
    driver.migrate();
    assert.equal(await repo.ready(), true);
    assert.equal((await repo.findSubjects([1]))[0]?.name, '旧数据');
    await repo.recordAliasMisses(['Missing', 'ＭＩＳＳＩＮＧ'], 100);
    await repo.recordAliasMisses(['missing'], 50);
    const rows = await repo.aliasMissStats();
    assert.equal(rows[0]?.missCount, 2);
    assert.equal(rows[0]?.firstMissedAt, 50);
    assert.equal(rows[0]?.lastMissedAt, 100);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => repo.recordAliasMisses(['missing'], 101 + i)),
    );
    assert.equal((await repo.aliasMissStats())[0]?.missCount, 7);
    assert.equal(rows[0]?.name, 'ＭＩＳＳＩＮＧ');
    driver.db.exec('UPDATE schema_version SET version=99');
    assert.throws(() => driver.migrate(), /不支持的数据库版本/);
  } finally {
    driver.close();
  }
});

test('PostgreSQL 旧版库升级保留数据并支持未命中别名统计', async () => {
  const target = await postgresTestDatabase(false);
  const repo = new SqlRepository(target.driver);
  try {
    await target.driver.query({
      sql: await readFile('migrations/postgres/0001_initial.sql', 'utf8'),
      params: [],
    });
    await target.driver.query({
      sql: "INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'旧数据',1,1)",
      params: [],
    });
    assert.equal(await repo.ready(), false);
    await target.driver.migrate();
    await target.driver.migrate();
    assert.equal(await repo.ready(), true);
    assert.equal((await repo.findSubjects([1]))[0]?.name, '旧数据');
    await repo.recordAliasMisses(['Missing', 'ＭＩＳＳＩＮＧ'], 100);
    await repo.recordAliasMisses(['missing'], 50);
    const rows = await repo.aliasMissStats();
    assert.equal(rows[0]?.missCount, 2);
    assert.equal(rows[0]?.firstMissedAt, 50);
    assert.equal(rows[0]?.lastMissedAt, 100);
  } finally {
    await target.close();
  }
});

for (const kind of ['sqlite', 'postgres'] as const)
  test(`${kind}: v2 未命中记录升级默认有计划且保留统计，失败回滚后可重试`, async () => {
    const pg = kind === 'postgres' ? await postgresTestDatabase(false) : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    const repo = new SqlRepository(driver);
    const query = (sql: string) => driver.query({ sql, params: [] });
    const directory = kind === 'postgres' ? 'migrations/postgres' : 'migrations';
    try {
      for (const file of MIGRATIONS.slice(0, 2))
        for (const sql of (await readFile(`${directory}/${file}`, 'utf8'))
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await query(sql);
      await query("INSERT INTO alias_miss_stats VALUES ('missing','Missing',3,50,100)");
      assert.equal(await repo.ready(), false);
      const broken = await mkdtemp(join(tmpdir(), 'bangumi-schema-v3-'));
      await writeFile(
        join(broken, '0003_alias_miss_planned.sql'),
        'ALTER TABLE alias_miss_stats ADD COLUMN planned INTEGER NOT NULL DEFAULT 1; INSERT INTO missing_table VALUES(1);',
      );
      await assert.rejects(async () => driver.migrate(broken));
      assert.equal((await query('SELECT version FROM schema_version'))[0]!.version, 2);
      assert.equal('planned' in (await query('SELECT * FROM alias_miss_stats'))[0]!, false);
      await driver.migrate();
      await driver.migrate();
      assert.equal(await repo.ready(), true);
      assert.deepEqual(await repo.aliasMissStats(true), [
        {
          name: 'Missing',
          normalizedName: 'missing',
          missCount: 3,
          firstMissedAt: 50,
          lastMissedAt: 100,
          planned: true,
        },
      ]);
      await repo.setAliasMissPlanned('missing', false);
      await driver.migrate();
      assert.equal((await repo.aliasMissStats())[0]!.planned, false);
    } finally {
      if (pg) await pg.close();
      else await driver.close();
    }
  });

test('D1 按顺序应用增量迁移后保留旧数据并更新 schema_version', async () => {
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
    for (const file of MIGRATIONS) {
      for (const statement of (await readFile(`migrations/${file}`, 'utf8'))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
      if (file === '0001_initial.sql')
        await db
          .prepare("INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'旧数据',1,1)")
          .run();
      if (file === '0002_alias_miss_stats.sql')
        await db
          .prepare("INSERT INTO alias_miss_stats VALUES ('missing','Missing',3,50,100)")
          .run();
    }
    assert.equal(
      (await db.prepare('SELECT version FROM schema_version').first())?.version,
      SCHEMA_VERSION,
    );
    assert.deepEqual(await db.prepare('SELECT * FROM alias_miss_stats').first(), {
      normalized_name: 'missing',
      name: 'Missing',
      miss_count: 3,
      first_missed_at: 50,
      last_missed_at: 100,
      planned: 1,
    });
    assert.equal(
      (await db.prepare('SELECT name FROM subjects WHERE id=1').first())?.name,
      '旧数据',
    );
  } finally {
    await mf.dispose();
  }
});
