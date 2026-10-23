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

const legacyAliases = `INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
  VALUES ('official',1,'同名','同名','bangumi',1,2),('manual',1,'同名','同名','manual',3,4),
    ('other',1,'另一个名称','另一个名称','bangumi',5,6)`;

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

for (const kind of ['sqlite', 'postgres'] as const)
  test(`${kind}: v3 同名跨来源别名升级去重并约束唯一，失败回滚不丢数据`, async () => {
    const pg = kind === 'postgres' ? await postgresTestDatabase(false) : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    const repo = new SqlRepository(driver);
    const directory = kind === 'postgres' ? 'migrations/postgres' : 'migrations';
    const query = (sql: string) => driver.query({ sql, params: [] });
    try {
      for (const file of MIGRATIONS.slice(0, 3))
        for (const statement of (await readFile(`${directory}/${file}`, 'utf8'))
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await query(statement);
      await query("INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(1,'旧数据',1,1)");
      await query(legacyAliases);
      await query('INSERT INTO subject_usage VALUES(1,10,5)');
      const migration = await readFile(`${directory}/0004_alias_name_unique.sql`, 'utf8');
      const broken = await mkdtemp(join(tmpdir(), 'bangumi-schema-v4-'));
      await writeFile(
        join(broken, '0004_alias_name_unique.sql'),
        migration + '\nINSERT INTO missing_table VALUES(1);',
      );
      await assert.rejects(async () => driver.migrate(broken));
      assert.equal((await query('SELECT version FROM schema_version'))[0]!.version, 3);
      assert.equal((await repo.listAliases(1)).length, 3);
      await driver.migrate();
      await driver.migrate();
      assert.equal(await repo.ready(), true);
      const aliases = await repo.listAliases(1);
      assert.equal(aliases.length, 2);
      assert.deepEqual(
        { ...aliases.find((a) => a.name === '同名')! },
        {
          id: 'manual',
          subjectId: 1,
          name: '同名',
          normalizedName: '同名',
          source: 'manual',
          createdAt: 3,
          updatedAt: 4,
        },
      );
      assert.equal((await query('SELECT total_hits FROM subject_usage'))[0]!.total_hits, 5);
      await assert.rejects(
        query("INSERT INTO subject_aliases VALUES('duplicate',1,'同名','同名','bangumi',7,8)"),
      );
    } finally {
      if (pg) await pg.close();
      else driver.close();
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
      if (file === '0003_alias_miss_planned.sql') await db.prepare(legacyAliases).run();
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
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM subject_aliases').first())?.n, 2);
    assert.equal(
      (await db.prepare("SELECT id FROM subject_aliases WHERE name='同名'").first())?.id,
      'manual',
    );
    await assert.rejects(
      db
        .prepare("INSERT INTO subject_aliases VALUES('duplicate',1,'同名','同名','bangumi',7,8)")
        .run(),
    );
  } finally {
    await mf.dispose();
  }
});
