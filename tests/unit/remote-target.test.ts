import { expect, test } from 'bun:test';
import { remoteTarget } from '../../src/cli/remote-target.ts';

test('远程请求默认不延迟；显式 0 也不调用等待函数', async () => {
  for (const requestDelayMs of [undefined, 0]) {
    const waits: number[] = [];
    const target = remoteTarget('https://example.com', 'test-token', {
      requestDelayMs,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetcher: (async () => Response.json({ value: null })) as unknown as typeof fetch,
    });
    await target.getState('key');
    await target.stats();
    expect(waits).toEqual([]);
  }
});

test('只在远程请求之间等待，覆盖导入与检查点，保留 Bearer 认证', async () => {
  const events: string[] = [];
  const target = remoteTarget('https://example.com', 'test-token', {
    requestDelayMs: 500,
    sleep: async (ms) => {
      events.push(`wait:${ms}`);
    },
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      events.push(new URL(String(url)).pathname);
      return Response.json({ value: null });
    }) as typeof fetch,
  });
  await target.getState('checkpoint');
  await target.setState('checkpoint', 'saved');
  await target.stats();
  expect(events).toEqual([
    '/api/v1/admin/sync-state/checkpoint',
    'wait:500',
    '/api/v1/admin/sync-state/checkpoint',
    'wait:500',
    '/api/v1/admin/stats',
  ]);
});

test('启用延迟时串行完成响应再发送下一请求，失败后仍可继续', async () => {
  const events: string[] = [];
  let finishFirst!: (response: Response) => void;
  let calls = 0;
  const target = remoteTarget('https://example.com', 'test-token', {
    requestDelayMs: 100,
    sleep: async (ms) => {
      events.push(`wait:${ms}`);
    },
    fetcher: (async () => {
      events.push(`request:${++calls}`);
      if (calls === 1)
        return await new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  const first = target.stats();
  const second = target.stats();
  const outcome = first.catch((error: unknown) => error);
  await Promise.resolve();
  expect(events).toEqual(['request:1']);
  finishFirst(new Response('unavailable', { status: 503 }));
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('管理 API 返回 503');
  await second;
  expect(events).toEqual(['request:1', 'wait:100', 'request:2']);
});

test('拒绝负数、小数和会导致定时器溢出的延迟', () => {
  for (const requestDelayMs of [-1, 0.5, Infinity, 2147483648])
    expect(() => remoteTarget('https://example.com', 'test-token', { requestDelayMs })).toThrow();
});

test('远程请求日志包含状态、Ray 和耗时，失败后仍抛出原始错误', async () => {
  const logs: { level: string; event: string; details: Record<string, unknown> }[] = [];
  let fail = false;
  const target = remoteTarget('https://example.com', 'private-admin-token', {
    log: (level, event, _message, details = {}) => logs.push({ level, event, details }),
    fetcher: (async () =>
      fail
        ? new Response('failure', { status: 503, headers: { 'cf-ray': 'test-ray' } })
        : Response.json({ value: null })) as unknown as typeof fetch,
  });
  await target.getState('private-checkpoint');
  expect(logs[0]!.details.path).toBe('/sync-state/:key');
  expect(logs[1]).toMatchObject({ event: 'api_request_completed', details: { status: 200 } });
  expect(typeof logs[1]!.details.durationMs).toBe('number');
  fail = true;
  await expect(target.importRecord({} as never)).rejects.toThrow('管理 API 返回 503');
  expect(logs.at(-1)).toMatchObject({
    level: 'error',
    event: 'api_request_failed',
    details: { method: 'POST', path: '/import', status: 503, ray: 'test-ray' },
  });
  expect(JSON.stringify(logs)).not.toContain('private-admin-token');
  expect(JSON.stringify(logs)).not.toContain('private-checkpoint');
});
