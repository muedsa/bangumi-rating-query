import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseCliArgs } from '../../src/cli/arguments.ts';
import { cliModes } from '../../src/cli/main.ts';
import { fillParameters } from '../../src/cli/wizard.ts';
import { createClackAliasReview } from '../../src/cli/alias-review-clack.ts';
import { createPresentation, formatProgress, resultLines } from '../../src/cli/presentation.ts';
import { createCliLogger } from '../../src/cli/logger.ts';
import { syncArchive } from '../../src/cli/sync-archive.ts';
import { resolveAliasMisses } from '../../src/cli/resolve-alias-misses.ts';
import { CliCancelled } from '../../src/cli/cancellation.ts';
import { validateCommandOptions } from '../../src/cli/execute.ts';
import type { Prompts } from '../../src/cli/prompts.ts';

function answers(values: (string | number | boolean | Error)[]) {
  const asked: string[] = [];
  const take = async (message: string): Promise<any> => {
    asked.push(message);
    if (!values.length) throw new Error(`意外提问：${message}`);
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  const prompts: Prompts = {
    select: take,
    confirm: take,
    text: (q) => take(q.message),
    file: (q) => take(q.message),
  };
  return { prompts, asked };
}

test('命令参数前后均兼容，显式 false 不丢失，无参数留给菜单，分命令帮助包含通用参数', () => {
  const parsed = parseCliArgs([
    '--api-url',
    'https://example.com',
    'sync-archive',
    '--file',
    'data/a.jsonl',
    '--limit',
    '1',
    '--json',
    '--no-interactive',
  ]);
  expect(parsed.command).toBe('sync-archive');
  expect(parsed.values).toMatchObject({
    apiUrl: 'https://example.com',
    file: 'data/a.jsonl',
    limit: '1',
    json: true,
    interactive: false,
  });
  expect(parseCliArgs([])).toMatchObject({ help: false, command: undefined });
  let help = '';
  expect(
    parseCliArgs(['resolve-alias-misses', '--help'], (s) => {
      help += s;
    }).help,
  ).toBe(true);
  expect(help).toContain('--search-limit');
  expect(help).toContain('--auto');
  expect(help).toContain('--no-interactive');
  expect(help).not.toContain('--checkpoint-interval');
  expect(() => parseCliArgs(['does-not-exist'])).toThrow();
});

test('别名自动模式兼容参数位置和禁用交互，显式自动不追问参数，菜单提供模式选择', async () => {
  for (const args of [
    ['--auto', 'resolve-alias-misses', '--no-interactive'],
    ['resolve-alias-misses', '--auto', '--no-interactive'],
  ]) {
    const { command, values } = parseCliArgs(args);
    expect(values).toMatchObject({ auto: true, interactive: false });
    expect(() => validateCommandOptions(command!, values)).not.toThrow();
  }
  expect(() => validateCommandOptions('sync-archive', { auto: true })).toThrow('--auto 仅支持');
  expect(() => validateCommandOptions('resolve-alias-misses', { interactive: false })).toThrow(
    '需要逐项选择',
  );
  const input = { auto: true, apiUrl: 'https://example.com' };
  expect(await fillParameters('resolve-alias-misses', input, answers([]).prompts)).toEqual(input);
  const { prompts, asked } = answers(['auto', '1000', '15']);
  const answerText = prompts.text;
  prompts.text = async (question) => {
    if (question.message === '本批最多处理多少个别名？') {
      expect(question.validate?.('1000')).toBeUndefined();
      expect(question.validate?.('0')).toBeDefined();
      expect(question.validate?.('1.5')).toBeDefined();
    }
    return answerText(question);
  };
  expect(await fillParameters('resolve-alias-misses', {}, prompts, true)).toMatchObject({
    auto: true,
    limit: '1000',
    searchLimit: '15',
  });
  expect(asked[0]).toBe('选择别名处理方式');
});

test('TTY、重定向、CI 和禁用交互各有明确模式，JSON 输出不妨碍交互', () => {
  const tty = { stdin: true, stdout: true, stderr: true, ci: false };
  expect(cliModes({}, tty)).toEqual({ interactive: true, human: true, json: false });
  expect(cliModes({ json: true }, tty)).toEqual({ interactive: true, human: true, json: true });
  expect(cliModes({ interactive: false }, tty).interactive).toBe(false);
  expect(cliModes({}, { ...tty, stdout: false })).toEqual({
    interactive: true,
    human: true,
    json: true,
  });
  expect(cliModes({}, { ...tty, stdin: false })).toEqual({
    interactive: false,
    human: false,
    json: true,
  });
  expect(cliModes({}, { ...tty, ci: true })).toEqual({
    interactive: false,
    human: false,
    json: true,
  });
});

test('Archive 向导读取快照元信息，使用默认高级选项，完整参数不重复提问', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-wizard-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, '');
  await writeFile(`${file}.meta.json`, JSON.stringify({ dataAsOf: '2026-10-20T00:00:00Z' }));
  const { prompts, asked } = answers([file, false, '1000', true, false]);
  const v = await fillParameters('sync-archive', {}, prompts);
  expect(v).toMatchObject({ file, dryRun: false, limit: '1000', skipInvalid: true });
  expect(v.asOf).toBeUndefined();
  expect(asked.some((s) => s.includes('快照时间'))).toBe(false);
  const complete = {
    file,
    asOf: '2026-10-20T00:00:00Z',
    limit: '10',
    skipInvalid: true,
    checkpointInterval: '2',
  };
  expect(await fillParameters('sync-archive', complete, answers([]).prompts)).toEqual(complete);
  const dry = await fillParameters(
    'sync-archive',
    {},
    answers([file, true, '全部', false]).prompts,
  );
  expect(dry.dryRun).toBe(true);
  expect(dry.limit).toBeUndefined();
});

test('Clack 别名界面支持有候选时换词，原名称用于绑定，取消不写入', async () => {
  const result = {
    total: 1,
    candidates: [
      {
        id: 7,
        name: '作品',
        nameCn: '',
        airDate: '2026-01-01',
        platform: 'TV',
        score: 8,
        votes: 10,
        summary: '简介',
      },
    ],
  };
  const miss = {
    name: '原别名',
    normalizedName: '原别名',
    missCount: 8,
    firstMissedAt: 1,
    lastMissedAt: 2,
    planned: true,
  };
  const presentation = createPresentation({ human: false, output: new PassThrough() });
  const { prompts } = answers(['search', '新关键词', 7]);
  const calls: unknown[] = [];
  const target = {
    aliasMisses: async () => [miss],
    setAliasMissPlanned: async () => miss,
    searchSubjects: async (keyword: string) => {
      calls.push(['search', keyword]);
      return result;
    },
    syncSubject: async (id: number) => ({ imported: id }),
    alias: async (id: number, name: string) => {
      calls.push(['alias', id, name]);
    },
  };
  const logger = createCliLogger({ command: 'test', level: 'silent' });
  expect(
    (
      await resolveAliasMisses({
        target,
        logger,
        ui: createClackAliasReview(prompts, presentation),
      })
    ).resolved,
  ).toBe(1);
  expect(calls).toEqual([
    ['search', '原别名'],
    ['search', '新关键词'],
    ['alias', 7, '原别名'],
  ]);
  expect(
    await createClackAliasReview(answers([new CliCancelled()]).prompts, presentation).choose(
      miss,
      result,
      1,
      1,
    ),
  ).toBe('quit');
});

test('Archive 取消在当前成功写入之后保存检查点，续跑不漏数据，回放历史行时不倒退', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-cancel-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(
    file,
    [1, 2, 3].map((id) => JSON.stringify({ id, type: 2, name: `作品${id}` })).join('\n'),
  );
  const controller = new AbortController();
  let state: string | null = null;
  const imported: number[] = [];
  const target = {
    getState: async () => state,
    setState: async (_key: string, value: string) => {
      state = value;
    },
    importRecord: async (record: any) => {
      imported.push(record.subject.id);
      controller.abort();
    },
  };
  const options = {
    target,
    file,
    asOf: '2026-10-20T00:00:00Z',
    skipInvalid: false,
    logger: createCliLogger({ command: 'test', level: 'silent' }),
  };
  expect(await syncArchive({ ...options, signal: controller.signal })).toMatchObject({
    status: 'stopped',
    line: 1,
    imported: 1,
    complete: false,
  });
  expect(JSON.parse(state!)).toMatchObject({ line: 1, complete: false });
  await syncArchive(options);
  expect(imported).toEqual([1, 2, 3]);
  const replay = new AbortController();
  target.getState = async () => {
    replay.abort();
    return state;
  };
  expect((await syncArchive({ ...options, signal: replay.signal })).line).toBe(3);
  expect(JSON.parse(state!).line).toBe(3);
});

test('未知总量的进度只显示计数，错误摘要和别名统计可读', () => {
  expect(resultLines('import', { restored: 2, resumed: 3, total: 5, complete: true })).toEqual([
    '备份恢复完成',
    '本次恢复 2 · 已核对并跳过 3 · 总计 5',
  ]);
  const text = formatProgress({
    phase: 'archive_import',
    line: 80,
    imported: 20,
    skipped: 2,
    recordsPerSecond: 3,
    checkpointLine: 60,
  });
  expect(text).toContain('已导入 20');
  expect(text).toContain('检查点 60');
  expect(text).not.toContain('%');
  expect(
    formatProgress({ phase: 'archive_scan', dryRun: true, parsed: 12, imported: 0 }),
  ).toContain('已解析 12');
  expect(
    resultLines('sync-archive', {
      dryRun: true,
      status: 'in_progress',
      parsed: 12,
      imported: 0,
      line: 12,
      skipped: 0,
      skippedTotal: 0,
      complete: false,
    })[0],
  ).toBe('本次解析达到处理上限');
  expect(resultLines('sync-archive', { dryRun: true, status: 'stopped' })[0]).toBe('已停止解析');
  expect(
    resultLines('alias-misses', [{ name: '作品', missCount: 3, planned: false }])[0],
  ).toContain('无计划');
});
