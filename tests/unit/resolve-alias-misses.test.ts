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
    getAliasMiss: async (name) => miss(name),
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
  expect(aliasReviewOptionsSchema.parse({})).toEqual({ limit: 20, searchLimit: 10, auto: false });
  for (const value of [0, -1, 1.5, 'invalid', Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => aliasReviewOptionsSchema.parse({ limit: value })).toThrow();
  for (const value of [101, 1000, Number.MAX_SAFE_INTEGER])
    expect(aliasReviewOptionsSchema.parse({ limit: value }).limit).toBe(value);
  for (const value of [0, -1, 1.5, 51, 'invalid'])
    expect(() => aliasReviewOptionsSchema.parse({ searchLimit: value })).toThrow();
  expect(() => aliasReviewOptionsSchema.parse({ auto: 'false' })).toThrow();
});

test('本批数量超过 100 时向目标传递用户数量，人工和自动模式都处理到指定条数', async () => {
  const names = Array.from({ length: 130 }, (_, i) => `作品${i}`);
  for (const auto of [false, true]) {
    const { target, events } = setup(names);
    target.aliasMisses = async (planned, limit) => {
      expect(planned).toBe(true);
      expect(limit).toBe(125);
      return names.map(miss);
    };
    const summary = await resolveAliasMisses({
      target,
      logger,
      auto,
      limit: 125,
      ui: { write() {}, choose: async () => 'skip' },
    });
    expect(summary).toMatchObject({ total: 125, processed: 125, status: 'completed' });
    expect(summary.results.map((r) => r.name)).toEqual(names.slice(0, 125));
    expect(events.filter((e: any) => e[0] === 'search')).toHaveLength(125);
  }
});

test('自动模式匹配原名或中文名，跳过后继续，精确匹配同一条目只同步一次并遵守处理上限', async () => {
  const { target, events } = setup(['不匹配', '原名', '中文名', '超出上限']);
  target.searchSubjects = async (keyword, limit) => {
    events.push(['search', keyword, limit]);
    return {
      total: 2,
      candidates: [
        result.candidates[0]!,
        { ...result.candidates[1]!, name: '原名', nameCn: '中文名' },
      ],
    };
  };
  const summary = await resolveAliasMisses({
    target,
    logger,
    auto: true,
    limit: 3,
    searchLimit: 2,
  });
  expect(events).toEqual([
    ['search', '不匹配', 2],
    ['search', '原名', 2],
    ['sync', 12],
    ['alias', 12, '原名'],
    ['search', '中文名', 2],
    ['alias', 12, '中文名'],
  ]);
  expect(summary).toMatchObject({
    status: 'completed',
    total: 3,
    processed: 3,
    resolved: 2,
    skipped: 1,
    noCandidates: 0,
    unplanned: 0,
    importedSubjects: 1,
  });
  expect(summary.results).toEqual([
    { name: '不匹配', status: 'skipped', reason: 'no_exact_match' },
    { name: '原名', status: 'resolved', subjectId: 12 },
    { name: '中文名', status: 'resolved', subjectId: 12 },
  ]);
});

test('自动模式不接受模糊匹配，无结果和多个完全同名条目跳过并记录原因，不调用交互或修改计划', async () => {
  const { target, events } = setup(['Case', '空 格', '第2季', '无结果', '同名', '唯一']);
  const candidates: Record<string, SubjectSearchResult['candidates']> = {
    Case: [{ ...result.candidates[0]!, name: 'case' }],
    '空 格': [{ ...result.candidates[0]!, name: '空格', nameCn: '空 格 ' }],
    第2季: [{ ...result.candidates[0]!, name: '第二季' }],
    无结果: [],
    同名: [
      { ...result.candidates[0]!, name: '同名' },
      { ...result.candidates[1]!, nameCn: '同名' },
    ],
    唯一: [{ ...result.candidates[1]!, name: '唯一', nameCn: '唯一' }],
  };
  target.searchSubjects = async (keyword) => ({
    total: candidates[keyword]!.length,
    candidates: candidates[keyword]!,
  });
  const logs: any[] = [];
  const summary = await resolveAliasMisses({
    target,
    auto: true,
    logger: createCliLogger({
      command: 'test',
      level: 'info',
      write: (line) => logs.push(JSON.parse(line)),
    }),
    ui: {
      write() {},
      choose: async () => {
        throw new Error('自动模式不应提问');
      },
    },
  });
  expect(events).toEqual([
    ['sync', 12],
    ['alias', 12, '唯一'],
  ]);
  expect(summary).toMatchObject({
    processed: 6,
    resolved: 1,
    skipped: 4,
    noCandidates: 1,
    unplanned: 0,
  });
  expect(summary.results.map((r) => r.reason)).toEqual([
    'no_exact_match',
    'no_exact_match',
    'no_exact_match',
    'no_candidates',
    'ambiguous_exact_match',
    undefined,
  ]);
  expect(logs.filter((entry) => entry.event === 'alias_auto_skipped')).toHaveLength(5);
  expect(logs.find((entry) => entry.reason === 'ambiguous_exact_match').exactSubjectIds).toEqual([
    11, 12,
  ]);
  expect(logs.find((entry) => entry.event === 'alias_auto_selected').subjectId).toBe(12);
});

test('自动模式请求失败停止后续处理，搜索期间取消不导入', async () => {
  for (const fail of ['search', 'sync', 'alias', 'cancel']) {
    const { target, events } = setup(['原名', '下一条']);
    const controller = new AbortController();
    target.searchSubjects = async (keyword) => {
      events.push(['search', keyword]);
      if (fail === 'search') throw new Error('search failed');
      if (fail === 'cancel') controller.abort();
      return { total: 1, candidates: [{ ...result.candidates[0]!, name: keyword }] };
    };
    if (fail === 'sync')
      target.syncSubject = async () => {
        throw new Error('sync failed');
      };
    if (fail === 'alias')
      target.alias = async () => {
        throw new Error('alias failed');
      };
    const run = resolveAliasMisses({ target, logger, auto: true, signal: controller.signal });
    if (fail === 'cancel') {
      expect(await run).toMatchObject({
        status: 'stopped',
        processed: 0,
        importedSubjects: 0,
        remaining: 2,
      });
      expect(events).toEqual([['search', '原名']]);
    } else await expect(run).rejects.toThrow('第 1 个别名');
    expect(events.filter((e: any) => e[0] === 'search')).toEqual([['search', '原名']]);
  }
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

test('人工和自动模式跳过被前项清理或改为无计划的记录，继续原批次剩余项', async () => {
  for (const auto of [false, true]) {
    for (const removed of [false, true]) {
      const { target, events } = setup(['A', 'B', 'C']);
      const pending = new Map(['A', 'B', 'C'].map((name) => [name, miss(name)]));
      let loaded = false;
      target.aliasMisses = async () => {
        expect(loaded).toBe(false); // 不重新拉取按排名截断的列表，也不追加新记录。
        loaded = true;
        return [...pending.values()];
      };
      target.getAliasMiss = async (name) => pending.get(name) ?? null;
      target.searchSubjects = async (name) => {
        events.push(['search', name]);
        return { total: 1, candidates: [{ ...result.candidates[0]!, name }] };
      };
      target.syncSubject = async (id) => {
        events.push(['sync', id]);
        pending.delete('A');
        if (removed) pending.delete('B');
        else pending.set('B', { ...miss('B'), planned: false });
        return { imported: id };
      };
      const summary = await resolveAliasMisses({
        target,
        logger,
        auto,
        ui: {
          write() {},
          choose: async (miss) => {
            expect(miss.name).not.toBe('B');
            return 11;
          },
        },
      });
      expect(summary).toMatchObject({
        status: 'completed',
        total: 3,
        processed: 3,
        resolved: 2,
        skipped: 1,
        remaining: 0,
      });
      expect(summary.results[1]).toEqual({
        name: 'B',
        status: 'skipped',
        reason: 'no_longer_pending',
      });
      expect(events).toEqual([
        ['search', 'A'],
        ['sync', 11],
        ['alias', 11, 'A'],
        ['search', 'C'],
        ['alias', 11, 'C'],
      ]);
    }
  }
});

test('交互期间记录失效时不导入、不修改计划、不执行换词搜索', async () => {
  for (const choice of [11, 'unplanned', { search: '新词' }] as const) {
    for (const current of [null, { ...miss('A'), planned: false }]) {
      const { target, events } = setup(['A', 'C']);
      let changed = false;
      target.getAliasMiss = async (name) => (name === 'A' && changed ? current : miss(name));
      const summary = await resolveAliasMisses({
        target,
        logger,
        ui: {
          write() {},
          choose: async (miss) => {
            changed = true;
            return miss.name === 'A' ? choice : 'unplanned';
          },
        },
      });
      expect(summary).toMatchObject({
        status: 'completed',
        processed: 2,
        skipped: 1,
        unplanned: 1,
        resolved: 0,
      });
      expect(events).toEqual([
        ['search', 'A', 10],
        ['search', 'C', 10],
        ['plan', 'C', false],
      ]);
      expect(summary.results[0]?.reason).toBe('no_longer_pending');
    }
  }
});

test('自动搜索期间被清理的记录不导入，修改计划的清理竞态同样跳过并继续', async () => {
  for (const auto of [false, true]) {
    const { target, events } = setup(['A', 'C']);
    let searched = false;
    target.getAliasMiss = async (name) => (auto && searched && name === 'A' ? null : miss(name));
    target.searchSubjects = async (name) => {
      searched = true;
      events.push(['search', name]);
      return { total: 1, candidates: [{ ...result.candidates[0]!, name }] };
    };
    target.setAliasMissPlanned = async (name) =>
      name === 'A' ? null : { ...miss(name), planned: false };
    const summary = await resolveAliasMisses({
      target,
      logger,
      auto,
      ui: { write() {}, choose: async () => 'unplanned' },
    });
    expect(summary).toMatchObject({
      status: 'completed',
      processed: 2,
      skipped: 1,
      resolved: auto ? 1 : 0,
      unplanned: auto ? 0 : 1,
    });
    expect(summary.results[0]).toEqual({
      name: 'A',
      status: 'skipped',
      reason: 'no_longer_pending',
    });
    expect(events).not.toContainEqual(['alias', 11, 'A']);
  }
});

test('状态复核失败必须停止，复核期间取消不执行后续搜索或写入', async () => {
  for (const stage of [1, 2]) {
    for (const cancel of [false, true]) {
      const { target, events } = setup(['A', 'C']);
      const controller = new AbortController();
      let checks = 0;
      target.getAliasMiss = async (name) => {
        if (++checks === stage) {
          if (cancel) controller.abort();
          else throw new Error('lookup failed');
        }
        return miss(name);
      };
      const run = resolveAliasMisses({
        target,
        logger,
        signal: controller.signal,
        ui: { write() {}, choose: async () => 11 },
      });
      if (cancel)
        expect(await run).toMatchObject({ status: 'stopped', processed: 0, remaining: 2 });
      else await expect(run).rejects.toThrow('第 1 个别名');
      expect(events).toEqual(stage === 1 ? [] : [['search', 'A', 10]]);
    }
  }
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
