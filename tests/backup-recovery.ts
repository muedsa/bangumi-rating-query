import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveLines } from '../src/cli/archive.ts';
import { restoreBackup } from '../src/cli/restore-backup.ts';
import { createCliLogger } from '../src/cli/logger.ts';
import { CliCancelled } from '../src/cli/cancellation.ts';
import type { BackupRecord } from '../src/core/backup.ts';
import { backupFixture } from './helpers/backup.ts';

const logger = createCliLogger({ command: 'import', level: 'silent' });
async function setup(t: TestContext, records = [backupFixture(1), backupFixture(2)]) {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'backup.jsonl');
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n'));
  const states = new Map<string, string>();
  const stored = new Map<number, BackupRecord>();
  const writes: number[] = [];
  const target = {
    async getState(key: string) {
      return states.get(key) ?? null;
    },
    async setState(key: string, value: string) {
      states.set(key, value);
    },
    async exportPage(after: number) {
      return {
        records: [...stored.values()]
          .filter((r) => r.subject.id > after)
          .sort((a, b) => a.subject.id - b.subject.id)
          .slice(0, 5),
        nextCursor: null,
      };
    },
    async restore(record: BackupRecord) {
      assert(!stored.has(record.subject.id), '不能重复写入');
      stored.set(record.subject.id, structuredClone(record));
      writes.push(record.subject.id);
    },
  };
  return {
    file,
    target,
    states,
    stored,
    writes,
    run: () => restoreBackup({ file, target, logger }),
  };
}

test(
  'Archive 提前结束、业务异常、超长行、缺失文件均关闭底层文件流',
  { timeout: 10000 },
  async (t) => {
    const { file } = await setup(t);
    await writeFile(file, ('x'.repeat(1000) + '\n').repeat(2000));
    const streams: fs.ReadStream[] = [];
    const original = fs.createReadStream;
    fs.createReadStream = (...args: Parameters<typeof original>) => {
      const stream = original(...args);
      streams.push(stream);
      return stream;
    };
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 5; i++) {
        for await (const _line of archiveLines(file)) break;
        assert(streams.at(-1)!.closed);
        assert(streams.at(-1)!.destroyed);
      }
      await assert.rejects(async () => {
        for await (const _line of archiveLines(file)) throw new Error('业务失败');
      }, /业务失败/);
      await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1));
      await assert.rejects(async () => {
        for await (const _line of archiveLines(file)) assert.fail('超长行不能交给调用者');
      }, /单行数据超过/);
      await assert.rejects(async () => {
        for await (const _line of archiveLines(file + '.missing')) assert.fail();
      }, /ENOENT/);
      assert.equal(streams.length, 8);
      assert(streams.every((stream) => stream.closed && stream.destroyed));
    } finally {
      fs.createReadStream = original;
      syncBuiltinESMExports();
      for (const stream of streams) stream.destroy();
    }
  },
);

for (const duplicate of ['subject', 'alias'] as const)
  test(`恢复预校验拒绝跨行重复 ${duplicate}，目标无任何写入`, async (t) => {
    const records = [backupFixture(1), backupFixture(2)];
    if (duplicate === 'subject') records[1] = records[0]!;
    else records[1]!.aliases[0]!.id = records[0]!.aliases[0]!.id;
    const env = await setup(t, records);
    await assert.rejects(env.run, /第 2 行备份校验失败/);
    assert.equal(env.states.size, 0);
    assert.equal(env.stored.size, 0);
  });

test('远程备份超出 256 KiB 在第一条写入之前拒绝', async (t) => {
  const large = backupFixture(2);
  large.aliases = Array.from({ length: 250 }, (_, i) => ({
    ...large.aliases[0]!,
    id: `large-${i}`,
    name: '长'.repeat(290) + i,
    normalizedName: '长'.repeat(290) + i,
  }));
  const env = await setup(t, [backupFixture(1), large]);
  await assert.rejects(
    () => restoreBackup({ ...env, logger, maxRecordBytes: 256 * 1024 }),
    /第 2 行备份校验失败/,
  );
  assert.equal(env.states.size, 0);
  assert.equal(env.stored.size, 0);
});

for (const failure of ['before_write', 'response_lost', 'checkpoint'] as const)
  test(`备份恢复 ${failure} 后续跑，已有记录核对跳过，完成后重复执行安全`, async (t) => {
    const env = await setup(t);
    const restore = env.target.restore;
    const setState = env.target.setState;
    env.target.restore = async (record) => {
      if (failure === 'before_write' && record.subject.id === 2) throw new Error('存储失败');
      await restore(record);
      if (failure === 'response_lost') throw new Error('响应丢失');
    };
    env.target.setState = async (key, value) => {
      if (failure === 'checkpoint' && JSON.parse(value).completed === 1)
        throw new Error('检查点失败');
      await setState(key, value);
    };
    await assert.rejects(env.run, /已完成数据保留/);
    assert.equal(env.stored.size, 1);
    env.target.restore = restore;
    env.target.setState = setState;
    // 导出数组顺序不同不应构成内容冲突。
    env.stored.get(1)!.aliases.reverse();
    env.stored.get(1)!.daily.reverse();
    assert.deepEqual(await env.run(), { restored: 1, resumed: 1, total: 2, complete: true });
    assert.deepEqual(env.writes, [1, 2]);
    assert.deepEqual(await env.run(), { restored: 0, resumed: 2, total: 2, complete: true });
    assert.equal(JSON.parse([...env.states.values()][0]!).complete, true);
  });

test('取消等待当前写入和检查点；重跑继续；取消期间的存储错误仍报失败', async (t) => {
  const env = await setup(t);
  const controller = new AbortController();
  const restore = env.target.restore;
  env.target.restore = async (record) => {
    await restore(record);
    controller.abort();
  };
  await assert.rejects(
    () => restoreBackup({ ...env, logger, signal: controller.signal }),
    CliCancelled,
  );
  assert.equal(JSON.parse([...env.states.values()][0]!).completed, 1);
  env.target.restore = restore;
  assert.equal((await env.run()).restored, 1);
  const failed = await setup(t);
  const aborted = new AbortController();
  failed.target.restore = async () => {
    aborted.abort();
    throw new Error('真实存储错误');
  };
  await assert.rejects(
    () => restoreBackup({ ...failed, logger, signal: aborted.signal }),
    (error: any) => {
      assert(!(error instanceof CliCancelled));
      assert.match(error.cause.message, /真实存储错误/);
      return true;
    },
  );
});

test('续跑拒绝覆盖修改的条目，拒绝遗漏已完成条目或接管不同文件', async (t) => {
  const env = await setup(t);
  await env.run();
  env.stored.get(1)!.usage!.totalHits++;
  await assert.rejects(env.run, (error: any) => /现有内容与备份不一致/.test(error.cause.message));
  assert.equal(env.stored.get(1)!.usage!.totalHits, 4);
  env.stored.delete(1);
  await assert.rejects(env.run, (error: any) => /已恢复的条目 1 不存在/.test(error.cause.message));
  await writeFile(env.file, JSON.stringify(backupFixture(3)));
  await assert.rejects(env.run, /首次恢复需要空数据库/);
  assert.deepEqual(env.writes, [1, 2]);
});

test('预校验后备份文件变化不能把未校验内容写入目标', async (t) => {
  const env = await setup(t);
  const setState = env.target.setState;
  env.target.setState = async (key, value) => {
    await setState(key, value);
    await writeFile(env.file, JSON.stringify(backupFixture(99)));
  };
  await assert.rejects(env.run, (error: any) => /在校验后发生变化/.test(error.cause.message));
  assert.equal(env.stored.size, 0);
});
