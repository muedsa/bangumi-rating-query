import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  aliasReviewOptionsSchema,
  resolveAliasMisses,
  type AliasReviewTarget,
} from '../../src/cli/resolve-alias-misses.ts';
import { createAliasReviewTerminal } from '../../src/cli/alias-review-terminal.ts';
import { createCliLogger } from '../../src/cli/logger.ts';
import type { AliasMiss } from '../../src/core/ports.ts';
import type { SubjectSearchResult } from '../../src/core/subject-search.ts';

const logger = createCliLogger({ command: 'resolve-alias-misses', level: 'silent' });
const miss = (name: string): AliasMiss => ({
  name,
  normalizedName: name,
  missCount: 3,
  firstMissedAt: 1,
  lastMissedAt: 2,
});
const result: SubjectSearchResult = {
  total: 2,
  candidates: [11, 12].map((id) => ({
    id,
    name: `作品${id}`,
    nameCn: '',
    airDate: null,
    platform: '',
    summary: '',
    score: null,
    votes: 0,
  })),
};
function setup(names = ['甲', '乙', '丙', '丁']) {
  const events: unknown[] = [];
  const target: AliasReviewTarget = {
    aliasMisses: async () => names.map(miss),
    searchSubjects: async (name, limit) => {
      events.push(['search', name, limit]);
      return name === '丙' ? { total: 0, candidates: [] } : result;
    },
    syncSubject: async (id) => {
      events.push(['sync', id]);
      return { imported: id };
    },
    alias: async (id, name) => {
      events.push(['alias', id, name]);
    },
  };
  return { target, events };
}

test('处理量和候选量有默认值并严格校验范围', () => {
  expect(aliasReviewOptionsSchema.parse({})).toEqual({ limit: 20, searchLimit: 10 });
  for (const value of [0, -1, 1.5, 101, 'invalid'])
    expect(() => aliasReviewOptionsSchema.parse({ limit: value })).toThrow();
  for (const value of [0, -1, 1.5, 51, 'invalid'])
    expect(() => aliasReviewOptionsSchema.parse({ searchLimit: value })).toThrow();
});

test('同一条目只同步一次，多个选择分别添加手动别名，无候选不写入且遵守数量', async () => {
  const { target, events } = setup();
  const summary = await resolveAliasMisses({
    target,
    logger,
    limit: 3,
    searchLimit: 2,
    ui: { write() {}, choose: async () => 12 },
  });
  expect(events).toEqual([
    ['search', '甲', 2],
    ['sync', 12],
    ['alias', 12, '甲'],
    ['search', '乙', 2],
    ['alias', 12, '乙'],
    ['search', '丙', 2],
  ]);
  expect(summary).toMatchObject({
    status: 'completed',
    total: 3,
    processed: 3,
    resolved: 2,
    noCandidates: 1,
    importedSubjects: 1,
  });
});

test('跳过、退出和无数据均不导入，非法选择与导入失败立即停止后续操作', async () => {
  const { target, events } = setup();
  let i = 0;
  expect(
    await resolveAliasMisses({
      target,
      logger,
      ui: { write() {}, choose: async () => (++i === 1 ? 'skip' : 'quit') },
    }),
  ).toMatchObject({ status: 'stopped', skipped: 1, remaining: 3 });
  expect(events).toEqual([
    ['search', '甲', 10],
    ['search', '乙', 10],
  ]);
  for (const fail of ['choice', 'sync', 'sync_id', 'alias']) {
    const state = setup();
    if (fail === 'sync')
      state.target.syncSubject = async () => {
        throw new Error('failed');
      };
    if (fail === 'sync_id') state.target.syncSubject = async () => ({ imported: 99 });
    if (fail === 'alias')
      state.target.alias = async () => {
        throw new Error('failed');
      };
    await expect(
      resolveAliasMisses({
        target: state.target,
        logger,
        ui: { write() {}, choose: async () => (fail === 'choice' ? 99 : 11) },
      }),
    ).rejects.toThrow('处理失败（目标条目 ID：');
    expect(state.events.filter((e: any) => e[0] === 'search')).toHaveLength(1);
  }
  expect(
    await resolveAliasMisses({
      ...setup([]),
      logger,
      ui: {
        write() {},
        choose: async () => {
          throw new Error('should not ask');
        },
      },
    }),
  ).toMatchObject({ total: 0, processed: 0 });
});

test('终端保留提前输入的多行答案，非法序号重问，EOF 停止，移除控制序列', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  const ui = createAliasReviewTerminal(input, output);
  input.end('99\n2\n0\n');
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await ui.choose(miss('甲\u001b[2J\n标题'), result, 1, 3)).toBe(12);
    expect(await ui.choose(miss('乙'), result, 2, 3)).toBe('skip');
    expect(await ui.choose(miss('丙'), result, 3, 3)).toBe('quit');
    expect(text).toContain('请输入 1～2');
    expect(text).not.toContain('\u001b');
    expect(ui.waiting).toBe(false);
  } finally {
    ui.close();
  }
});
