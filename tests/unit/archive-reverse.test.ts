import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveLines, inspectArchiveFile, reverseArchiveLines } from '../../src/cli/archive.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-reverse-lines-'));
  directories.push(dir);
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, source);
  return file;
}
async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test('倒序读取与正序物理行一致，支持 UTF-8、空行和跨块的各种换行符', async () => {
  for (const source of ['', '中🙂', '\n', '\r\n', '\r', '甲\n乙\n\n', '\n甲\r\n\r\n乙🙂\r丙\n丁']) {
    const file = await fixture(source);
    const forward = await collect(archiveLines(file));
    expect(await inspectArchiveFile(file, { hash: true })).toEqual({
      size: Buffer.byteLength(source),
      totalLines: forward.length,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    for (const chunkSize of [1, 2, 3, 7, 64 * 1024]) {
      const reversed = await collect(reverseArchiveLines(file, { chunkSize }));
      expect(reversed.map((entry) => entry.line)).toEqual(forward.toReversed());
      // 每一行返回的字节位置都能独立用于恢复，且不重读已处理的尾部。
      for (let i = 0; i < reversed.length; i++) {
        const remaining = await collect(
          reverseArchiveLines(file, { chunkSize, endOffset: reversed[i]!.offset }),
        );
        expect(remaining.map((entry) => entry.line)).toEqual(
          reversed.slice(i + 1).map((entry) => entry.line),
        );
      }
    }
  }
});

test('超过一个读取块的中文行保持完整，超长行及时失败', async () => {
  const line = '动画🙂'.repeat(30000);
  const file = await fixture(`first\r\n${line}\r\nlast`);
  expect((await collect(reverseArchiveLines(file))).map((entry) => entry.line)).toEqual([
    'last',
    line,
    'first',
  ]);
  const oversized = await fixture('x'.repeat(2 * 1024 * 1024 + 1));
  await expect(collect(reverseArchiveLines(oversized))).rejects.toThrow('单行数据超过 2 MiB');
});

test('大文件的 CRLF 横跨统计块时仍只算一次换行，倒序提前结束可以再次读取', async () => {
  const line = 'a'.repeat(64 * 1024 - 1);
  const file = await fixture(`${line}\r\n末行\r\n`);
  expect((await inspectArchiveFile(file)).totalLines).toBe(2);
  for (let i = 0; i < 10; i++) {
    for await (const entry of reverseArchiveLines(file)) {
      expect(entry.line).toBe('末行');
      break;
    }
  }
  expect((await collect(reverseArchiveLines(file))).map((entry) => entry.line)).toEqual([
    '末行',
    line,
  ]);
});
