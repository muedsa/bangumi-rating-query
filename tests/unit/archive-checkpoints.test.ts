import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncArchive } from '../../src/cli/sync-archive.ts';
import { createCliLogger } from '../../src/cli/logger.ts';
import type { ImportRecord } from '../../src/core/models.ts';

const anime = (id: number) => JSON.stringify({ id, type: 2, name: `动画${id}` });
const other = (count: number) =>
  Array.from({ length: count }, (_, i) => JSON.stringify({ id: i + 1, type: i % 2 ? 1 : 4 }));
async function setup(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-ignore-checkpoints-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, lines.join('\n'));
  let state: string | null = null;
  const saved: { line: number; skippedTotal: number; complete?: boolean }[] = [];
  const events: string[] = [];
  const target = {
    async getState() {
      return state;
    },
    async setState(_key: string, value: string) {
      state = value;
      const checkpoint = JSON.parse(value);
      saved.push(checkpoint);
      events.push(`save:${checkpoint.line}`);
    },
    async importRecord(record: ImportRecord) {
      events.push(`import:${record.subject.id}`);
    },
  };
  const options = {
    file,
    target,
    asOf: '2026-01-01T00:00:00Z',
    skipInvalid: false,
    logger: createCliLogger({ command: 'test', level: 'silent' }),
  };
  return { options, target, saved, events, file };
}

test('连续 200 行非动画跨过多个保存点，只在忽略段末尾保存一次', async () => {
  const env = await setup([anime(1), ...other(200), anime(202)]);
  expect(await syncArchive(env.options)).toMatchObject({
    imported: 2,
    line: 202,
    complete: true,
    skipped: 0,
  });
  expect(env.events).toEqual(['import:1', 'save:201', 'import:202', 'save:202']);
  expect(env.saved).toEqual([
    { line: 201, skippedTotal: 0 },
    { line: 202, skippedTotal: 0, complete: true },
  ]);
});

test('文件末尾为连续非动画和空行时，只做最终保存；短忽略段不额外保存', async () => {
  const env = await setup([...other(200), '', '']);
  expect(await syncArchive(env.options)).toMatchObject({ imported: 0, line: 201, complete: true });
  expect(env.saved).toEqual([{ line: 201, skippedTotal: 0, complete: true }]);
  const short = await setup([...other(5), anime(6)]);
  await syncArchive(short.options);
  expect(short.events).toEqual(['import:6', 'save:6']);
});

test('忽略段后的导入失败不越过失败行，续跑不会重复请求忽略段内的检查点', async () => {
  const env = await setup([...other(205), anime(206)]);
  const importRecord = env.target.importRecord;
  env.target.importRecord = async () => {
    throw new Error('模拟 API 失败');
  };
  await expect(syncArchive(env.options)).rejects.toThrow('第 206 行导入失败');
  expect(env.saved).toEqual([{ line: 205, skippedTotal: 0 }]);
  env.target.importRecord = importRecord;
  expect(await syncArchive(env.options)).toMatchObject({ imported: 1, line: 206 });
  expect(env.events).toEqual(['save:205', 'import:206', 'save:206']);
});

test('坏项不参与非动画合并，解析失败前仍保存前面的忽略段', async () => {
  const env = await setup([...other(205), '{bad json']);
  await expect(syncArchive(env.options)).rejects.toThrow('第 206 行导入失败');
  expect(env.saved).toEqual([{ line: 205, skippedTotal: 0 }]);
  const invalid = await setup(Array.from({ length: 40 }, () => '{bad json'));
  await syncArchive({ ...invalid.options, skipInvalid: true });
  expect(invalid.saved.map((s) => [s.line, s.skippedTotal])).toEqual([
    [20, 20],
    [40, 40],
    [40, 40],
  ]);
});

test('合并检查点写入失败不能被 skip-invalid 吞掉，也不导入下一行', async () => {
  const env = await setup([...other(200), anime(201)]);
  env.target.setState = async () => {
    throw new Error('检查点故障');
  };
  await expect(syncArchive({ ...env.options, skipInvalid: true })).rejects.toThrow('检查点故障');
  expect(env.events).toEqual([]);
  expect(existsSync(`${env.file}.errors.jsonl`)).toBe(false);
});

test('扫描非动画期间取消只保存已忽略的最终位置，续跑保持自定义间隔', async () => {
  const env = await setup([...other(205), anime(206)]);
  const controller = new AbortController();
  const logger = createCliLogger({
    command: 'test',
    level: 'info',
    write() {},
    onUpdate(details) {
      if (details.phase === 'archive_scan' && details.ignored === 150) controller.abort();
    },
  });
  expect(
    await syncArchive({
      ...env.options,
      logger,
      signal: controller.signal,
      checkpointInterval: '7',
    }),
  ).toMatchObject({ status: 'stopped', line: 150, complete: false });
  expect(env.saved).toEqual([{ line: 150, skippedTotal: 0, complete: false }]);
  await syncArchive({ ...env.options, checkpointInterval: '7' });
  expect(env.events).toEqual(['save:150', 'save:205', 'import:206', 'save:206']);
});

test('合并保存期间取消，不把已解析但尚未导入的动画写入检查点', async () => {
  const env = await setup([...other(200), anime(201)]);
  const controller = new AbortController();
  const setState = env.target.setState;
  env.target.setState = async (key, value) => {
    await setState(key, value);
    controller.abort();
  };
  expect(await syncArchive({ ...env.options, signal: controller.signal })).toMatchObject({
    status: 'stopped',
    line: 200,
    imported: 0,
  });
  expect(env.saved.every((s) => s.line === 200)).toBe(true);
  expect(env.saved.at(-1)!.complete).toBe(false);
  env.target.setState = setState;
  expect(await syncArchive(env.options)).toMatchObject({ imported: 1, line: 201, complete: true });
});

test('dry-run 遇到长非动画段只统计，不创建检查点', async () => {
  const env = await setup([...other(200), anime(201)]);
  expect(
    await syncArchive({
      dryRun: true,
      file: env.file,
      skipInvalid: false,
      logger: env.options.logger,
    }),
  ).toMatchObject({ parsed: 1, ignored: 200, line: 201, complete: true });
  expect(env.saved).toEqual([]);
});
