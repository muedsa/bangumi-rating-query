import { expect, test } from 'bun:test';
import { createCliLogger, errorDetails } from '../../src/cli/logger.ts';

test('文件记录完整调试日志，终端按级别过滤，进度和文件共用脱敏', () => {
  const consoleLines: string[] = [];
  const fileLines: string[] = [];
  const updates: unknown[] = [];
  const logger = createCliLogger({
    command: 'test',
    level: 'info',
    secrets: ['private-token'],
    write: (line) => consoleLines.push(line),
    writeFile: (line) => fileLines.push(line),
    onUpdate: (data) => updates.push(data),
  });
  logger.log('debug', 'request', 'private-token');
  logger.update({ phase: 'alias_search', keyword: 'private-token' });
  expect(consoleLines).toEqual([]);
  expect(fileLines).toHaveLength(1);
  expect(fileLines[0]).not.toContain('private-token');
  expect(updates).toEqual([{ phase: 'alias_search', keyword: '[REDACTED]' }]);
});

test('CLI 日志过滤级别，记录时间、阶段和最新进度', () => {
  const lines: string[] = [];
  let time = Date.parse('2026-10-20T00:00:00Z');
  const logger = createCliLogger({
    command: 'sync-archive',
    level: 'info',
    write: (line) => lines.push(line),
    now: () => time,
  });
  logger.log('debug', 'hidden', '不可见');
  logger.log('info', 'cli_started', '开始执行');
  logger.update({ phase: 'archive_import', line: 5, subjectId: 8, imported: 0, checkpointLine: 0 });
  time += 5000;
  logger.progress();
  logger.update({ phase: 'checkpoint_write', line: 100, imported: 20 });
  logger.progress();
  expect(lines.length).toBe(3);
  expect(JSON.parse(lines[1]!)).toMatchObject({
    time: '2026-10-20T00:00:05.000Z',
    level: 'info',
    command: 'sync-archive',
    event: 'cli_progress',
    elapsedMs: 5000,
    phase: 'archive_import',
    line: 5,
    subjectId: 8,
    checkpointLine: 0,
  });
  expect(JSON.parse(lines[2]!)).not.toHaveProperty('subjectId');
  const silent = createCliLogger({
    command: 'stats',
    level: 'silent',
    write: (line) => lines.push(line),
  });
  silent.fail(new Error('不输出'));
  silent.progress();
  expect(lines.length).toBe(3);
});

test('CLI 错误保留 cause 链与失败位置，并对嵌套文本和凭证脱敏', () => {
  const lines: string[] = [];
  const secret = 'test-secret-with-"quote';
  const logger = createCliLogger({
    command: 'sync-archive',
    level: 'error',
    secrets: [secret],
    write: (line) => lines.push(line),
  });
  logger.update({ phase: 'archive_import', line: 5, subjectId: 8, imported: 0, checkpointLine: 0 });
  logger.fail(
    new Error('第 5 行导入失败', {
      cause: new Error(`503: ${secret}; Authorization: Bearer another-token`),
    }),
  );
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({
    event: 'cli_failed',
    phase: 'archive_import',
    line: 5,
    subjectId: 8,
    checkpointLine: 0,
  });
  expect(entry.causes[0].message).toBe('第 5 行导入失败');
  expect(entry.causes[1].message).toContain('503');
  expect(entry.causes[1].message).not.toContain(secret);
  expect(lines[0]).not.toContain('another-token');
  expect(lines[0]).toContain('[REDACTED]');
  const cyclic = new Error('循环');
  cyclic.cause = cyclic;
  expect(errorDetails(cyclic).length).toBe(1);
});
