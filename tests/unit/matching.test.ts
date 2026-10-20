import { describe, expect, test } from 'bun:test';
import { extractSubjectId, normalizeName } from '../../src/core/matching.ts';
import { readConfig } from '../../src/config.ts';
import { batchSchema } from '../../src/core/models.ts';
import { fromApi, fromArchive, wikiAliases } from '../../src/adapters/bangumi/parse.ts';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';

describe('名称与输入契约', () => {
  test('保守归一化不会抹去季数和符号', () => {
    expect(normalizeName('  Ｆａｔｅ　 ZERO  II ')).toBe('fate zero ii');
    expect(normalizeName('动画 第二季')).not.toBe(normalizeName('动画 第一季'));
    expect(normalizeName('动画！')).not.toBe(normalizeName('动画'));
  });
  test('只将受支持站点的条目链接视为 ID，数字名称仍然是名称', () => {
    expect(extractSubjectId('https://bgm.tv/subject/123?x=1')).toBe(123);
    expect(extractSubjectId('https://bangumi.tv/subject/123')).toBe(123);
    expect(extractSubjectId('https://bgm.tv.evil.test/subject/123')).toBeNull();
    expect(extractSubjectId('86')).toBeNull();
  });
  test('拒绝空查询和重复 inputId', () => {
    expect(batchSchema.safeParse({ items: [{ inputId: '1' }] }).success).toBe(false);
    expect(
      batchSchema.safeParse({
        items: [
          { inputId: '1', names: ['a'] },
          { inputId: '1', names: ['b'] },
        ],
      }).success,
    ).toBe(false);
  });
  test('统计默认关闭，配置错误不能默默启用', () => {
    expect(readConfig({}).STATS_ENABLED).toBe(false);
    expect(readConfig({ STATS_ENABLED: 'true' }).STATS_ENABLED).toBe(true);
    expect(() => readConfig({ STATS_ENABLED: 'yes' })).toThrow();
    expect(() => readConfig({ ADMIN_TOKEN: 'short' })).toThrow();
  });
});

describe('Bangumi 数据转换', () => {
  test('使用 wiki 解析器提取单值及数组别名', () => {
    expect(wikiAliases('{{Infobox animanga\n|别名={\n[简称|小明]\n[Another Name]\n}\n}}')).toEqual([
      '小明',
      'Another Name',
    ]);
    expect(wikiAliases('{{Infobox animanga\n|别名=小明\n}}')).toEqual(['小明']);
  });
  test('非动画跳过，无人评分转换为 null', () => {
    expect(fromArchive({ type: 1 }, 100)).toBeNull();
    const result = fromArchive({ id: 1, type: 2, name: 'Test', score: 0 }, 100, 200)!;
    expect(result.rating).toMatchObject({
      score: null,
      votes: 0,
      rank: null,
      dataAsOf: 100,
      fetchedAt: 200,
    });
  });
  test('评分人数来自评分分布，不是收藏人数', () => {
    const result = fromArchive(
      {
        id: 1,
        type: 2,
        name: 'Test',
        score: 8,
        score_details: { '8': 7, '9': 3 },
        favorite: { collect: 999 },
      },
      100,
    )!;
    expect(result.rating?.votes).toBe(10);
  });
  test('API 结构别名转换，并拒绝非动画', () => {
    const data = {
      id: 1,
      type: 2,
      name: 'Test',
      infobox: [{ key: '别名', value: [{ k: '中文', v: '示例' }] }],
      rating: { score: 8, total: 2 },
    };
    expect(fromApi(data, 100).aliases).toEqual(['示例']);
    expect(() => fromApi({ ...data, type: 1 })).toThrow();
  });
  test('429 遵守 Retry-After，重试后返回数据', async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetcher = (async () =>
      ++calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : Response.json({
            id: 1,
            type: 2,
            name: 'Test',
            rating: { score: 0, total: 0 },
          })) as unknown as typeof fetch;
    const client = new BangumiClient('tester/app', {
      fetcher,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect((await client.getSubject(1)).subject.id).toBe(1);
    expect(waits).toEqual([2000]);
    expect(calls).toBe(2);
  });
});
