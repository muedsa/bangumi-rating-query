import { expect, test } from 'bun:test';
import { QueryService } from '../../src/core/query-service.ts';
import type { AnimeRepository } from '../../src/core/ports.ts';
import { readConfig } from '../../src/config.ts';

function repository() {
  const writes: string[][] = [];
  const repo = {
    async findAliases() {
      return [{ subjectId: 1, name: '已知', normalizedName: '已知', source: 'bangumi' }];
    },
    async findSubjects() {
      return [{ id: 1, name: '已知', nameCn: '', airDate: '2026-01-01', platform: 'TV' }];
    },
    async getRatings() {
      return [];
    },
    async recordHits() {},
    async recordAliasMisses(names: string[]) {
      writes.push(names);
    },
  } as unknown as AnimeRepository;
  return { repo, writes };
}

test('未知别名统计默认关闭且独立于访问统计，非法开关被拒绝', async () => {
  expect(readConfig({}).ALIAS_MISS_STATS_ENABLED).toBe(false);
  expect(readConfig({ ALIAS_MISS_STATS_ENABLED: 'true' }).ALIAS_MISS_STATS_ENABLED).toBe(true);
  expect(() => readConfig({ ALIAS_MISS_STATS_ENABLED: 'yes' })).toThrow();
  const { repo, writes } = repository();
  const service = new QueryService(repo, { statsEnabled: true, ratingTtlHours: 24 });
  await service.batch([{ inputId: 'a', names: ['unknown'] }]);
  expect(writes).toEqual([]);
});

test('逐个记录未映射的名称，每请求归一化去重，排除显式 ID 和条目链接', async () => {
  const { repo, writes } = repository();
  const service = new QueryService(repo, {
    statsEnabled: false,
    aliasMissStatsEnabled: true,
    ratingTtlHours: 24,
  });
  const result = await service.batch([
    { inputId: 'mixed', names: ['已知', 'Unknown', 'ＵＮＫＮＯＷＮ'] },
    { inputId: 'repeat', names: ['unknown'] },
    { inputId: 'id', subjectId: 999, names: ['忽略'] },
    { inputId: 'link', names: ['https://bgm.tv/subject/999'] },
    { inputId: 'filter', names: ['已知'], year: 1900 },
    { inputId: 'number', names: ['86'] },
  ]);
  expect(result.results[0]?.status).toBe('matched');
  expect(result.results[4]?.status).toBe('not_found');
  expect(writes).toEqual([['Unknown', '86']]);
  await service.batch([{ inputId: 'again', names: ['unknown'] }]);
  expect(writes).toEqual([['Unknown', '86'], ['unknown']]);
});

test('已知别名没有评分不算未命中，未命中统计失败不改变查询结果', async () => {
  const { repo, writes } = repository();
  const errors: unknown[] = [];
  const service = new QueryService(repo, {
    statsEnabled: false,
    aliasMissStatsEnabled: true,
    ratingTtlHours: 24,
    onAliasMissStatsError: (error) => errors.push(error),
  });
  const result = await service.batch([{ inputId: 'a', names: ['已知'] }]);
  expect(result.results[0]?.status).toBe('matched');
  expect(writes).toEqual([]);
  repo.recordAliasMisses = async () => {
    throw new Error('write failure');
  };
  const failed = await service.batch([{ inputId: 'a', names: ['已知', 'unknown'] }]);
  expect(failed.results[0]?.status).toBe('matched');
  expect(errors).toHaveLength(1);
});
