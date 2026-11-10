import { expect, test } from 'bun:test';
import { BangumiClient, createBangumiSource } from '../../src/adapters/bangumi/client.ts';
import {
  fromTrendsHtml,
  MAX_TRENDS_HTML_BYTES,
  readTrendsHtml,
  TRENDS_URL,
} from '../../src/adapters/bangumi/trends.ts';
import { readConfig } from '../../src/config.ts';
import { importSchema, type ImportRecord } from '../../src/core/models.ts';
import { TrendsSyncService } from '../../src/core/trends-sync-service.ts';
import { trendsHtml, trendsResponse } from '../helpers/trends.ts';
import { runTrendsJob } from '../../src/scheduling/trends.ts';
import { createServerErrorLogger } from '../../src/observability/errors.ts';

test('trends 只取列表标题的条目，保持热度顺序去重，兼容属性顺序、空白和单双引号', () => {
  const html = trendsHtml([201, 100, 201]).replace(
    'id="browserItemList" class="browserFull"',
    "class='browserFull'\n id='browserItemList'",
  );
  expect(fromTrendsHtml(html, 10)).toEqual({ subjectIds: [201, 100], fetchedAt: 10 });
});

test('trends 拒绝验证页、空列表、结构变化、无效 ID 和不匹配的标题链接', () => {
  for (const html of [
    '<html><title>Just a moment...</title><a href="/subject/1">test</a></html>',
    trendsHtml([]),
    trendsHtml([1]).replace('browserItemList', 'changedList'),
    trendsHtml([1]).replace('item_1', 'item_0'),
    trendsHtml([1]).replace('item_1', 'item_9007199254740992'),
    trendsHtml([1]).replaceAll('/subject/1', '/subject/2'),
    trendsHtml([1]).replaceAll('/subject/1', 'https://example.com/subject/1'),
    trendsHtml([1]).replaceAll('<h3>', '<h4>').replaceAll('</h3>', '</h4>'),
  ])
    expect(() => fromTrendsHtml(html)).toThrow();
});

test('网页请求不发送 Token/Cookie，详情 API 仍使用 Bearer；429 重试保留相同目标', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const client = new BangumiClient('tester/trends', {
    accessToken: 'private-token',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetcher: (async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1)
        return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      return String(input) === TRENDS_URL
        ? trendsResponse([1])
        : Response.json({ id: 1, type: 2, name: '动画', rating: { score: 8, total: 5 } });
    }) as typeof fetch,
  });
  expect((await client.getTrends()).subjectIds).toEqual([1]);
  expect((await client.getSubject(1)).rating?.score).toBe(8);
  expect(sleeps).toEqual([2000]);
  expect(requests.map((r) => r.url)).toEqual([
    TRENDS_URL,
    TRENDS_URL,
    'https://api.bgm.tv/v0/subjects/1',
  ]);
  for (const { init } of requests.slice(0, 2)) {
    const headers = new Headers(init?.headers);
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.has('Cookie')).toBe(false);
    expect(headers.get('User-Agent')).toBe('tester/trends');
    expect(headers.get('Accept')).toBe('text/html');
    expect(init?.redirect).toBe('manual');
  }
  expect(new Headers(requests[2]!.init?.headers).get('Authorization')).toBe('Bearer private-token');
});

test('网页 403 和重定向不重试，不解析或输出错误正文', async () => {
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

test('HTML 读取校验 MIME 和实际流长度，不依赖 Content-Length', async () => {
  await expect(readTrendsHtml(Response.json({ html: trendsHtml() }))).rejects.toThrow(
    '未返回 HTML',
  );
  for (const declared of [undefined, '1', String(MAX_TRENDS_HTML_BYTES + 1)]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TRENDS_HTML_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readTrendsHtml(
        new Response(body, {
          headers: {
            'Content-Type': 'text/html',
            ...(declared ? { 'Content-Length': declared } : {}),
          },
        }),
      ),
    ).rejects.toThrow('超过 2 MiB');
    expect(cancelled).toBe(true);
  }
});

test('browser 模式通过渲染器获取页面，不回退到网页 fetch', async () => {
  const calls: string[] = [];
  const client = new BangumiClient('tester/trends', {
    fetcher: (async (input) => {
      calls.push(`fetch:${String(input)}`);
      return trendsResponse([1]);
    }) as typeof fetch,
    trendsRenderer: {
      render: async (url) => {
        calls.push(`render:${url}`);
        return trendsHtml([7]);
      },
    },
  });
  expect((await client.getTrends()).subjectIds).toEqual([7]);
  expect(calls).toEqual([`render:${TRENDS_URL}`]);

  const source = createBangumiSource(
    { BANGUMI_USER_AGENT: 'tester/trends', BANGUMI_ACCESS_TOKEN: '' },
    { trendsRenderer: { render: async () => trendsHtml([9]) } },
  );
  expect((await source!.getTrends()).subjectIds).toEqual([9]);
});

test('browser 模式缺少渲染器时明确失败，不回退 HTTP', async () => {
  let fetches = 0;
  const client = new BangumiClient('tester/trends', {
    trendsFetchMode: 'browser',
    fetcher: (async () => {
      fetches++;
      return trendsResponse([1]);
    }) as unknown as typeof fetch,
  });
  await expect(client.getTrends()).rejects.toThrow('未配置浏览器渲染器');
  expect(fetches).toBe(0);
});

test('browser 渲染失败直接失败，不回退 HTTP；渲染结果仍校验 2 MiB 上限', async () => {
  const failure = new Error('challenge timeout');
  let fetches = 0;
  const client = new BangumiClient('tester/trends', {
    fetcher: (async () => {
      fetches++;
      return trendsResponse([1]);
    }) as unknown as typeof fetch,
    trendsRenderer: {
      render: async () => {
        throw failure;
      },
    },
  });
  await expect(client.getTrends()).rejects.toBe(failure);
  const oversized = new BangumiClient('tester/trends', {
    fetcher: (async () => trendsResponse([1])) as unknown as typeof fetch,
    trendsRenderer: {
      render: async () => 'x'.repeat(MAX_TRENDS_HTML_BYTES + 1),
    },
  });
  await expect(oversized.getTrends()).rejects.toThrow('超过 2 MiB');
  expect(fetches).toBe(0);
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
      getTrends: async () => ({ subjectIds: [3, 2, 3, 1, 4], fetchedAt: 10 }),
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

test('trends 未配置、页面无效、详情全部失败或 ID 不符时不写库；存储错误透传', async () => {
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
      getTrends: async () => ({ subjectIds: [], fetchedAt: 10 }),
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

test('trends 调度配置默认关闭、21 点、24 条、browser 模式，严格校验取值', () => {
  expect(readConfig({})).toMatchObject({
    TRENDS_SYNC_ENABLED: false,
    TRENDS_SYNC_HOUR_UTC: 21,
    TRENDS_SYNC_LIMIT: 24,
    TRENDS_FETCH_MODE: 'browser',
    TRENDS_BROWSER_TIMEOUT_MS: 45000,
  });
  for (const input of [
    { TRENDS_SYNC_ENABLED: '1' },
    { TRENDS_SYNC_HOUR_UTC: '24' },
    { TRENDS_SYNC_LIMIT: '0' },
    { TRENDS_SYNC_LIMIT: '101' },
    { TRENDS_SYNC_LIMIT: '1.5' },
    { TRENDS_FETCH_MODE: 'puppeteer' },
    { TRENDS_BROWSER_TIMEOUT_MS: '4999' },
    { TRENDS_BROWSER_TIMEOUT_MS: '120001' },
    { TRENDS_BROWSER_TIMEOUT_MS: '1.5' },
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
