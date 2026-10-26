import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { createApp } from '../src/http/app.ts';
import { readConfig } from '../src/config.ts';
import { importSchema } from '../src/core/models.ts';
import { backupFixture } from './helpers/backup.ts';
import { assertResponse, document } from './helpers/openapi.ts';

const token = 'openapi-test-token-at-least-32-characters';
const timestamp = Date.parse('2026-01-01T00:00:00Z');
function record(id: number, name = `动画${id}`, aliases: string[] = []) {
  return importSchema.parse({
    subject: { id, name, metadataAt: timestamp, cachedAt: timestamp },
    aliases,
    rating: {
      subjectId: id,
      score: 8,
      votes: 12,
      rank: null,
      source: 'api',
      dataAsOf: timestamp,
      fetchedAt: timestamp,
    },
  });
}
function setup(
  env: Record<string, unknown> = {},
  dependencies: Parameters<typeof createApp>[2] = {},
) {
  const driver = new SqliteDriver(':memory:');
  driver.migrate();
  const repo = new SqlRepository(driver);
  const app = createApp(
    repo,
    readConfig({
      ADMIN_TOKEN: token,
      STATS_ENABLED: 'true',
      ALIAS_MISS_STATS_ENABLED: 'true',
      ...env,
    }),
    { writeErrorLog() {}, ...dependencies },
  );
  return { driver, repo, app };
}
function client(app: ReturnType<typeof createApp>) {
  const covered = new Set<string>();
  let spec = document;
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
    auth = true,
    raw = false,
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
    });
    const value = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(value));
    assert.match(response.headers.get('X-Request-ID') ?? '', /^[0-9a-f-]{36}$/u);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/u);
    const key = assertResponse(spec, path, method, status, value);
    if (status === 200) covered.add(key);
    if (path === '/openapi.json' && status === 200) spec = value;
    return value;
  };
  return { request, covered };
}

test('OpenAPI 契约：全部操作在真实路由和 SQLite 上返回文档声明的结构', async (t) => {
  let failPlatform = true;
  const { app, driver } = setup(
    {},
    {
      subjectSource: {
        async getSubject(id) {
          return record(id);
        },
      },
      searchSource: {
        async searchSubjects(keyword, limit) {
          assert.equal(keyword, '动画');
          assert.equal(limit, 10);
          return {
            total: 1,
            candidates: [
              {
                id: 777,
                name: '动画777',
                nameCn: '',
                airDate: null,
                platform: '',
                summary: '',
                score: null,
                votes: 0,
              },
            ],
          };
        },
      },
      calendarSource: {
        async getCalendar() {
          return {
            fetchedAt: timestamp,
            items: [900, 901].map((id) => ({
              id,
              name: `日历动画${id}`,
              nameCn: '',
              airDate: null,
              rating: null,
            })),
          };
        },
        async getSubjectPlatform(id) {
          if (failPlatform && id === 901) throw new Error('模拟上游失败');
          return 'TV';
        },
      },
    },
  );
  t.after(() => driver.close());
  const { request, covered } = client(app);
  await request('/health/live');
  const spec = await request('/openapi.json');
  await request('/health/ready');
  // 省略默认字段的输入必须真实可用，输出仍须包含完整字段。
  await request('/api/v1/admin/import', 'POST', {
    subject: { id: 100, name: '动画100', metadataAt: timestamp, cachedAt: timestamp },
    aliases: ['共同名称', 'Original'],
    rating: record(100).rating,
  });
  await request('/api/v1/admin/import', 'POST', record(101, '动画101', ['共同名称']));
  await request('/api/v1/admin/import', 'POST', { ...record(102), rating: null });
  await request('/api/v1/admin/import', 'POST', {
    ...record(103),
    rating: { ...record(103).rating!, score: null },
  });
  await request('/api/v1/admin/import', 'POST', record(104));

  const firstPage = await request('/api/v1/admin/export');
  assert.equal(firstPage.records.length, 5);
  assert.equal(firstPage.nextCursor, 104);
  assert.deepEqual(await request(`/api/v1/admin/export?after=${firstPage.nextCursor}`), {
    records: [],
    nextCursor: null,
  });
  const batch = await request('/api/v1/ratings/batch', 'POST', {
    items: [
      { inputId: 'exact', names: ['动画100'] },
      { inputId: 'normalized', names: ['ORIGINAL'] },
      { inputId: 'id', subjectId: 100 },
      { inputId: 'link', names: ['https://bgm.tv/subject/100'] },
      { inputId: 'missing', names: ['未命中名称'] },
      { inputId: 'ambiguous', names: ['共同名称'] },
      { inputId: 'conflict', names: ['动画100', '动画101'] },
      { inputId: 'unavailable', subjectId: 102 },
      { inputId: 'unrated', subjectId: 103 },
    ],
  });
  assert.deepEqual(
    batch.results.map((r: any) => r.status),
    [
      'matched',
      'matched',
      'matched',
      'matched',
      'not_found',
      'ambiguous',
      'ambiguous',
      'matched',
      'matched',
    ],
  );
  assert.equal(batch.results[1].matchReason, 'normalized_alias');
  assert.equal(batch.results[7].ratingStatus, 'unavailable');
  assert.equal(batch.results[8].ratingStatus, 'unrated');
  await request('/api/v1/subjects/100');
  await request('/api/v1/subjects/100/aliases');
  const misses = await request('/api/v1/admin/stats/alias-misses?planned=true&limit=1000');
  assert.equal(misses.aliases[0].name, '未命中名称');
  await request('/api/v1/admin/stats/alias-misses', 'PATCH', {
    name: '未命中名称',
    planned: false,
  });
  const added = await request('/api/v1/admin/subjects/100/aliases', 'POST', { name: '未命中名称' });
  assert.deepEqual((await request('/api/v1/admin/stats/alias-misses')).aliases, []);
  const reused = await request('/api/v1/admin/subjects/100/aliases', 'POST', { name: '动画100' });
  assert.equal(reused.alias.source, 'bangumi');
  await request(`/api/v1/admin/aliases/${added.alias.id}`, 'PATCH', { name: '修改后的别名' });
  await request(`/api/v1/admin/aliases/${added.alias.id}`, 'DELETE');
  await request('/api/v1/admin/subjects/search', 'POST', { keyword: '动画' });
  await request('/api/v1/admin/subjects/777/sync', 'POST');
  const partial = await request('/api/v1/admin/calendar/sync', 'POST');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.platformFailures, [901]);
  failPlatform = false;
  assert.equal((await request('/api/v1/admin/calendar/sync', 'POST')).status, 'complete');
  await request('/api/v1/admin/restore', 'POST', backupFixture(200));
  assert((await request('/api/v1/admin/stats')).subjects.length > 0);
  assert((await request('/api/v1/admin/retention?days=1')).candidates.length > 0);
  assert((await request('/api/v1/admin/stats/prune', 'POST', {})).deleted > 0);
  const key = encodeURIComponent('检查点:自定义');
  assert.deepEqual(await request(`/api/v1/admin/sync-state/${key}`), { value: null });
  await request(`/api/v1/admin/sync-state/${key}`, 'PUT', { value: '{"line":20}' });
  assert.equal((await request(`/api/v1/admin/sync-state/${key}`)).value, '{"line":20}');
  const expected = Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations as object).map((method) => `${method.toUpperCase()} ${path}`),
  );
  assert.deepEqual([...covered].sort(), expected.sort());
});

test('OpenAPI 契约：校验、鉴权、缺失、冲突及请求体限制错误与对应操作一致', async (t) => {
  const { app, driver } = setup({ MAX_BATCH_SIZE: 1 });
  t.after(() => driver.close());
  const { request } = client(app);
  await request('/openapi.json');
  await request('/api/v1/admin/import', 'POST', record(100), 401, false);
  await request('/api/v1/ratings/batch', 'POST', '{bad', 400, true, true);
  const invalid = await request(
    '/api/v1/ratings/batch',
    'POST',
    { items: [{ inputId: 'a' }] },
    400,
  );
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  assert(Array.isArray(invalid.error.issues[0].path));
  await request(
    '/api/v1/ratings/batch',
    'POST',
    {
      items: [
        { inputId: 'a', subjectId: 1 },
        { inputId: 'b', subjectId: 2 },
      ],
    },
    400,
  );
  for (const path of [
    '/api/v1/subjects/0',
    '/api/v1/admin/export?after=-1',
    '/api/v1/admin/stats/alias-misses?planned=TRUE',
    '/api/v1/admin/stats/alias-misses?limit=0',
    '/api/v1/admin/retention?days=0',
  ])
    await request(path, 'GET', undefined, 400);
  await request('/api/v1/admin/stats/prune', 'POST', { days: 1 }, 400);
  await request('/api/v1/admin/stats/prune', 'POST', undefined, 400);
  await request('/api/v1/subjects/999', 'GET', undefined, 404);
  await request('/api/v1/subjects/999/aliases', 'GET', undefined, 404);
  await request('/api/v1/admin/subjects/999/aliases', 'POST', { name: '不存在的条目' }, 404);
  await request(
    '/api/v1/admin/stats/alias-misses',
    'PATCH',
    { name: '不存在的未命中记录', planned: false },
    404,
  );
  await request('/api/v1/admin/import', 'POST', record(100));
  const added = await request('/api/v1/admin/subjects/100/aliases', 'POST', { name: '手动别名' });
  await request(`/api/v1/admin/aliases/${added.alias.id}`, 'PATCH', { name: '动画100' }, 409);
  const aliases = await request('/api/v1/subjects/100/aliases');
  const bangumi = aliases.aliases.find((a: any) => a.source === 'bangumi');
  await request(`/api/v1/admin/aliases/${bangumi.id}`, 'PATCH', { name: '不能修改' }, 404);
  await request(`/api/v1/admin/aliases/${bangumi.id}`, 'DELETE', undefined, 404);
  await request('/api/v1/admin/restore', 'POST', backupFixture(100), 409);
  await request(
    '/api/v1/admin/import',
    'POST',
    { ...record(101), rating: record(100).rating },
    400,
  );
  await request('/api/v1/admin/import', 'POST', 'x'.repeat(262145), 413, false, true);
  await request('/api/v1/admin/subjects/search', 'POST', { keyword: '动画' }, 503);
  await request('/api/v1/admin/subjects/100/sync', 'POST', undefined, 503);
  await request('/api/v1/admin/calendar/sync', 'POST', undefined, 503);
});

test('OpenAPI 契约：未启用管理、未就绪、存储和上游失败使用声明的 503 错误', async (t) => {
  const disabled = setup({ ADMIN_TOKEN: '' });
  t.after(() => disabled.driver.close());
  await client(disabled.app).request('/api/v1/admin/stats', 'GET', undefined, 503);
  const broken = setup(
    {},
    {
      subjectSource: {
        async getSubject() {
          throw new Error('模拟上游失败');
        },
      },
      searchSource: {
        async searchSubjects() {
          throw new Error('模拟上游失败');
        },
      },
      calendarSource: {
        async getCalendar() {
          throw new Error('模拟上游失败');
        },
        async getSubjectPlatform() {
          return '';
        },
      },
    },
  );
  t.after(() => broken.driver.close());
  const { request } = client(broken.app);
  await request('/api/v1/admin/subjects/search', 'POST', { keyword: '动画' }, 503);
  await request('/api/v1/admin/subjects/100/sync', 'POST', undefined, 503);
  await request('/api/v1/admin/calendar/sync', 'POST', undefined, 503);
  broken.repo.ready = async () => false;
  assert.equal((await request('/health/ready', 'GET', undefined, 503)).error.code, 'NOT_READY');
  broken.repo.findSubjects = async () => {
    throw new Error('模拟数据库不可用');
  };
  assert.equal(
    (await request('/api/v1/subjects/100', 'GET', undefined, 503)).error.code,
    'SERVICE_UNAVAILABLE',
  );
  const missing = await broken.app.request('/not-an-api');
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as any).error.code, 'NOT_FOUND');
});
