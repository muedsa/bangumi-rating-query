import { expect, spyOn, test } from 'bun:test';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';
import { fromTrendsSearchPage, trendsSearchBody } from '../../src/adapters/bangumi/trends.ts';
import { importSchema, type ImportRecord } from '../../src/core/models.ts';
import { TrendsSyncService } from '../../src/core/trends-sync-service.ts';
import { MAX_TRENDS_PAGE } from '../../src/core/trends.ts';
import { trendsResponse, trendsSearchResult } from '../helpers/trends.ts';

test('trends 搜索限定动画类型，按收藏人数排序，日期为 UTC 最近六个日历月且包含今天', () => {
  for (const [now, from, until] of [
    ['2026-11-11T23:59:59Z', '2026-05-11', '2026-11-12'],
    ['2026-08-31T00:00:00Z', '2026-02-28', '2026-09-01'],
    ['2024-08-31T12:00:00Z', '2024-02-29', '2024-09-01'],
    ['2026-01-31T12:00:00Z', '2025-07-31', '2026-02-01'],
    ['2026-12-31T12:00:00Z', '2026-06-30', '2027-01-01'],
    ['2026-11-11T00:30:00+08:00', '2026-05-10', '2026-11-11'],
  ]) {
    expect(trendsSearchBody(Date.parse(now!))).toEqual({
      keyword: '',
      sort: 'heat',
      filter: { type: [2], air_date: [`>=${from}`, `<${until}`] },
    });
  }
});

test('trends 允许空搜索结果，但保留上游 total 供分页判断', () => {
  expect(fromTrendsSearchPage({ ...trendsSearchResult([201, 100, 201]), total: 500 })).toEqual({
    total: 500,
    data: [
      { id: 201, type: 2 },
      { id: 100, type: 2 },
      { id: 201, type: 2 },
    ],
  });
  expect(fromTrendsSearchPage(trendsSearchResult([]))).toEqual({ total: 0, data: [] });
});

test('trends 拒绝错误响应、缺失字段、无效 ID、非动画和超量结果', () => {
  for (const input of [
    '<html>error</html>',
    {},
    { total: 0 },
    { total: -1, data: [] },
    { total: 1, data: [{ id: 1, type: 1 }] },
    { total: 1, data: [{ id: 1 }] },
    trendsSearchResult([0]),
    trendsSearchResult([Number.MAX_SAFE_INTEGER + 1]),
    trendsSearchResult(Array.from({ length: 21 }, (_, i) => i + 1)),
  ])
    expect(() => fromTrendsSearchPage(input)).toThrow();
});

test('trends 使用 POST 搜索，配置 Token 时搜索和详情均使用 Bearer；429 重试保留请求正文', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T12:00:00Z'));
  try {
    const client = new BangumiClient('tester/trends', {
      accessToken: 'private-token',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetcher: (async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1)
          return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
        return String(input).includes('/v0/search/subjects?')
          ? trendsResponse([1])
          : Response.json({ id: 1, type: 2, name: '动画', rating: { score: 8, total: 5 } });
      }) as typeof fetch,
    });
    expect((await client.getTrends(3)).subjectIds).toEqual([1]);
    expect((await client.getSubject(1)).rating?.score).toBe(8);
    expect(sleeps).toEqual([2000]);
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.bgm.tv/v0/search/subjects?limit=20&offset=40',
      'https://api.bgm.tv/v0/search/subjects?limit=20&offset=40',
      'https://api.bgm.tv/v0/subjects/1',
    ]);
    for (const { init } of requests) {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer private-token');
      expect(headers.has('Cookie')).toBe(false);
      expect(headers.get('User-Agent')).toBe('tester/trends');
      expect(headers.get('Accept')).toBe('application/json');
      expect(init?.redirect).toBe('manual');
    }
    for (const { init } of requests.slice(0, 2)) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        keyword: '',
        sort: 'heat',
        filter: { type: [2], air_date: ['>=2026-05-11', '<2026-11-12'] },
      });
    }
    expect(requests[2]!.init?.body).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});

test('trends 默认第一页、任意指定页都只请求一次，固定 20 条且不自动翻页', async () => {
  const requests: [number, number][] = [];
  const client = new BangumiClient('tester/trends', {
    fetcher: (async (input, init) => {
      const url = new URL(String(input));
      const size = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      requests.push([size, offset]);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json({
        ...trendsSearchResult(Array.from({ length: size }, (_, i) => i + 1)),
        total: 500,
      });
    }) as typeof fetch,
  });
  expect((await client.getTrends()).subjectIds).toHaveLength(20);
  expect(requests).toEqual([[20, 0]]);
  expect((await client.getTrends(6)).subjectIds).toHaveLength(20);
  expect(requests).toEqual([
    [20, 0],
    [20, 100],
  ]);
  await client.getTrends(MAX_TRENDS_PAGE);
  expect(Number.isSafeInteger(requests[2]![1])).toBe(true);
  for (const page of [0, -1, 1.5, NaN, Infinity, MAX_TRENDS_PAGE + 1])
    await expect(client.getTrends(page)).rejects.toThrow();
  expect(requests.length).toBe(3);
});

test('trends 单页按返回顺序去重，短页或空页不额外请求；保留总匹配数', async () => {
  let calls = 0;
  const client = new BangumiClient('tester/trends', {
    fetcher: (async () => {
      calls++;
      return Response.json({ ...trendsSearchResult(calls === 1 ? [3, 2, 3] : []), total: 100 });
    }) as unknown as typeof fetch,
  });
  expect(await client.getTrends(2)).toMatchObject({ subjectIds: [3, 2], total: 100 });
  expect(calls).toBe(1);
  expect(await client.getTrends(99)).toMatchObject({ subjectIds: [], total: 100 });
  expect(calls).toBe(2);
});

test('trends API 403 和重定向不重试，不解析或输出错误正文', async () => {
  for (const status of [302, 403]) {
    let calls = 0;
    const client = new BangumiClient('tester/trends', {
      fetcher: (async () => {
        calls++;
        return new Response('private-body', {
          status,
          headers: { Location: 'https://example.com' },
        });
      }) as unknown as typeof fetch,
    });
    await expect(client.getTrends()).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
  }
});

function record(id: number) {
  return importSchema.parse({
    subject: { id, name: `动画${id}`, metadataAt: 20, cachedAt: 20 },
    aliases: [],
    rating: null,
  });
}

test('trends 传递指定页码，串行获取本页详情，部分失败仅合并成功记录', async () => {
  const calls: number[] = [];
  const failures: number[] = [];
  let stored: ImportRecord[] = [];
  const service = new TrendsSyncService(
    {
      mergeTrends: async (records) => {
        stored = records;
      },
    },
    {
      getTrends: async (page) => {
        expect(page).toBe(3);
        return { subjectIds: [3, 2, 3, 1], total: 60, fetchedAt: 10 };
      },
      getSubject: async (id) => {
        calls.push(id);
        if (id === 2) throw new Error('HTTP 404');
        return record(id);
      },
    },
  );
  expect(await service.sync(3, (id) => failures.push(id))).toEqual({
    page: 3,
    pageSize: 20,
    total: 60,
    nextPage: null,
    discovered: 3,
    attempted: 3,
    imported: 2,
    failedIds: [2],
    dataAsOf: new Date(10).toISOString(),
    status: 'partial',
  });
  expect(calls).toEqual([3, 2, 1]);
  expect(failures).toEqual([2]);
  expect(stored.map((r) => r.subject.id)).toEqual([3, 1]);
});

test('trends 未配置、搜索结果无效、详情全部失败或 ID 不符时不写库；存储错误透传', async () => {
  let writes = 0;
  const repo = {
    mergeTrends: async () => {
      writes++;
    },
  };
  await expect(new TrendsSyncService(repo).sync()).rejects.toMatchObject({
    code: 'BANGUMI_SYNC_DISABLED',
  });
  await expect(
    new TrendsSyncService(repo, {
      getTrends: async () => ({ subjectIds: [0], total: 1, fetchedAt: 10 }),
      getSubject: async (id) => record(id),
    }).sync(),
  ).rejects.toMatchObject({ code: 'BANGUMI_TRENDS_ERROR' });
  await expect(
    new TrendsSyncService(repo, {
      getTrends: async () => ({ subjectIds: [1], total: 1, fetchedAt: 10 }),
      getSubject: async () => record(2),
    }).sync(),
  ).rejects.toMatchObject({ code: 'BANGUMI_API_ERROR' });
  expect(writes).toBe(0);
  const failure = new Error('storage unavailable');
  await expect(
    new TrendsSyncService(
      {
        mergeTrends: async () => {
          throw failure;
        },
      },
      {
        getTrends: async () => ({ subjectIds: [1], total: 1, fetchedAt: 10 }),
        getSubject: async (id) => record(id),
      },
    ).sync(),
  ).rejects.toBe(failure);
});

test('trends 搜索为空时保存成功摘要，不请求详情或生成导入记录', async () => {
  const service = new TrendsSyncService(
    {
      mergeTrends: async (records, result) => {
        expect(records).toEqual([]);
        expect(result).toMatchObject({
          discovered: 0,
          attempted: 0,
          imported: 0,
          failedIds: [],
          status: 'complete',
        });
      },
    },
    {
      getTrends: async () => ({ subjectIds: [], total: 0, fetchedAt: 10 }),
      getSubject: async () => {
        throw new Error('空搜索不应调用详情');
      },
    },
  );
  expect(await service.sync()).toEqual({
    page: 1,
    pageSize: 20,
    total: 0,
    nextPage: null,
    discovered: 0,
    attempted: 0,
    imported: 0,
    failedIds: [],
    dataAsOf: new Date(10).toISOString(),
    status: 'complete',
  });
});

test('trends 下一页根据原始分页位置和 total 计算，重复 ID 不影响翻页；空页和末页结束', async () => {
  for (const [page, total, ids, nextPage] of [
    [1, 21, [1, 1], 2],
    [2, 41, [1], 3],
    [2, 40, [1], null],
    [3, 41, [1], null],
    [9, 100, [], null],
  ] as const) {
    const service = new TrendsSyncService(
      { mergeTrends: async () => {} },
      {
        getTrends: async () => ({ subjectIds: [...ids], total, fetchedAt: 10 }),
        getSubject: async (id) => record(id),
      },
    );
    expect(await service.sync(page)).toMatchObject({ page, pageSize: 20, total, nextPage });
  }
});

test('trends 页码无效或上游超过一页时不导入，不会静默截断', async () => {
  let calls = 0;
  let writes = 0;
  const service = new TrendsSyncService(
    {
      mergeTrends: async () => {
        writes++;
      },
    },
    {
      getTrends: async () => {
        calls++;
        return {
          subjectIds: Array.from({ length: 21 }, (_, i) => i + 1),
          total: 100,
          fetchedAt: 10,
        };
      },
      getSubject: async () => {
        throw new Error('不应获取详情');
      },
    },
  );
  await expect(service.sync(0)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(service.sync(1)).rejects.toMatchObject({ code: 'BANGUMI_TRENDS_ERROR' });
  expect(writes).toBe(0);
});
