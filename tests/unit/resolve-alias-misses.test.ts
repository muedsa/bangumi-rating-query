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
  planned: true,
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
    aliasMisses: async (planned) => {
      expect(planned).toBe(true);
      return names.map(miss);
    },
    setAliasMissPlanned: async (name, planned) => {
      events.push(['plan', name, planned]);
      return { ...miss(name), planned };
    },
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
    ui: { write() {}, choose: async (_, result) => (result.candidates.length ? 12 : 'skip') },
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

test('有候选和无候选均可标为无计划，写入成功后计数，失败时停止且不假报成功', async () => {
  const { target, events } = setup(['甲', '丙']);
  const summary = await resolveAliasMisses({
    target,
    logger,
    ui: { write() {}, choose: async () => 'unplanned' },
  });
  expect(events).toEqual([
    ['search', '甲', 10],
    ['plan', '甲', false],
    ['search', '丙', 10],
    ['plan', '丙', false],
  ]);
  expect(summary).toMatchObject({ processed: 2, unplanned: 2, resolved: 0, importedSubjects: 0 });
  expect(summary.results.map((r) => r.status)).toEqual(['unplanned', 'unplanned']);
  const failed = setup();
  failed.target.setAliasMissPlanned = async () => {
    throw new Error('update failed');
  };
  const messages: string[] = [];
  await expect(
    resolveAliasMisses({
      target: failed.target,
      logger,
      ui: { write: (message) => messages.push(message), choose: async () => 'unplanned' },
    }),
  ).rejects.toThrow('第 1 个别名');
  expect(failed.events).toEqual([['search', '甲', 10]]);
  expect(messages.some((message) => message.startsWith('已标为无计划'))).toBe(false);
});

test('无候选可多次自定义搜索，成功后绑定原未命中名称，候选上限保持不变', async () => {
  const { target, events } = setup(['原别名']);
  target.searchSubjects = async (keyword, limit) => {
    events.push(['search', keyword, limit]);
    return keyword === '有效名称' ? result : { total: 0, candidates: [] };
  };
  let choices = 0;
  const summary = await resolveAliasMisses({
    target,
    logger,
    searchLimit: 2,
    ui: {
      write() {},
      choose: async (miss) => {
        expect(miss.name).toBe('原别名');
        return ++choices === 1 ? { search: '新名称' } : choices === 2 ? { search: '有效名称' } : 12;
      },
    },
  });
  expect(events).toEqual([
    ['search', '原别名', 2],
    ['search', '新名称', 2],
    ['search', '有效名称', 2],
    ['sync', 12],
    ['alias', 12, '原别名'],
  ]);
  expect(summary).toMatchObject({ total: 1, processed: 1, resolved: 1, noCandidates: 0 });
  expect(summary.results).toEqual([{ name: '原别名', status: 'resolved', subjectId: 12 }]);
});

test('自定义搜索后标记、跳过或退出均不导入，搜索失败保留原别名错误上下文', async () => {
  for (const action of ['unplanned', 'skip', 'quit'] as const) {
    const { target, events } = setup(['原别名']);
    target.searchSubjects = async (keyword, limit) => {
      events.push(['search', keyword, limit]);
      return { total: 0, candidates: [] };
    };
    let choices = 0;
    const summary = await resolveAliasMisses({
      target,
      logger,
      ui: { write() {}, choose: async () => (++choices === 1 ? { search: '新名称' } : action) },
    });
    expect(events).toEqual([
      ['search', '原别名', 10],
      ['search', '新名称', 10],
      ...(action === 'unplanned' ? [['plan', '原别名', false]] : []),
    ]);
    expect(summary).toMatchObject({
      unplanned: Number(action === 'unplanned'),
      noCandidates: Number(action === 'skip'),
      remaining: Number(action === 'quit'),
      importedSubjects: 0,
    });
  }
  const { target } = setup(['原别名']);
  target.searchSubjects = async (keyword) => {
    if (keyword === '新名称') throw new Error('search failed');
    return { total: 0, candidates: [] };
  };
  await expect(
    resolveAliasMisses({
      target,
      logger,
      ui: { write() {}, choose: async () => ({ search: '新名称' }) },
    }),
  ).rejects.toThrow('第 1 个别名 "原别名" 处理失败');
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

test('终端无候选时支持自定义名称（保留大小写）、数字名称及 -1/0，候选存在时 -1 仍有效', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  const ui = createAliasReviewTerminal(input, output);
  const empty = { total: 0, candidates: [] };
  input.end(`${'长'.repeat(301)}\n  Custom Name  \n86\n-1\n-1\n0\n`);
  try {
    expect(await ui.choose(miss('甲'), empty, 1, 1)).toEqual({ search: 'Custom Name' });
    expect(await ui.choose(miss('甲'), empty, 1, 1)).toEqual({ search: '86' });
    expect(await ui.choose(miss('甲'), empty, 1, 1)).toBe('unplanned');
    expect(await ui.choose(miss('甲'), result, 1, 1)).toBe('unplanned');
    expect(await ui.choose(miss('甲'), empty, 1, 1)).toBe('skip');
    expect(await ui.choose(miss('甲'), empty, 1, 1)).toBe('quit');
    expect(text).toContain('搜索名称需要 1～300 个字符');
    expect(text).not.toContain('1～0');
  } finally {
    ui.close();
  }
});
