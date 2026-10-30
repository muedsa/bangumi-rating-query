import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { importSchema } from '../src/core/models.ts';
import type { SqlDriver } from '../src/adapters/storage/sql.ts';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { D1Driver } from '../src/adapters/storage/d1.ts';
import { PostgresDriver } from '../src/adapters/storage/postgres.ts';
import { ALIAS_WRITE_REVISION_KEY } from '../src/adapters/storage/alias-write.ts';
import { postgresTestDatabase } from './helpers/postgres.ts';
import { backupFixture } from './helpers/backup.ts';

const record = (id: number, name: string) =>
  importSchema.parse({
    subject: { id, name, metadataAt: 1, cachedAt: 1 },
    aliases: [],
    rating: null,
  });

// 两个独立仓储先完成各自的关联查询，再允许提交；稳定复现事务外预查的竞态。
function simultaneousPlans(driver: SqlDriver, other: SqlDriver = driver) {
  let waiting = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap = (connection: SqlDriver): SqlDriver => ({
    dialect: connection.dialect,
    query: (statement) => connection.query(statement),
    async batch(statements) {
      if (waiting < 2) {
        if (++waiting === 2) release();
        await barrier;
      }
      return connection.batch(statements);
    },
  });
  return [new SqlRepository(wrap(driver)), new SqlRepository(wrap(other))] as const;
}

async function setup(kind: 'sqlite' | 'd1' | 'postgres'): Promise<{
  driver: SqlDriver;
  other: SqlDriver;
  close: () => Promise<void>;
}> {
  if (kind === 'postgres') {
    const pg = await postgresTestDatabase();
    // CI 使用两个独立连接池；PGlite 单会话仍强制两个计划都在提交前生成。
    const other = process.env.TEST_POSTGRES_URL ? new PostgresDriver(pg.url, 2) : pg.driver;
    return {
      driver: pg.driver,
      other,
      async close() {
        if (other !== pg.driver) await other.close();
        await pg.close();
      },
    };
  }
  if (kind === 'd1') {
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
      const statements = (await readFile('migrations/0001_initial.sql', 'utf8'))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(statements.map((s) => db.prepare(s)));
      return { driver: new D1Driver(db), other: new D1Driver(db), close: () => mf.dispose() };
    } catch (error) {
      await mf.dispose();
      throw error;
    }
  }
  const driver = new SqliteDriver(':memory:');
  driver.migrate();
  return { driver, other: driver, close: async () => driver.close() };
}

function beforeCommit(driver: SqlDriver, callback: () => Promise<unknown>, everyTime = false) {
  let done = false;
  return new SqlRepository({
    dialect: driver.dialect,
    query: (s) => driver.query(s),
    async batch(statements) {
      if (!done || everyTime) {
        done = true;
        await callback();
      }
      return driver.batch(statements);
    },
  });
}

for (const kind of ['sqlite', 'd1', 'postgres'] as const) {
  test(`${kind}: 并发导入、手动新增和日历写入均重新规划第一季补全`, async (t) => {
    const { driver, other, close } = await setup(kind);
    t.after(close);
    let [first, second] = simultaneousPlans(driver, other);
    await first.recordAliasMisses(['并发作品第一季', '并发作品第1季'], 1);
    await Promise.all([
      first.importRecord(record(1, '并发作品')),
      second.importRecord(record(2, '并发作品第二季')),
    ]);
    assert.deepEqual(
      (await first.listAliases(1)).map((a) => a.name).sort(),
      ['并发作品', '并发作品第一季', '并发作品第1季'].sort(),
    );
    assert.deepEqual(
      (await first.listAliases(2)).map((a) => a.name).sort(),
      ['并发作品第二季', '并发作品第2季'].sort(),
    );
    assert.deepEqual(await first.aliasMissStats(), []);
    const saved = await first.listAliases(1);
    await first.importRecord(record(1, '并发作品'));
    await second.importRecord(record(2, '并发作品第二季'));
    assert.deepEqual(await first.listAliases(1), saved);

    const plain = new SqlRepository(driver);
    await plain.importRecord(record(3, '手动甲'));
    await plain.importRecord(record(4, '手动乙'));
    [first, second] = simultaneousPlans(driver, other);
    await Promise.all([
      second.addManualAlias(4, '手动并发第2季', 2),
      first.addManualAlias(3, '手动并发', 2),
    ]);
    for (const name of ['手动并发第一季', '手动并发第1季'])
      assert((await first.listAliases(3)).some((a) => a.name === name && a.source === 'manual'));

    [first, second] = simultaneousPlans(driver, other);
    await Promise.all([
      first.mergeCalendar({
        fetchedAt: 3,
        items: [{ id: 5, name: '日历并发', nameCn: '', airDate: null, rating: null }],
      }),
      second.importRecord(record(6, '日历并发第二季')),
    ]);
    for (const name of ['日历并发第一季', '日历并发第1季'])
      assert((await first.listAliases(5)).some((a) => a.name === name));
  });

  test(`${kind}: 并发修改、删除和备份恢复使旧第一季归属失效，不能误绑`, async (t) => {
    const { driver, other, close } = await setup(kind);
    t.after(close);
    const repo = new SqlRepository(other);
    for (const action of ['rename', 'delete', 'restore'] as const) {
      const id = { rename: 10, delete: 20, restore: 30 }[action];
      const base = `候选${action}`;
      await repo.importRecord(record(id, `无关${id}`));
      const alias = await repo.addManualAlias(id, base, 1);
      const importer = beforeCommit(driver, async () => {
        if (action === 'rename') await repo.updateManualAlias(alias.id, '其他标题', 2);
        if (action === 'delete') await repo.deleteManualAlias(alias.id);
        if (action === 'restore') {
          const backup = backupFixture(id + 2);
          backup.subject.name = base;
          backup.aliases = [{ ...backup.aliases[0]!, name: base, normalizedName: base }];
          await repo.restoreRecord(backup);
        }
      });
      await importer.importRecord(record(id + 1, `${base}第二季`));
      assert(!(await repo.listAliases(id)).some((a) => a.name === `${base}第一季`));
      assert(!(await repo.listAliases(id)).some((a) => a.name === `${base}第1季`));
    }
  });

  test(`${kind}: 真正的写入故障整体回滚，持续并发冲突有界退出`, async (t) => {
    const { driver, other, close } = await setup(kind);
    t.after(close);
    const repo = new SqlRepository(other);
    await repo.importRecord(record(1, '已有'));
    const revision = await repo.getState(ALIAS_WRITE_REVISION_KEY);
    let calls = 0;
    const failing = new SqlRepository({
      dialect: driver.dialect,
      query: (s) => driver.query(s),
      batch: (statements) => {
        calls++;
        return driver.batch([
          ...statements,
          { sql: 'INSERT INTO missing_table VALUES (1)', params: [] },
        ]);
      },
    });
    await assert.rejects(failing.importRecord(record(2, '已有第二季')));
    assert.equal(calls, 1);
    assert.equal(await repo.getState(ALIAS_WRITE_REVISION_KEY), revision);
    assert.deepEqual(await repo.findSubjects([2]), []);
    assert.deepEqual(
      (await repo.listAliases(1)).map((a) => a.name),
      ['已有'],
    );

    calls = 0;
    const busy = beforeCommit(
      driver,
      async () => {
        calls++;
        await repo.setState(ALIAS_WRITE_REVISION_KEY, crypto.randomUUID());
      },
      true,
    );
    await assert.rejects(busy.importRecord(record(2, '已有第二季')), /并发写入冲突/);
    assert.equal(calls, 5);
    assert.deepEqual(await repo.findSubjects([2]), []);
    assert.deepEqual(
      (await repo.listAliases(1)).map((a) => a.name),
      ['已有'],
    );
  });
}
