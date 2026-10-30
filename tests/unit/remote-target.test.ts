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

test('单条未命中查询编码名称并校验响应，错误响应不能当作记录已清理', async () => {
  const name = '动画 & +/?#第二季';
  const alias = {
    name,
    normalizedName: name,
    planned: false,
    missCount: 2,
    firstMissedAt: 1,
    lastMissedAt: 2,
  };
  for (const value of [alias, null]) {
    const target = remoteTarget('https://example.com', 'test-token', {
      fetcher: (async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/api/v1/admin/stats/alias-misses/lookup');
        expect([...url.searchParams.entries()]).toEqual([['name', name]]);
        expect(init?.method).toBe('GET');
        return Response.json({ alias: value });
      }) as typeof fetch,
    });
    expect(await target.getAliasMiss(name)).toEqual(value);
  }
  for (const body of [{}, { alias: {} }, { alias: { ...alias, planned: 'false' } }]) {
    const target = remoteTarget('https://example.com', 'test-token', {
      fetcher: (async () => Response.json(body)) as unknown as typeof fetch,
    });
    await expect(target.getAliasMiss(name)).rejects.toThrow();
    await expect(target.setAliasMissPlanned(name, false)).rejects.toThrow();
  }
});

test('仅修改计划的 404 ALIAS_MISS_NOT_FOUND 转为缺失，其他响应和网络错误仍抛出', async () => {
  for (const [status, code] of [
    [404, 'ALIAS_MISS_NOT_FOUND'],
    [404, 'NOT_FOUND'],
    [401, 'UNAUTHORIZED'],
    [503, 'ALIAS_MISS_NOT_FOUND'],
  ] as const) {
    const target = remoteTarget('https://example.com', 'test-token', {
      fetcher: (async () =>
        Response.json({ error: { code, message: 'test' } }, { status })) as unknown as typeof fetch,
    });
    if (status === 404 && code === 'ALIAS_MISS_NOT_FOUND')
      expect(await target.setAliasMissPlanned('动画', false)).toBeNull();
    else
      await expect(target.setAliasMissPlanned('动画', false)).rejects.toThrow(
        `管理 API 返回 ${status}`,
      );
    await expect(target.getAliasMiss('动画')).rejects.toThrow(`管理 API 返回 ${status}`);
    await expect(target.alias(1, '动画')).rejects.toThrow(`管理 API 返回 ${status}`);
  }
  for (const body of [
    'Not Found',
    JSON.stringify({ error: { message: 'ALIAS_MISS_NOT_FOUND' } }),
  ]) {
    const target = remoteTarget('https://example.com', 'test-token', {
      fetcher: (async () => new Response(body, { status: 404 })) as unknown as typeof fetch,
    });
    await expect(target.setAliasMissPlanned('动画', false)).rejects.toThrow('管理 API 返回 404');
  }
  const target = remoteTarget('https://example.com', 'test-token', {
    fetcher: (async () => {
      throw new TypeError('network failure');
    }) as unknown as typeof fetch,
  });
  await expect(target.setAliasMissPlanned('动画', false)).rejects.toThrow('network failure');
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
        ? new Response('failure', {
            status: 503,
            headers: {
              'cf-ray': 'test-ray',
              'x-request-id': '01234567-89ab-4cde-8fab-0123456789ab',
            },
          })
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
    details: {
      method: 'POST',
      path: '/import',
      status: 503,
      ray: 'test-ray',
      requestId: '01234567-89ab-4cde-8fab-0123456789ab',
    },
  });
  expect(JSON.stringify(logs)).not.toContain('private-admin-token');
  expect(JSON.stringify(logs)).not.toContain('private-checkpoint');
});

test('重试 3 次表示最多发送 4 次，耗尽后保留原始错误和每次请求关联信息', async () => {
  const waits: number[] = [];
  const logs: { level: string; event: string; details: Record<string, unknown> }[] = [];
  let calls = 0;
  const target = remoteTarget('https://example.com', 'private-admin-token', {
    requestRetries: 3,
    sleep: async (ms) => {
      waits.push(ms);
    },
    log: (level, event, _message, details = {}) => logs.push({ level, event, details }),
    fetcher: (async () =>
      new Response('unavailable', {
        status: 503,
        headers: {
          'cf-ray': `ray-${++calls}`,
          'x-request-id': '01234567-89ab-4cde-8fab-0123456789ab',
        },
      })) as unknown as typeof fetch,
  });
  await expect(target.getState('private-checkpoint')).rejects.toThrow('管理 API 返回 503');
  expect(calls).toBe(4);
  expect(waits).toEqual([1000, 2000, 4000]);
  const retries = logs.filter((log) => log.event === 'api_request_retry');
  expect(retries).toHaveLength(3);
  expect(retries[0]).toMatchObject({
    level: 'warn',
    details: {
      path: '/sync-state/:key',
      attempt: 1,
      retry: 1,
      requestRetries: 3,
      waitMs: 1000,
      status: 503,
      ray: 'ray-1',
      requestId: '01234567-89ab-4cde-8fab-0123456789ab',
    },
  });
  expect(logs.at(-1)).toMatchObject({
    level: 'error',
    event: 'api_request_failed',
    details: { attempt: 4, ray: 'ray-4' },
  });
  expect(JSON.stringify(logs)).not.toContain('private-admin-token');
  expect(JSON.stringify(logs)).not.toContain('private-checkpoint');
});

test('网络、超时和临时 HTTP 错误可恢复；重放相同正文与认证并重新创建超时信号', async () => {
  for (const failure of [
    new TypeError('fetch failed'),
    new DOMException('timed out', 'TimeoutError'),
    new DOMException('aborted', 'AbortError'),
    408,
    429,
    500,
    502,
    503,
    504,
    524,
  ]) {
    const attempts: RequestInit[] = [];
    const waits: number[] = [];
    const target = remoteTarget('https://example.com', 'test-token', {
      requestRetries: 3,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetcher: (async (_url, init) => {
        attempts.push(init!);
        if (attempts.length === 1) {
          if (failure instanceof Error) throw failure;
          return new Response('temporary error', { status: failure });
        }
        return Response.json({});
      }) as typeof fetch,
    });
    await target.setState('checkpoint', '{"line":100}');
    expect(waits).toEqual([1000]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.body).toBe(attempts[0]!.body);
    expect(attempts[1]!.method).toBe('PUT');
    expect(attempts[1]!.signal).not.toBe(attempts[0]!.signal);
    expect(new Headers(attempts[1]!.headers).get('Authorization')).toBe('Bearer test-token');
  }
});

test('成功状态的响应体读取中断可重试，畸形 JSON 不重试', async () => {
  for (const brokenJson of [false, true]) {
    let calls = 0;
    const target = remoteTarget('https://example.com', 'test-token', {
      requestRetries: 3,
      sleep: async () => {},
      fetcher: (async () => {
        if (++calls > 1) return Response.json({ value: 'saved' });
        if (brokenJson) return new Response('{invalid');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('connection terminated'));
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    if (brokenJson) {
      await expect(target.getState('key')).rejects.toBeInstanceOf(SyntaxError);
      expect(calls).toBe(1);
    } else {
      expect(await target.getState('key')).toBe('saved');
      expect(calls).toBe(2);
    }
  }
});

test('默认未开启重试或显式设为 0 时立即失败；普通 4xx 即使启用重试也立即失败', async () => {
  for (const [requestRetries, status] of [
    [undefined, 503],
    [0, 503],
    ...[400, 401, 403, 404, 409, 413, 422].map((status) => [3, status]),
  ]) {
    let calls = 0;
    const waits: number[] = [];
    const target = remoteTarget('https://example.com', 'test-token', {
      requestRetries,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetcher: (async () => {
        calls++;
        return new Response('error', { status });
      }) as unknown as typeof fetch,
    });
    await expect(target.importRecord({} as never)).rejects.toThrow(`管理 API 返回 ${status}`);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  }
});

test('Retry-After 支持秒数和日期，遵守请求间隔；无效值退避，超过一分钟停止', async () => {
  const future = new Date(Date.now() + 10000).toUTCString();
  for (const retryAfter of ['2', future, 'invalid', '0', '61', '9'.repeat(400)]) {
    let calls = 0;
    const waits: number[] = [];
    const target = remoteTarget('https://example.com', 'test-token', {
      requestRetries: 3,
      requestDelayMs: 1500,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetcher: (async () =>
        ++calls === 1
          ? new Response('busy', { status: 429, headers: { 'Retry-After': retryAfter } })
          : Response.json({})) as unknown as typeof fetch,
    });
    if (retryAfter === '61' || retryAfter.length === 400) {
      await expect(target.importRecord({} as never)).rejects.toThrow('管理 API 返回 429');
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    } else {
      await target.importRecord({} as never);
      expect(calls).toBe(2);
      expect(waits).toHaveLength(1);
      if (retryAfter === future) {
        expect(waits[0]!).toBeGreaterThan(8000);
        expect(waits[0]!).toBeLessThanOrEqual(10000);
      } else expect(waits[0]).toBe(retryAfter === '2' ? 2000 : 1500);
    }
  }
});

test('启用限速时完成全部重试后再处理排队请求，重试预算按请求独立计算', async () => {
  const events: string[] = [];
  let calls = 0;
  const target = remoteTarget('https://example.com', 'test-token', {
    requestRetries: 1,
    requestDelayMs: 200,
    sleep: async (ms) => {
      events.push(`wait:${ms}`);
    },
    fetcher: (async (_url, init) => {
      events.push(`${init?.method}:${++calls}`);
      return calls % 2
        ? new Response('unavailable', { status: 503 })
        : Response.json({ value: null });
    }) as typeof fetch,
  });
  await Promise.all([target.getState('key'), target.setState('key', 'saved')]);
  expect(events).toEqual([
    'GET:1',
    'wait:1000',
    'GET:2',
    'wait:200',
    'PUT:3',
    'wait:1000',
    'PUT:4',
  ]);
});

test('重试退避上限为 30 秒，耗尽后抛出最后一次网络错误', async () => {
  const waits: number[] = [];
  let calls = 0;
  const error = new TypeError('fetch failed');
  const target = remoteTarget('https://example.com', 'test-token', {
    requestRetries: 7,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetcher: (async () => {
      calls++;
      throw error;
    }) as unknown as typeof fetch,
  });
  await expect(target.getState('key')).rejects.toBe(error);
  expect(calls).toBe(8);
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('拒绝负数、小数、非有限值和不安全的重试次数', () => {
  for (const requestRetries of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => remoteTarget('https://example.com', 'test-token', { requestRetries })).toThrow(
      '请求重试次数必须为非负安全整数',
    );
});
