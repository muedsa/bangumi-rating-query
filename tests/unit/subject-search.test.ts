import { expect, test } from 'bun:test';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';
import { createApp } from '../../src/http/app.ts';
import { readConfig } from '../../src/config.ts';
import type { ApplicationRepository } from '../../src/core/ports.ts';

const entry = (id: number) => ({
  id,
  type: 2,
  name: `作品${id}`,
  name_cn: `中文${id}`,
  date: '2026-01-01',
  platform: 'TV',
  summary: '剧情',
  rating: { score: 8, total: 10 },
});

test('搜索以 POST 发送动画筛选与数量，重试保留 Bearer 和 JSON 正文，候选去重并限制数量', async () => {
  const requests: RequestInit[] = [];
  const client = new BangumiClient('test/search', {
    accessToken: 'token',
    sleep: async () => {},
    fetcher: (async (url, init) => {
      expect(String(url)).toBe('https://api.bgm.tv/v0/search/subjects?limit=2&offset=0');
      requests.push(init!);
      return requests.length === 1
        ? new Response('', { status: 503 })
        : Response.json({
            total: 5,
            data: [
              entry(1),
              entry(1),
              { ...entry(2), type: 1 },
              { ...entry(3), rating: { score: 0, total: 0 } },
              entry(4),
            ],
          });
    }) as typeof fetch,
  });
  const result = await client.searchSubjects('  别名  ', 2);
  expect(result.total).toBe(5);
  expect(result.candidates.map((c) => c.id)).toEqual([1, 3]);
  expect(result.candidates[1]!.score).toBeNull();
  expect(result.candidates[0]).toMatchObject({
    nameCn: '中文1',
    airDate: '2026-01-01',
    platform: 'TV',
    score: 8,
    votes: 10,
  });
  for (const request of requests) {
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(request.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({
      keyword: '别名',
      sort: 'match',
      filter: { type: [2] },
    });
  }
});

test('搜索空结果、无 Token、参数与上游响应校验，以及详情 ID 不一致拒绝导入', async () => {
  let calls = 0;
  let response: unknown = { total: 0, data: [] };
  const client = new BangumiClient('test/search', {
    fetcher: (async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json(response);
    }) as typeof fetch,
  });
  for (const limit of [0, -1, 1.5, 51])
    await expect(client.searchSubjects('test', limit)).rejects.toThrow();
  await expect(client.searchSubjects(' ', 10)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await client.searchSubjects('test', 10)).toEqual({ total: 0, candidates: [] });
  response = { total: 1, data: [{ id: 'bad' }] };
  await expect(client.searchSubjects('test', 10)).rejects.toThrow();
  response = entry(2);
  await expect(client.getSubject(1)).rejects.toThrow('ID 与请求不一致');
});

test('搜索未配置上游时返回明确错误，OpenAPI 声明管理员鉴权和参数范围', async () => {
  const token = 'search-test-token-at-least-32-characters';
  const app = createApp({} as ApplicationRepository, readConfig({ ADMIN_TOKEN: token }), {
    writeErrorLog() {},
  });
  const response = await app.request('/api/v1/admin/subjects/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: '动画' }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'BANGUMI_SEARCH_DISABLED' } });
  const spec = (await (await app.request('/openapi.json')).json()) as any;
  const operation = spec.paths['/api/v1/admin/subjects/search'].post;
  expect(operation.security).toEqual([{ bearerAuth: [] }]);
  expect(operation.requestBody.content['application/json'].schema.properties.limit.maximum).toBe(
    50,
  );
});

test('Bangumi 重定向响应不被跟随或重试', async () => {
  let calls = 0;
  const client = new BangumiClient('test/search', {
    accessToken: 'secret',
    fetcher: (async (_url, init) => {
      calls++;
      expect(init?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { Location: 'https://example.com' } });
    }) as typeof fetch,
  });
  await expect(client.searchSubjects('动画', 1)).rejects.toThrow('HTTP 302');
  expect(calls).toBe(1);
});
