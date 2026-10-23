import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSuggestions, pathSearchKey } from '../../src/cli/file-path.ts';

test('Windows 路径匹配兼容两种斜杠、混合分隔符、盘符和 UNC', () => {
  expect(pathSearchKey('C:/data/subject.jsonlines', 'win32')).toBe(
    pathSearchKey('c:\\data\\subject.jsonlines', 'win32'),
  );
  expect(pathSearchKey('C:/data\\nested/../SUBJECT.jsonlines', 'win32')).toBe(
    pathSearchKey('C:\\data\\subject.jsonlines', 'win32'),
  );
  expect(pathSearchKey('//server/share/data/subject.jsonlines', 'win32')).toBe(
    pathSearchKey('\\\\server\\share\\data\\subject.jsonlines', 'win32'),
  );
  expect(pathSearchKey('data/subject.jsonlines', 'win32')).toBe(
    pathSearchKey('.\\data\\subject.jsonlines', 'win32'),
  );
});

test('Linux 和 macOS 保留反斜杠文件名及大小写，规范化相对目录片段', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    expect(pathSearchKey('/data/./nested/../subject.jsonlines', platform)).toBe(
      '/data/subject.jsonlines',
    );
    expect(pathSearchKey('/data/subject\\name.jsonlines', platform)).toBe(
      '/data/subject\\name.jsonlines',
    );
    expect(pathSearchKey('/data/Subject.jsonlines', platform)).not.toBe(
      pathSearchKey('/data/subject.jsonlines', platform),
    );
  }
});

test('真实文件候选支持正斜杠、空格、目录浏览和路径前缀，缺失路径不抛异常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-path-'));
  const folder = join(dir, 'data space');
  await mkdir(folder);
  const file = join(folder, 'subject.jsonlines');
  await writeFile(file, '');
  await writeFile(join(folder, 'other.jsonl'), '');
  const forward = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  expect(fileSuggestions(forward)).toEqual([file]);
  expect(fileSuggestions(forward.slice(0, -5))).toEqual([file]);
  expect(fileSuggestions(file)).toEqual([file]);
  expect(fileSuggestions(folder)).toContain(file);
  expect(fileSuggestions(folder + '/')).toContain(file);
  expect(fileSuggestions(join(folder, 'missing', 'subject'))).toEqual([]);
  expect(fileSuggestions('')).toEqual([]);
});
