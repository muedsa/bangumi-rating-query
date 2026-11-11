import { expect, spyOn, test } from 'bun:test';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';
import { fromTrendsSearchPage, trendsSearchBody } from '../../src/adapters/bangumi/trends.ts';
import { readConfig } from '../../src/config.ts';
import { importSchema, type ImportRecord } from '../../src/core/models.ts';
import { TrendsSyncService } from '../../src/core/trends-sync-service.ts';
import { trendsResponse, trendsSearchResult } from '../helpers/trends.ts';
import { runTrendsJob } from '../../src/scheduling/trends.ts';
import { createServerErrorLogger } from '../../src/observability/errors.ts';

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
    expect((await client.getTrends(10)).subjectIds).toEqual([1]);
    expect((await client.getSubject(1)).rating?.score).toBe(8);
    expect(sleeps).toEqual([2000]);
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.bgm.tv/v0/search/subjects?limit=10&offset=0',
      'https://api.bgm.tv/v0/search/subjects?limit=10&offset=0',
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

test('trends 默认取 24 条和上限 100 均按每页最多 20 条获取，未配置 Token 时不发送认证头', async () => {
  const pages: [number, number][] = [];
  const client = new BangumiClient('tester/trends', {
    fetcher: (async (input, init) => {
      const url = new URL(String(input));
      const size = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      pages.push([size, offset]);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json({
        ...trendsSearchResult(Array.from({ length: size }, (_, i) => offset + i + 1)),
        total: 500,
      });
    }) as typeof fetch,
  });
  expect((await client.getTrends()).subjectIds).toEqual(
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  expect(pages).toEqual([
    [20, 0],
    [4, 20],
  ]);
  pages.length = 0;
  expect((await client.getTrends(100)).subjectIds.length).toBe(100);
  expect(pages).toEqual([
    [20, 0],
    [20, 20],
    [20, 40],
    [20, 60],
    [20, 80],
  ]);
  for (const limit of [0, -1, 101, 1.5, NaN])
    await expect(client.getTrends(limit)).rejects.toThrow('1～100');
  expect(pages.length).toBe(5);
});

test('trends 跨页保持热度顺序去重，按原始结果数推进，所有分页使用同一日期范围', async () => {
  const bodies: string[] = [];
  const offsets: number[] = [];
  const client = new BangumiClient('tester/trends', {
    fetcher: (async (input, init) => {
      bodies.push(String(init?.body));
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      offsets.push(offset);
      return Response.json({ ...trendsSearchResult(offset === 0 ? [3, 2, 3] : [2, 1]), total: 5 });
    }) as typeof fetch,
  });
  expect((await client.getTrends(10)).subjectIds).toEqual([3, 2, 1]);
  expect(offsets).toEqual([0, 3]);
  expect(new Set(bodies).size).toBe(1);
});

test('trends 空页停止分页；后续分页失败或超过请求数量时拒绝整轮搜索', async () => {
  let calls = 0;
  let fail = false;
  const client = new BangumiClient('tester/trends', {
    fetcher: (async () => {
      calls++;
      if (calls === 1) return Response.json({ ...trendsSearchResult([1]), total: 100 });
      return fail ? new Response('', { status: 403 }) : Response.json({ total: 100, data: [] });
    }) as unknown as typeof fetch,
  });
  expect((await client.getTrends()).subjectIds).toEqual([1]);
  expect(calls).toBe(2);
  calls = 0;
  fail = true;
  await expect(client.getTrends()).rejects.toThrow('HTTP 403');
  expect(calls).toBe(2);
  const oversized = new BangumiClient('tester/trends', {
    fetcher: (async () => trendsResponse([1, 2])) as unknown as typeof fetch,
  });
  await expect(oversized.getTrends(1)).rejects.toThrow('超过请求数量');
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

test('trends 按配置截取，串行获取，部分失败仅合并成功记录并返回失败 ID', async () => {
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
      getTrends: async (limit) => {
        expect(limit).toBe(3);
        return { subjectIds: [3, 2, 3, 1, 4], fetchedAt: 10 };
      },
      getSubject: async (id) => {
        calls.push(id);
        if (id === 2) throw new Error('HTTP 404');
        return record(id);
      },
    },
    3,
  );
  expect(await service.sync((id) => failures.push(id))).toEqual({
    discovered: 4,
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
      getTrends: async () => ({ subjectIds: [0], fetchedAt: 10 }),
      getSubject: async (id) => record(id),
    }).sync(),
  ).rejects.toMatchObject({ code: 'BANGUMI_TRENDS_ERROR' });
  await expect(
    new TrendsSyncService(repo, {
      getTrends: async () => ({ subjectIds: [1], fetchedAt: 10 }),
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
        getTrends: async () => ({ subjectIds: [1], fetchedAt: 10 }),
        getSubject: async (id) => record(id),
      },
    ).sync(),
  ).rejects.toBe(failure);
});

test('trends 调度配置默认关闭、21 点、24 条，严格校验取值', () => {
  expect(readConfig({})).toMatchObject({
    TRENDS_SYNC_ENABLED: false,
    TRENDS_SYNC_HOUR_UTC: 21,
    TRENDS_SYNC_LIMIT: 24,
  });
  for (const input of [
    { TRENDS_SYNC_ENABLED: '1' },
    { TRENDS_SYNC_HOUR_UTC: '24' },
    { TRENDS_SYNC_LIMIT: '0' },
    { TRENDS_SYNC_LIMIT: '101' },
    { TRENDS_SYNC_LIMIT: '1.5' },
  ])
    expect(() => readConfig(input)).toThrow();
});

test('trends 定时错误日志包含关联 ID 和条目 ID，脱敏后向平台报告失败', async () => {
  const logs: string[] = [];
  const log = createServerErrorLogger({
    secrets: ['private-token'],
    write: (line) => logs.push(line),
  });
  await expect(
    runTrendsJob(
      {
        sync: async (onError) => {
          const error = new Error('private-token HTTP 401');
          onError?.(10, error);
          throw error;
        },
      },
      log,
    ),
  ).rejects.toThrow('Bangumi 热度定时同步失败');
  const entries = logs.map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({
    event: 'trends_subject_failed',
    subjectId: 10,
    trigger: 'scheduled',
  });
  expect(entries[1]).toMatchObject({
    event: 'trends_sync_failed',
    requestId: entries[0].requestId,
  });
  expect(logs.join('')).not.toContain('private-token');
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
      getTrends: async () => ({ subjectIds: [], fetchedAt: 10 }),
      getSubject: async () => {
        throw new Error('空搜索不应调用详情');
      },
    },
  );
  expect(await service.sync()).toEqual({
    discovered: 0,
    attempted: 0,
    imported: 0,
    failedIds: [],
    dataAsOf: new Date(10).toISOString(),
    status: 'complete',
  });
});
