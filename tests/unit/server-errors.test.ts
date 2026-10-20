import { expect, test } from 'bun:test';
import { createServerErrorLogger, requestErrorContext } from '../../src/observability/errors.ts';
import { createApp } from '../../src/http/app.ts';
import { readConfig } from '../../src/config.ts';
import type { ApplicationRepository } from '../../src/core/ports.ts';
import { runCalendarJob } from '../../src/scheduling/calendar.ts';

const admin = 'private-admin-token-with-32-characters';
const bangumi = 'private-bangumi-token';

test('服务端日志保留 SQL 错误原因和定位栈，脱敏凭证、URL、正文与参数', () => {
  const lines: string[] = [];
  const log = createServerErrorLogger({
    secrets: [admin, bangumi],
    write: (line) => lines.push(line),
  });
  const cause = new Error(
    `D1_ERROR: too many terms in compound SELECT; ${bangumi}; Bearer dynamic-token; https://user:password@example.com/?token=private-url-value; params: private-sql-value`,
  );
  cause.stack = `Error: ${cause.message}\n    at insert (file:///private/project/store.ts:12:34)\nbody: private-body-value`;
  const error = Object.assign(
    new Error(`Failed query: INSERT INTO secret_table VALUES ('private-query-value')`, { cause }),
    {
      params: ['private-property-value'],
      body: 'private-body-value',
      headers: { authorization: admin },
    },
  );
  log('request_failed', error, { status: 503, path: '/api/v1/admin/import' });
  const output = lines[0]!;
  const record = JSON.parse(output);
  expect(record).toMatchObject({
    level: 'error',
    event: 'request_failed',
    status: 503,
    error: 'Error',
  });
  expect(record.causes[0].message).toContain('[SQL_REDACTED]');
  expect(record.causes[1].message).toContain('too many terms in compound SELECT');
  expect(record.causes[1].stack[0]).toContain(':12:34');
  for (const value of [
    admin,
    bangumi,
    'dynamic-token',
    'private-url-value',
    'private-sql-value',
    'private-query-value',
    'private-property-value',
    'private-body-value',
    'private/project',
  ])
    expect(output).not.toContain(value);
});

test('服务端错误原因链有界，循环安全，脱敏发生在截断前，日志失败不向外抛出', () => {
  const lines: string[] = [];
  const log = createServerErrorLogger({ secrets: [admin], write: (line) => lines.push(line) });
  const cycle = new Error('x'.repeat(1990) + admin);
  cycle.cause = cycle;
  log('request_failed', cycle);
  const entry = JSON.parse(lines[0]!);
  expect(entry.causes.length).toBe(1);
  expect(entry.causes[0].message.length).toBeLessThanOrEqual(2000);
  expect(lines[0]).not.toContain(admin.slice(0, 8));
  let chain = new Error('last');
  for (let i = 0; i < 10; i++) chain = new Error(`cause${i}`, { cause: chain });
  log('request_failed', chain);
  expect(JSON.parse(lines[1]!).causes.length).toBe(5);
  log('request_failed', { message: 'private-object-value', body: 'private-object-body' });
  expect(lines[2]).not.toContain('private-object');
  expect(() =>
    createServerErrorLogger({
      write() {
        throw new Error('sink failed');
      },
    })('request_failed', chain),
  ).not.toThrow();
});

test('凭证脱敏覆盖 Worker 原始环境值、去空白值和编码后的形式', () => {
  const lines: string[] = [];
  const secret = 'private/token+with"quote';
  const logger = createServerErrorLogger({
    secrets: [`  ${secret}  `],
    write: (line) => lines.push(line),
  });
  logger(
    'calendar_sync_failed',
    new Error([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].join(' ')),
  );
  const message = JSON.parse(lines[0]!).causes[0].message;
  expect(message).toBe('[REDACTED] [REDACTED] [REDACTED]');
});

test('请求上下文只包含模板路径、生成的请求 ID 和格式有效的 CF Ray', () => {
  const request = new Request('https://example.com/api/v1/admin/import?token=private-query', {
    method: 'POST',
    body: 'private-request-body',
    headers: {
      Authorization: `Bearer ${admin}`,
      Cookie: 'private-cookie',
      'X-Request-ID': 'private-incoming-id',
      'CF-Ray': '0123456789abcdef-HKG',
    },
  });
  const context = requestErrorContext(request, '/api/v1/admin/import');
  expect(context).toMatchObject({
    method: 'POST',
    path: '/api/v1/admin/import',
    rayId: '0123456789abcdef-HKG',
  });
  expect(context.requestId).toMatch(/^[a-f\d-]{36}$/);
  expect(JSON.stringify(context)).not.toContain('private-');
  request.headers.set('CF-Ray', 'private-invalid-ray');
  expect(requestErrorContext(request, '/api/v1/admin/import')).not.toHaveProperty('rayId');
});

test('HTTP 503 日志关联响应请求 ID，脱敏上游 cause；400/401 不记录服务故障', async () => {
  const lines: string[] = [];
  const app = createApp(
    {} as ApplicationRepository,
    readConfig({ ADMIN_TOKEN: admin, BANGUMI_ACCESS_TOKEN: bangumi }),
    {
      writeErrorLog: (line) => lines.push(line),
      subjectSource: {
        async getSubject() {
          throw new Error(`Bangumi HTTP 401 ${bangumi}`);
        },
      },
    },
  );
  const response = await app.request('/api/v1/admin/subjects/8/sync?private-query=1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin}`, 'X-Request-ID': 'untrusted-id' },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: 'BANGUMI_API_ERROR',
      message: 'Bangumi 数据获取失败，请检查服务端认证配置或稍后重试',
    },
  });
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({
    event: 'request_failed',
    code: 'BANGUMI_API_ERROR',
    path: '/api/v1/admin/subjects/:id/sync',
    status: 503,
  });
  expect(entry.requestId).toBe(response.headers.get('X-Request-ID'));
  expect(entry.requestId).not.toBe('untrusted-id');
  expect(entry.causes[1].message).toContain('Bangumi HTTP 401');
  expect(lines.join('')).not.toContain(bangumi);
  expect(lines.join('')).not.toContain('private-query');
  expect((await app.request('/api/v1/admin/subjects/8/sync', { method: 'POST' })).status).toBe(401);
  expect(
    (await app.request('/api/v1/ratings/batch', { method: 'POST', body: '{invalid json' })).status,
  ).toBe(400);
  expect(lines.length).toBe(1);
});

test('定时任务日志保留脱敏 cause，向平台抛出的异常保持通用消息', async () => {
  const lines: string[] = [];
  const logger = createServerErrorLogger({ secrets: [bangumi], write: (line) => lines.push(line) });
  await expect(
    runCalendarJob(
      {
        async sync() {
          throw new Error('storage failed', { cause: new Error(`upstream ${bangumi}`) });
        },
      },
      logger,
    ),
  ).rejects.toThrow('Bangumi 日历定时同步失败');
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({ event: 'calendar_sync_failed', trigger: 'scheduled' });
  expect(entry.causes.length).toBe(2);
  expect(entry.requestId).toBeString();
  expect(lines[0]).not.toContain(bangumi);
});

test('统计写入错误包含请求关联信息，仍返回成功查询', async () => {
  const lines: string[] = [];
  const repo = {
    async findAliases() {
      return [];
    },
    async findSubjects() {
      return [
        {
          id: 1,
          name: '示例',
          nameCn: '',
          airDate: null,
          platform: 'TV',
          metadataAt: 0,
          cachedAt: 0,
          pinned: false,
        },
      ];
    },
    async getRatings() {
      return [];
    },
    async recordHits() {
      throw new Error('statistics write failure');
    },
  } as unknown as ApplicationRepository;
  const app = createApp(repo, readConfig({ STATS_ENABLED: 'true' }), {
    writeErrorLog: (line) => lines.push(line),
  });
  const response = await app.request('/api/v1/ratings/batch', {
    method: 'POST',
    body: JSON.stringify({ items: [{ inputId: 'private-input-id', subjectId: 1 }] }),
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).results[0].status).toBe('matched');
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({
    event: 'usage_write_failed',
    status: 200,
    path: '/api/v1/ratings/batch',
    requestId: response.headers.get('X-Request-ID'),
  });
  expect(entry.causes[0].message).toBe('statistics write failure');
  expect(lines[0]).not.toContain('private-input-id');
});
