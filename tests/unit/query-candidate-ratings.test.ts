import { expect, mock, test } from 'bun:test';
import { QueryService } from '../../src/core/query-service.ts';
import type { AnimeRepository } from '../../src/core/ports.ts';
import type { Rating, Subject } from '../../src/core/models.ts';
import { batchResponseSchema } from '../../src/http/contracts.ts';

const now = Date.parse('2026-10-29T00:00:00Z');
const ttl = 24 * 3_600_000;

function setup(count = 4) {
  const subjects: Subject[] = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `动画${i + 1}`,
    nameCn: '',
    airDate: i === 1 ? '2025-01-01' : '2026-01-01',
    platform: 'TV',
    metadataAt: now,
    cachedAt: now,
    pinned: false,
  }));
  const ratings: Rating[] = [
    {
      subjectId: 1,
      score: 8.1,
      votes: 120,
      rank: 50,
      source: 'archive',
      dataAsOf: now - ttl,
      fetchedAt: now,
    },
    {
      subjectId: 2,
      score: null,
      votes: 0,
      rank: null,
      source: 'api',
      dataAsOf: now - ttl - 1,
      fetchedAt: now,
    },
    { subjectId: 4, score: 0, votes: 1, rank: null, source: 'api', dataAsOf: now, fetchedAt: now },
  ];
  const getRatings = mock(async (ids: number[]) =>
    ratings.filter((r) => ids.includes(r.subjectId)),
  );
  const recordHits = mock(async () => {});
  const recordAliasMisses = mock(async () => {});
  const repo = {
    async findAliases(keys: string[]) {
      return subjects.flatMap((s) =>
        ['共同别名', s.name]
          .filter((name) => keys.includes(name))
          .map((name) => ({
            subjectId: s.id,
            name,
            normalizedName: name,
            source: 'bangumi',
          })),
      );
    },
    async findSubjects(ids: number[]) {
      return subjects.filter((s) => ids.includes(s.id)).toReversed();
    },
    getRatings,
    recordHits,
    recordAliasMisses,
  } as unknown as AnimeRepository;
  return {
    service: new QueryService(repo, {
      statsEnabled: true,
      aliasMissStatsEnabled: true,
      ratingTtlHours: 24,
      now: () => now,
    }),
    getRatings,
    recordHits,
    recordAliasMisses,
  };
}

test('同名候选包含缓存评分和状态，区分无记录、未评分和零分，并按版本判断过期', async () => {
  const { service, getRatings, recordHits, recordAliasMisses } = setup();
  const response = await service.batch([{ inputId: 'shared', names: ['共同别名'] }]);
  const result = batchResponseSchema.parse(response).results[0]!;
  expect(result.status).toBe('ambiguous');
  if (result.status !== 'ambiguous') throw new Error('应返回歧义候选');
  expect(result.candidates.map((s) => s.id)).toEqual([1, 2, 3, 4]);
  expect(
    result.candidates.map((s) => ({
      rating: s.rating,
      ratingStatus: s.ratingStatus,
      dataAsOf: s.dataAsOf,
      stale: s.stale,
    })),
  ).toEqual([
    {
      rating: { score: 8.1, votes: 120, rank: 50, source: 'archive' },
      ratingStatus: 'available',
      dataAsOf: new Date(now - ttl).toISOString(),
      stale: false,
    },
    {
      rating: { score: null, votes: 0, rank: null, source: 'api' },
      ratingStatus: 'unrated',
      dataAsOf: new Date(now - ttl - 1).toISOString(),
      stale: true,
    },
    { rating: null, ratingStatus: 'unavailable', dataAsOf: null, stale: true },
    {
      rating: { score: 0, votes: 1, rank: null, source: 'api' },
      ratingStatus: 'available',
      dataAsOf: new Date(now).toISOString(),
      stale: false,
    },
  ]);
  expect(getRatings).toHaveBeenCalledTimes(1);
  expect(recordHits).not.toHaveBeenCalled();
  expect(recordAliasMisses).not.toHaveBeenCalled();
});

test('冲突筛选后仅剩一个候选仍附评分且保留歧义，与唯一命中的评分保持一致', async () => {
  const { service, getRatings, recordHits } = setup();
  const response = await service.batch([
    { inputId: 'conflict', names: ['动画1', '动画2'], year: 2026 },
    { inputId: 'direct', subjectId: 1 },
  ]);
  const [conflict, matched] = batchResponseSchema.parse(response).results;
  if (conflict?.status !== 'ambiguous' || matched?.status !== 'matched')
    throw new Error('应分别返回歧义和唯一命中');
  expect(conflict.matchReason).toBe('conflicting_names');
  expect(conflict.candidates).toEqual([
    {
      ...matched.subject,
      rating: matched.rating,
      ratingStatus: matched.ratingStatus,
      dataAsOf: matched.dataAsOf,
      stale: matched.stale,
    },
  ]);
  expect(recordHits).toHaveBeenCalledTimes(1);
  expect(recordHits).toHaveBeenCalledWith([1], now);
  expect(getRatings).toHaveBeenCalledWith([1]);
});

test('候选附评分后仍按 ID 升序截断到 20 条，不增加逐条评分查询', async () => {
  const { service, getRatings } = setup(21);
  const response = await service.batch([{ inputId: 'shared', names: ['共同别名'] }]);
  const result = batchResponseSchema.parse(response).results[0]!;
  if (result.status !== 'ambiguous') throw new Error('应返回歧义候选');
  expect(result.candidatesTruncated).toBe(true);
  expect(result.candidates.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(result.candidates[19]).toMatchObject({ rating: null, ratingStatus: 'unavailable' });
  expect(getRatings).toHaveBeenCalledTimes(1);
  expect(getRatings).toHaveBeenCalledWith(Array.from({ length: 20 }, (_, i) => i + 1));
});

test('同批重复候选和唯一命中共用评分读取，另一项按 ID 命中的截断条目仍读取评分', async () => {
  const { service, getRatings, recordHits } = setup(22);
  const results = batchResponseSchema.parse(
    await service.batch([
      { inputId: 'first', names: ['共同别名'] },
      { inputId: 'repeat', names: ['共同别名'] },
      { inputId: 'direct', subjectId: 21 },
      { inputId: 'filtered', names: ['共同别名'], year: 1900 },
    ]),
  ).results;
  expect(results.map((r) => r.status)).toEqual(['ambiguous', 'ambiguous', 'matched', 'not_found']);
  expect(results[2]).toMatchObject({ subject: { id: 21 }, ratingStatus: 'unavailable' });
  expect(getRatings).toHaveBeenCalledTimes(1);
  expect(getRatings).toHaveBeenCalledWith(Array.from({ length: 21 }, (_, i) => i + 1));
  expect(recordHits).toHaveBeenCalledWith([21], now);
});
