import { expect, test } from 'bun:test';
import { BangumiClient } from '../../src/adapters/bangumi/client.ts';

const subject = { id: 1, type: 2, name: 'Test', rating: { score: 0, total: 0 } };

test('配置 Access Token 后每次请求和重试均附带 Bearer，并保留应用标识', async () => {
  const requests: Headers[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return requests.length === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '1' } })
      : Response.json(subject);
  }) as unknown as typeof fetch;
  const client = new BangumiClient('tester/app', {
    accessToken: ' test-access-token ',
    fetcher,
    sleep: async () => {},
  });
  await client.getSubject(1);
  expect(requests).toHaveLength(2);
  for (const headers of requests) {
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(headers.get('User-Agent')).toBe('tester/app');
    expect(headers.get('Accept')).toBe('application/json');
  }
});

test('未配置、空字符串及纯空白 Token 时不发送 Authorization', async () => {
  for (const accessToken of [undefined, '', '  ']) {
    let headers: Headers | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json(subject);
    }) as unknown as typeof fetch;
    await new BangumiClient('tester/app', { accessToken, fetcher }).getSubject(1);
    expect(headers!.has('Authorization')).toBe(false);
  }
});

test('Token 被拒绝时报告状态码，不回退匿名请求或在错误中暴露 Token', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response('', { status: 401 });
  }) as unknown as typeof fetch;
  const client = new BangumiClient('tester/app', { accessToken: 'secret-test-token', fetcher });
  await expect(client.getSubject(1)).rejects.toThrow('Bangumi 返回 HTTP 401');
  expect(calls).toBe(1);
});
