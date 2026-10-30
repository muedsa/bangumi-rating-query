import { expect, mock, spyOn, test } from 'bun:test';
import { QueryService } from '../../src/core/query-service.ts';
import { normalizeName } from '../../src/core/matching.ts';
import type { Alias, QueryItem, Subject } from '../../src/core/models.ts';
import type { AnimeRepository } from '../../src/core/ports.ts';
import { batchResponseSchema } from '../../src/http/contracts.ts';

const now = Date.parse('2026-10-30T00:00:00Z');
const subject = (id: number, platform = 'TV', airDate: string | null = '2026-01-01'): Subject => ({
  id,
  name: `动画${id}`,
  nameCn: '',
  platform,
  airDate,
  metadataAt: now,
  cachedAt: now,
  pinned: false,
});
const alias = (subjectId: number, name: string, source: Alias['source'] = 'bangumi'): Alias => ({
  id: `${subjectId}:${name}`,
  subjectId,
  name,
  normalizedName: normalizeName(name),
  source,
  createdAt: now,
  updatedAt: now,
});
function setup(subjects: Subject[], aliases: Alias[]) {
  const findAliases = mock(async (keys: string[]) =>
    aliases.filter((a) => keys.includes(a.normalizedName)),
  );
  const findSubjects = mock(async (ids: number[]) => subjects.filter((s) => ids.includes(s.id)));
  const getRatings = mock(async (_ids: number[]) => []);
  const recordHits = mock(async (_ids: number[], _now: number) => {});
  const recordAliasMisses = mock(async (_names: string[], _now: number) => {});
  const repo = {
    findAliases,
    findSubjects,
    getRatings,
    recordHits,
    recordAliasMisses,
  } as unknown as AnimeRepository;
  const service = new QueryService(repo, {
    statsEnabled: true,
    aliasMissStatsEnabled: true,
    ratingTtlHours: 24,
    now: () => now,
  });
  return { service, findAliases, findSubjects, getRatings, recordHits, recordAliasMisses };
}

test('1000 条别名的批量查询不重复归一化每条映射，只读取最终 400 个候选的评分', async () => {
  const names = Array.from({ length: 100 }, (_, i) => '名称'.repeat(140) + i);
  const subjects = Array.from({ length: 1000 }, (_, i) => subject(i + 1));
  const aliases = names.flatMap((name, i) =>
    Array.from({ length: 10 }, (_, j) => alias(i * 10 + j + 1, name)),
  );
  const { service, findAliases, findSubjects, getRatings, recordHits, recordAliasMisses } = setup(
    subjects,
    aliases,
  );
  const items = Array.from({ length: 20 }, (_, i) => ({
    inputId: String(i),
    names: names.slice(i * 5, i * 5 + 5),
  }));
  const originalNormalize = String.prototype.normalize;
  let normalizationCalls = 0;
  const normalize = spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    normalizationCalls++;
    return originalNormalize.call(this, form);
  });
  let response;
  try {
    response = await service.batch(items);
  } finally {
    normalize.mockRestore();
  }
  const results = batchResponseSchema.parse(response).results;
  const returnedIds = results.flatMap((result, i) => {
    if (result.status !== 'ambiguous') throw new Error('应保留不同名称的冲突');
    expect(result.matchReason).toBe('conflicting_names');
    expect(result.candidatesTruncated).toBe(true);
    expect(result.candidates.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, j) => i * 50 + j + 1),
    );
    return result.candidates.map((s) => s.id);
  });
  expect(normalizationCalls).toBeLessThanOrEqual(200); // 预算按输入名称计，不依赖本机耗时。
  expect(findAliases).toHaveBeenCalledTimes(1);
  expect(findSubjects).toHaveBeenCalledTimes(1);
  expect(getRatings).toHaveBeenCalledTimes(1);
  expect(getRatings).toHaveBeenCalledWith(returnedIds);
  expect(recordHits).not.toHaveBeenCalled();
  expect(recordAliasMisses).not.toHaveBeenCalled();
});

test('名称索引保持交集、冲突、精确与归一化别名、官方链接及统计去重语义', async () => {
  const aliases = [
    alias(1, 'Alpha'),
    alias(2, 'Alpha'),
    alias(1, 'ＡＬＰＨＡ', 'manual'),
    alias(1, 'One'),
    alias(2, 'Two'),
    alias(3, '86'),
  ];
  const { service, getRatings, recordHits, recordAliasMisses } = setup(
    [subject(1), subject(2, 'OVA', '2025-01-01'), subject(3)],
    aliases,
  );
  const items: QueryItem[] = [
    { inputId: 'intersection', names: ['Alpha', 'One', 'Unknown'] },
    { inputId: 'normalized', names: [' one '] },
    { inputId: 'shared', names: ['Alpha'] },
    { inputId: 'conflict', names: ['One', 'Two'], year: 2026 },
    { inputId: 'filter', names: ['Two'], platform: 'TV' },
    { inputId: 'link', names: ['https://bgm.tv/subject/1', 'One', 'Unknown'] },
    { inputId: 'id', subjectId: 2, names: ['忽略'], platform: 'ｏｖａ' },
    { inputId: 'absent', names: ['https://chii.in/subject/999'] },
    { inputId: 'numeric', names: ['86'] },
    { inputId: 'miss', names: ['UNKNOWN', 'ＵＮＫＮＯＷＮ'] },
    { inputId: 'filtered', names: ['Alpha'], year: 2026, platform: 'ｔｖ' },
    { inputId: 'links', names: ['https://bgm.tv/subject/1', 'https://bangumi.tv/subject/2'] },
  ];
  const original = structuredClone(items);
  const results = batchResponseSchema.parse(await service.batch(items)).results;
  expect(items).toEqual(original);
  expect(results.map((r) => r.status)).toEqual([
    'matched',
    'matched',
    'ambiguous',
    'ambiguous',
    'not_found',
    'matched',
    'matched',
    'not_found',
    'matched',
    'not_found',
    'matched',
    'ambiguous',
  ]);
  expect(results[0]).toMatchObject({
    matchReason: 'exact_alias',
    subject: { id: 1 },
    matchedAliases: [
      { name: 'Alpha', source: 'bangumi' },
      { name: 'ＡＬＰＨＡ', source: 'manual' },
      { name: 'One', source: 'bangumi' },
    ],
  });
  expect(results[1]).toMatchObject({
    matchReason: 'normalized_alias',
    matchedAliases: [{ name: 'One', source: 'bangumi' }],
  });
  expect(results[2]).toMatchObject({
    matchReason: 'shared_alias',
    candidates: [{ id: 1 }, { id: 2 }],
  });
  expect(results[3]).toMatchObject({ matchReason: 'conflicting_names', candidates: [{ id: 1 }] });
  expect(results[5]).toMatchObject({
    matchReason: 'subject_id',
    matchedAliases: [{ name: 'One', source: 'bangumi' }],
  });
  expect(results[6]).toMatchObject({
    matchReason: 'subject_id',
    matchedAliases: [],
    subject: { id: 2 },
  });
  expect(results[8]).toMatchObject({ matchReason: 'exact_alias', subject: { id: 3 } });
  expect(results[10]).toMatchObject({ matchReason: 'exact_alias', subject: { id: 1 } });
  expect(results[11]).toMatchObject({
    matchReason: 'conflicting_names',
    candidates: [{ id: 1 }, { id: 2 }],
  });
  expect(getRatings).toHaveBeenCalledTimes(1);
  expect(getRatings).toHaveBeenCalledWith([1, 2, 3]);
  expect(recordHits).toHaveBeenCalledWith([1, 2, 3], now);
  expect(recordAliasMisses).toHaveBeenCalledWith(['Unknown'], now);
});

test('全批筛选后无候选或未收录时不读取评分，已知名称不计入未命中统计', async () => {
  const { service, getRatings, recordHits, recordAliasMisses } = setup(
    [subject(1), subject(2, 'OVA', null)],
    [alias(1, 'One'), alias(2, 'Two')],
  );
  const results = (
    await service.batch([
      { inputId: 'year', names: ['One'], year: 2025 },
      { inputId: 'platform', subjectId: 1, platform: 'OVA' },
      { inputId: 'no-date', names: ['Two'], year: 2026 },
      { inputId: 'unknown', names: ['Unknown'] },
      { inputId: 'id', subjectId: 999 },
    ])
  ).results;
  expect(results.every((r) => r.status === 'not_found')).toBe(true);
  expect(getRatings).not.toHaveBeenCalled();
  expect(recordHits).not.toHaveBeenCalled();
  expect(recordAliasMisses).toHaveBeenCalledWith(['Unknown'], now);
});
