import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import { serve } from '@hono/node-server';
import { zipSync, strToU8 } from 'fflate';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { createApp } from '../src/http/app.ts';
import { readConfig } from '../src/config.ts';
import { extractSubjects } from '../src/cli/archive.ts';
import type { ImportRecord } from '../src/core/models.ts';
import { batchResponseSchema } from '../src/http/openapi.ts';
import { BangumiClient } from '../src/adapters/bangumi/client.ts';

const token = 'integration-test-token-with-32-characters';
const migration = readFileSync('migrations/0001_initial.sql', 'utf8');
const asOf = Date.parse('2026-01-01T00:00:00Z');

test('Archive dry-run 默认全量统计，不请求 API、不创建数据库或错误文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-dry-run-'));
  const file = join(dir, 'subject.jsonlines');
  const database = join(dir, 'untouched', 'app.sqlite');
  const source =
    [
      JSON.stringify({ id: 99, type: 4 }),
      '',
      '{invalid json',
      JSON.stringify({
        id: 2174,
        type: 2,
        name: '损坏条目',
        infobox: '{{Infobox animanga\n|别名=测试\n\\\n}}',
      }),
      ...Array.from({ length: 1201 }, (_, i) =>
        JSON.stringify({ id: i + 1, type: 2, name: `动画${i + 1}` }),
      ),
    ].join('\n') + '\n';
  await writeFile(file, source);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const run = (extra: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--dry-run',
        '--skip-invalid',
        '--request-retries',
        '3',
        '--api-url',
        `http://127.0.0.1:${address.port}`,
        ...extra,
      ],
      {
        env: { ...process.env, DATABASE_PATH: database, ADMIN_TOKEN: '', STATS_ENABLED: 'invalid' },
      },
    );
  try {
    const { stdout, stderr } = await run([]);
    assert.deepEqual(JSON.parse(stdout), {
      dryRun: true,
      parsed: 1201,
      ignored: 1,
      emptyLines: 1,
      imported: 0,
      skipped: 2,
      skippedTotal: 2,
      line: 1205,
      complete: true,
      status: 'partial',
      errorLog: null,
    });
    assert(!stderr.includes('target_ready'));
    assert(!stderr.includes('archive_checkpoint_saved'));
    const skippedLogs = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((log) => log.event === 'archive_record_skipped');
    assert.equal(skippedLogs.length, 2);
    assert(
      skippedLogs.every(
        (log) => typeof log.errorMessage === 'string' && log.errorMessage.length > 0,
      ),
    );
    const limited = await run(['--limit', '1', '--log-level', 'debug']);
    const result = JSON.parse(limited.stdout);
    assert.equal(result.parsed, 1);
    assert.equal(result.line, 5);
    assert.equal(result.complete, false);
    assert.equal(result.status, 'in_progress');
    assert.equal(JSON.parse((await run(['--limit', '1'])).stdout).line, 5);
    assert(limited.stderr.includes('archive_record_parsed'));
    assert.equal(requests, 0);
    assert.equal(existsSync(join(dir, 'untouched')), false);
    assert.equal(existsSync(`${file}.errors.jsonl`), false);
    assert.equal(await readFile(file, 'utf8'), source);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Archive dry-run 从首行统计，保留已有数据、错误文件与检查点，真实导入仍正常续跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-dry-run-state-'));
  const file = join(dir, 'subject.jsonlines');
  const database = join(dir, 'app.sqlite');
  await writeFile(
    file,
    [1, 2].map((id) => JSON.stringify({ id, type: 2, name: `动画${id}` })).join('\n') + '\n',
  );
  await writeFile(`${file}.errors.jsonl`, 'existing error log\n');
  const run = (extra: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-01-01T00:00:00Z',
        '--limit',
        '1',
        ...extra,
      ],
      {
        env: {
          ...process.env,
          DATABASE_PATH: database,
          ADMIN_TOKEN: token,
          STATS_ENABLED: 'false',
        },
      },
    );
  assert.equal(JSON.parse((await run([])).stdout).imported, 1);
  const snapshot = () => {
    const driver = new SqliteDriver(database);
    try {
      return {
        subjects: driver.db.prepare('SELECT * FROM subjects ORDER BY id').all(),
        states: driver.db.prepare('SELECT * FROM sync_state ORDER BY key').all(),
      };
    } finally {
      driver.close();
    }
  };
  const before = snapshot();
  const dry = await run(['--dry-run', '--log-level', 'debug']);
  assert.equal(JSON.parse(dry.stdout).parsed, 1);
  assert(
    dry.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .some((log) => log.event === 'archive_record_parsed' && log.subjectId === 1),
  );
  assert.deepEqual(snapshot(), before);
  assert.equal(await readFile(`${file}.errors.jsonl`, 'utf8'), 'existing error log\n');
  assert.equal(JSON.parse((await run([])).stdout).line, 2);
  assert.equal(snapshot().subjects.length, 2);
});

test('Archive dry-run 遇到无效项默认失败，其他命令拒绝 dry-run 且不产生写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-dry-run-errors-'));
  const file = join(dir, 'subject.jsonlines');
  const database = join(dir, 'never.sqlite');
  await writeFile(file, JSON.stringify({ id: 1, type: 2, name: '有效动画' }) + '\n{invalid json\n');
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, ['dist/node/cli.js', ...args], {
      env: { ...process.env, DATABASE_PATH: database, ADMIN_TOKEN: '' },
    });
  await assert.rejects(run(['sync-archive', '--file', file, '--dry-run']), (error: unknown) => {
    const { stderr, stdout } = error as { stderr: string; stdout: string };
    assert.equal(stdout, '');
    const failure = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(failure.event, 'cli_failed');
    assert.equal(failure.line, 2);
    assert.equal(failure.parsed, 1);
    assert.equal(failure.checkpointLine, null);
    assert(failure.causes[0].message.includes('第 2 行解析失败'));
    return true;
  });
  await assert.rejects(run(['migrate', '--dry-run']), (error: unknown) =>
    (error as { stderr: string }).stderr.includes('--dry-run 仅支持 sync-archive'),
  );
  assert.equal(existsSync(database), false);
  assert.equal(existsSync(`${file}.errors.jsonl`), false);
});

test('CLI 远程 Archive 导入遵守 request-delay-ms，检查点请求也限速', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-request-delay-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, await readFile('tests/fixtures/subject.jsonl', 'utf8'));
  const requests: { method: string; at: number }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 完整读取请求体。 */
    }
    requests.push({ method: request.method!, at: performance.now() });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-01-01T00:00:00Z',
        '--api-url',
        `http://127.0.0.1:${address.port}`,
        '--request-delay-ms',
        '80',
        '--log-level',
        'debug',
      ],
      { env: { ...process.env, ADMIN_TOKEN: token } },
    );
    assert.equal(JSON.parse(stdout).imported, 2);
    const logs = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert(logs.some((log) => log.event === 'cli_started'));
    assert(logs.some((log) => log.event === 'archive_resumed' && log.checkpointLine === 0));
    assert.equal(logs.filter((log) => log.event === 'archive_record_imported').length, 2);
    assert(logs.some((log) => log.event === 'archive_checkpoint_saved' && log.imported === 2));
    assert.equal(logs.filter((log) => log.event === 'api_request_completed').length, 4);
    assert.equal(logs.at(-1).event, 'cli_completed');
    assert(!stderr.includes(token));
    assert.deepEqual(
      requests.map((r) => r.method),
      ['GET', 'POST', 'POST', 'PUT'],
    );
    for (let i = 1; i < requests.length; i++)
      assert(requests[i]!.at - requests[i - 1]!.at >= 65, '请求之间应保留配置的间隔');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('CLI 慢请求持续输出进度，失败日志包含条目与检查点且不泄露令牌', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-cli-logs-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, JSON.stringify({ id: 8, type: 2, name: '失败条目' }) + '\n');
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 读取完请求后响应。 */
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value: null }));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5300));
      response.writeHead(503);
      response.end(`SERVICE_UNAVAILABLE: ${token}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          'dist/node/cli.js',
          'sync-archive',
          '--file',
          file,
          '--as-of',
          '2026-01-01T00:00:00Z',
          '--api-url',
          `http://127.0.0.1:${address.port}`,
          '--request-retries',
          '0',
        ],
        { env: { ...process.env, ADMIN_TOKEN: token } },
      ),
      (error: unknown) => {
        const { stderr, stdout, code } = error as { stderr: string; stdout: string; code: number };
        assert.equal(code, 1);
        assert.equal(stdout, '');
        assert(!stderr.includes(token));
        const logs = stderr
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line));
        assert(
          logs.some(
            (log) =>
              log.event === 'cli_progress' && log.phase === 'archive_import' && log.subjectId === 8,
          ),
        );
        const failure = logs.at(-1);
        assert.equal(failure.event, 'cli_failed');
        assert.equal(failure.line, 1);
        assert.equal(failure.subjectId, 8);
        assert.equal(failure.imported, 0);
        assert.equal(failure.checkpointLine, 0);
        assert(failure.causes.some((cause: { message: string }) => cause.message.includes('503')));
        assert(
          !logs.some(
            (log) => log.event === 'cli_completed' || log.event === 'archive_checkpoint_saved',
          ),
        );
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('CLI Archive 默认重试 3 次并恢复导入和检查点，参数控制次数且失败不跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-request-retries-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(file, JSON.stringify({ id: 8, type: 2, name: '重试条目' }) + '\n');
  let counts: Record<string, number> = {};
  let failures: Record<string, number> = { GET: 1, POST: 3, PUT: 1 };
  let status = 503;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const method = request.method!;
    counts[method] = (counts[method] ?? 0) + 1;
    if (method === 'POST') bodies.push(body);
    const failed = counts[method]! <= (failures[method] ?? 0);
    response.writeHead(failed ? status : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failed ? { error: 'temporary failure' } : { value: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const run = (extra: string[] = []) =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-01-01T00:00:00Z',
        '--api-url',
        `http://127.0.0.1:${address.port}`,
        '--skip-invalid',
        ...extra,
      ],
      { env: { ...process.env, ADMIN_TOKEN: token } },
    );
  try {
    const { stdout, stderr } = await run();
    assert.equal(JSON.parse(stdout).imported, 1);
    assert.deepEqual(counts, { GET: 2, POST: 4, PUT: 2 });
    assert.equal(new Set(bodies).size, 1, '所有重试应重放相同的导入正文');
    const logs = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert(logs.some((log) => log.event === 'target_ready' && log.requestRetries === 3));
    assert.equal(logs.filter((log) => log.event === 'api_request_retry').length, 5);
    assert(!logs.some((log) => log.event === 'api_request_failed'));
    assert.equal(logs.at(-1).event, 'cli_completed');
    assert(!stderr.includes(token));

    for (const scenario of [
      { extra: ['--request-retries', '1'], attempts: 2, status: 503 },
      { extra: ['--request-retries', '0'], attempts: 1, status: 503 },
      { extra: [], attempts: 1, status: 401 },
    ]) {
      counts = {};
      failures = { POST: Infinity };
      status = scenario.status;
      await assert.rejects(run(scenario.extra), (error: unknown) => {
        const failure = error as { stdout: string; stderr: string; code: number };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, '');
        const failedLogs = failure.stderr
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line));
        assert.equal(
          failedLogs.filter((log) => log.event === 'api_request_retry').length,
          scenario.attempts - 1,
        );
        assert.equal(failedLogs.at(-1).imported, 0);
        assert.equal(failedLogs.at(-1).skipped, 0);
        assert.equal(failedLogs.at(-1).checkpointLine, 0);
        assert.equal(failedLogs.at(-1).subjectId, 8);
        assert(failure.stderr.includes(`管理 API 返回 ${scenario.status}`));
        assert(!failure.stderr.includes('archive_checkpoint_saved'));
        return true;
      });
      assert.deepEqual(counts, { GET: 1, POST: scenario.attempts });
      assert.equal(existsSync(`${file}.errors.jsonl`), false);
    }
    for (const invalid of ['-1', '0.5', 'NaN', 'Infinity', '9007199254740992']) {
      counts = {};
      await assert.rejects(run(['--request-retries', invalid]));
      assert.deepEqual(counts, {}, '无效参数必须在发送请求前拒绝');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function fixture(id: number, name: string, aliases = ['共同别名'], year = 2023): ImportRecord {
  return {
    subject: {
      id,
      name,
      nameCn: `中文${id}`,
      airDate: `${year}-01-01`,
      platform: 'TV',
      metadataAt: asOf,
      cachedAt: asOf,
      pinned: false,
    },
    aliases,
    rating: {
      subjectId: id,
      score: 8.1,
      votes: 10,
      rank: 20,
      source: 'archive',
      dataAsOf: asOf,
      fetchedAt: asOf,
    },
  };
}

async function runtime(
  kind: 'node' | 'worker',
  enabled: boolean,
  bangumi?: {
    userAgent: string;
    accessToken: string;
    fetcher: typeof fetch;
    calendarSyncEnabled?: boolean;
    calendarPlatformBatchSize?: number;
  },
) {
  const logs: string[] = [];
  if (kind === 'node') {
    const driver = new SqliteDriver(':memory:');
    driver.migrate();
    const source = bangumi
      ? new BangumiClient(bangumi.userAgent, {
          accessToken: bangumi.accessToken,
          fetcher: bangumi.fetcher,
        })
      : undefined;
    const app = createApp(
      new SqlRepository(driver),
      readConfig({
        ADMIN_TOKEN: token,
        STATS_ENABLED: String(enabled),
        CALENDAR_PLATFORM_BATCH_SIZE: bangumi?.calendarPlatformBatchSize ?? 10,
        BANGUMI_USER_AGENT: bangumi?.userAgent ?? '',
        BANGUMI_ACCESS_TOKEN: bangumi?.accessToken ?? '',
      }),
      {
        subjectSource: source,
        calendarSource: source,
        writeErrorLog: (line) => logs.push(line),
      },
    );
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return {
      logs,
      baseUrl: `http://127.0.0.1:${address.port}`,
      fetch: (path: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}${path}`, init),
      scheduled: undefined,
      sql: async (sql: string) => driver.query({ sql, params: [] }),
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        driver.close();
      },
    };
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'api',
      modules: true,
      scriptPath: 'dist/worker.js',
      compatibilityDate: '2026-10-20',
      d1Databases: ['DB'],
      handleStructuredLogs: (log) => {
        logs.push(log.message);
      },
      bindings: {
        ADMIN_TOKEN: token,
        STATS_ENABLED: String(enabled),
        ...(bangumi
          ? {
              BANGUMI_USER_AGENT: bangumi.userAgent,
              BANGUMI_ACCESS_TOKEN: bangumi.accessToken,
              CALENDAR_SYNC_ENABLED: String(bangumi.calendarSyncEnabled ?? false),
              CALENDAR_PLATFORM_BATCH_SIZE: String(bangumi.calendarPlatformBatchSize ?? 10),
            }
          : {}),
      },
      ...(bangumi
        ? {
            outboundService: async (request) => {
              const response = await bangumi.fetcher(request.url, {
                method: request.method,
                headers: Object.fromEntries(request.headers),
              });
              return new MiniflareResponse(await response.arrayBuffer(), {
                status: response.status,
                headers: Object.fromEntries(response.headers),
              });
            },
          }
        : {}),
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const statement of migration
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
  return {
    logs,
    baseUrl: (await mf.ready).origin,
    fetch: async (path: string, init?: RequestInit) =>
      (await mf.dispatchFetch(
        `http://localhost${path}`,
        init as Parameters<typeof mf.dispatchFetch>[1],
      )) as unknown as Response,
    scheduled: async () => (await mf.getWorker()).scheduled({ cron: '0 20 * * *' }),
    sql: async (sql: string) => (await db.prepare(sql).all()).results,
    close: () => mf.dispose(),
  };
}

for (const kind of ['node', 'worker'] as const)
  test(`${kind}: 数据库故障记录原因链和关联 ID，不泄露请求内容或凭证`, async () => {
    const bangumiSecret = 'server-error-test-bangumi-token';
    const target = await runtime(kind, false, {
      userAgent: 'tester/errors',
      accessToken: bangumiSecret,
      fetcher: (async () => Response.json({})) as unknown as typeof fetch,
    });
    try {
      await target.sql(
        `CREATE TRIGGER reject_import BEFORE INSERT ON subjects BEGIN SELECT RAISE(ABORT, 'storage failure ${bangumiSecret}; params: private-sql-parameter'); END`,
      );
      const response = await target.fetch('/api/v1/admin/import?private-query-value=1', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Request-ID': 'untrusted-private-header',
          'CF-Ray': '0123456789abcdef-HKG',
        },
        body: JSON.stringify(fixture(8, 'private-request-body')),
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as any;
      assert.deepEqual(body, {
        error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后重试' },
      });
      // workerd 日志通过独立通道传回，允许其在响应之后到达。
      for (let i = 0; i < 20 && !target.logs.some((line) => line.includes('request_failed')); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const entry = target.logs
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((entry) => entry.event === 'request_failed');
      assert(entry, target.logs.join('\n'));
      assert.equal(entry.method, 'POST');
      assert.equal(entry.path, '/api/v1/admin/import');
      assert.equal(entry.status, 503);
      assert.equal(entry.requestId, response.headers.get('X-Request-ID'));
      assert(
        entry.causes.some((cause: { message: string }) =>
          cause.message.includes('storage failure'),
        ),
      );
      const output = JSON.stringify(entry);
      for (const secret of [
        token,
        bangumiSecret,
        'private-query-value',
        'private-request-body',
        'private-sql-parameter',
        'untrusted-private-header',
      ])
        assert(!output.includes(secret));
      assert.equal((await target.sql('SELECT * FROM subjects')).length, 0);
    } finally {
      await target.close();
    }
  });

test('Worker 初始化失败输出配置原因及关联 ID，响应不暴露内部异常', async () => {
  const logs: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'configuration-error',
      modules: true,
      scriptPath: 'dist/worker.js',
      compatibilityDate: '2026-10-20',
      d1Databases: ['DB'],
      bindings: {
        ADMIN_TOKEN: token,
        BANGUMI_ACCESS_TOKEN: 'worker-private-config-token',
        STATS_ENABLED: 'invalid',
      },
      handleStructuredLogs: (log) => {
        logs.push(log.message);
      },
    }),
  );
  try {
    const response = await mf.dispatchFetch('http://localhost/health/ready?private-query=1');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: 'CONFIGURATION_ERROR', message: '服务配置无效' },
    });
    for (
      let i = 0;
      i < 20 && !logs.some((line) => line.includes('worker_configuration_error'));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const entry = logs
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'worker_configuration_error');
    assert(entry, logs.join('\n'));
    assert.equal(entry.requestId, response.headers.get('X-Request-ID'));
    assert.equal(entry.causes[0].name, 'ZodError');
    assert(!JSON.stringify(entry).includes('private-query'));
    assert(!JSON.stringify(entry).includes('worker-private-config-token'));
  } finally {
    await mf.dispose();
  }
});

test('Worker 定时同步失败保留上游原因，并向平台报告失败', async () => {
  const target = await runtime('worker', false, {
    userAgent: 'tester/errors',
    accessToken: 'cron-private-access-token',
    calendarSyncEnabled: true,
    fetcher: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
  });
  try {
    assert(target.scheduled);
    const result = await target.scheduled();
    assert.equal(result.outcome, 'exception');
    for (
      let i = 0;
      i < 20 && !target.logs.some((line) => line.includes('calendar_sync_failed'));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const entries = target.logs
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'calendar_sync_failed');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].trigger, 'scheduled');
    assert(
      entries[0].causes.some((cause: { message: string }) => cause.message.includes('HTTP 401')),
    );
    assert(!JSON.stringify(entries).includes('cron-private-access-token'));
  } finally {
    await target.close();
  }
});

for (const kind of ['node', 'worker'] as const)
  test(`${kind}: Archive 多别名导入兼容 D1，保留手动别名并支持幂等重放`, async () => {
    const target = await runtime(kind, false);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = (record: ImportRecord) =>
      target.fetch('/api/v1/admin/import', {
        method: 'POST',
        headers,
        body: JSON.stringify(record),
      });
    try {
      // 实际故障条目去重后有 8 个名称；旧实现的 UNION ALL 超出 D1 限制。
      const first = fixture(
        8,
        '原名',
        Array.from({ length: 6 }, (_, i) => `别名${i}`),
      );
      const response = await send(first);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        (await target.sql('SELECT * FROM subject_aliases WHERE subject_id=8')).length,
        8,
      );
      const manual = await target.fetch('/api/v1/admin/subjects/8/aliases', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '人工别名' }),
      });
      assert.equal(manual.status, 200);
      // 覆盖接口允许的最大别名数，且两个主名称与 aliases 去重。
      const updated = fixture(8, '新名称', [
        '新名称',
        '中文8',
        ...Array.from({ length: 198 }, (_, i) => `新别名${i}`),
      ]);
      updated.subject.metadataAt++;
      const imported = await send(updated);
      assert.equal(imported.status, 200, await imported.clone().text());
      const aliases = await target.sql(
        'SELECT name,source FROM subject_aliases WHERE subject_id=8 ORDER BY name,source',
      );
      assert.equal(aliases.length, 201);
      assert.equal(aliases.filter((a) => a.source === 'manual' && a.name === '人工别名').length, 1);
      assert.equal((await send(updated)).status, 200);
      assert.equal((await send(first)).status, 200);
      assert.deepEqual(
        await target.sql(
          'SELECT name,source FROM subject_aliases WHERE subject_id=8 ORDER BY name,source',
        ),
        aliases,
      );
      assert.equal((await target.sql('SELECT name FROM subjects WHERE id=8'))[0]!.name, '新名称');
    } finally {
      await target.close();
    }
  });

for (const kind of ['node', 'worker'] as const) {
  for (const enabled of [false, true])
    test(`${kind}: 真实 HTTP/存储契约，统计 ${enabled}`, async () => {
      const target = await runtime(kind, enabled);
      const request = (path: string, method = 'GET', body?: unknown, auth = true) =>
        target.fetch(path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const json = async (path: string, method = 'GET', body?: unknown) => {
        const response = await request(path, method, body);
        assert.equal(response.status, 200, await response.clone().text());
        return (await response.json()) as any;
      };
      const batch = (items: unknown[]) => json('/api/v1/ratings/batch', 'POST', { items });
      try {
        assert.equal((await json('/health/ready')).statisticsEnabled, enabled);
        const spec = await json('/openapi.json');
        assert.equal(spec.openapi, '3.1.0');
        assert.equal(
          spec.paths['/api/v1/ratings/batch'].post.requestBody.content['application/json'].schema
            .properties.items.maxItems,
          20,
        );
        assert.equal(
          (await request('/api/v1/admin/import', 'POST', fixture(100, 'Test'), false)).status,
          401,
        );
        const unavailableSync = await request('/api/v1/admin/subjects/777/sync', 'POST');
        assert.equal(unavailableSync.status, 503);
        assert.equal(((await unavailableSync.json()) as any).error.code, 'BANGUMI_SYNC_DISABLED');
        assert.equal((await request('/api/v1/ratings/batch', 'POST', { items: [] })).status, 400);
        for (const record of [
          fixture(100, 'Test', ['共同别名', '独有别名']),
          fixture(101, 'Movie', ['共同别名'], 2024),
          fixture(102, '86', ['数字作品']),
        ])
          await json('/api/v1/admin/import', 'POST', record);
        const ambiguous = (await batch([{ inputId: 'a', names: ['共同别名'] }])).results[0];
        assert.equal(ambiguous.status, 'ambiguous');
        assert.equal((await target.sql('SELECT * FROM subject_usage')).length, 0);
        assert.equal(
          (await batch([{ inputId: 'a', names: ['共同别名'], year: 2024 }])).results[0].subject.id,
          101,
        );
        assert.equal((await batch([{ inputId: 'a', names: ['86'] }])).results[0].subject.id, 102);
        assert.equal(
          (await batch([{ inputId: 'a', names: ['共同别名', '独有别名'] }])).results[0].subject.id,
          100,
        );
        assert.equal(
          (await batch([{ inputId: 'a', names: ['Test', 'Movie'] }])).results[0].status,
          'ambiguous',
        );
        const alias = (
          await json('/api/v1/admin/subjects/100/aliases', 'POST', { name: '  我的别名  ' })
        ).alias;
        const repeated = (
          await json('/api/v1/admin/subjects/100/aliases', 'POST', { name: '我的别名' })
        ).alias;
        assert.equal(alias.id, repeated.id);
        const conflict = await json('/api/v1/admin/subjects/101/aliases', 'POST', {
          name: '我的别名',
        });
        assert.deepEqual(conflict.conflictingSubjectIds, [100]);
        assert.equal(
          (await batch([{ inputId: 'a', names: ['我的别名'] }])).results[0].status,
          'ambiguous',
        );
        await json(`/api/v1/admin/aliases/${conflict.alias.id}`, 'DELETE');
        const fresh = fixture(100, 'Updated');
        fresh.subject.metadataAt += 10000;
        fresh.rating!.dataAsOf += 10000;
        fresh.rating!.score = 9;
        await json('/api/v1/admin/import', 'POST', fresh);
        await json('/api/v1/admin/import', 'POST', fixture(100, 'Stale'));
        const afterSync = (await batch([{ inputId: 'a', names: ['我的别名'] }])).results[0];
        assert.equal(afterSync.subject.name, 'Updated');
        assert.equal(afterSync.rating.score, 9);
        assert.equal(afterSync.stale, true);
        assert.equal(
          (await batch([{ inputId: 'a', names: ['独有别名'] }])).results[0].status,
          'not_found',
        );
        const before = await target.sql(
          'SELECT total_hits FROM subject_usage WHERE subject_id=100',
        );
        const duplicated = await batch([
          { inputId: 'one', subjectId: 100 },
          { inputId: 'two', names: ['我的别名'] },
          { inputId: 'three', names: ['missing'] },
        ]);
        batchResponseSchema.parse(duplicated);
        assert.deepEqual(
          duplicated.results.map((r: any) => r.inputId),
          ['one', 'two', 'three'],
        );
        const after = await target.sql('SELECT total_hits FROM subject_usage WHERE subject_id=100');
        if (enabled)
          assert.equal(Number(after[0]!.total_hits), Number(before[0]?.total_hits ?? 0) + 1);
        else {
          assert.deepEqual(after, []);
          assert.deepEqual(await target.sql('SELECT * FROM subject_usage_daily'), []);
        }
        const official = (await json('/api/v1/subjects/100/aliases')).aliases.find(
          (a: any) => a.source === 'bangumi',
        );
        assert.equal((await request(`/api/v1/admin/aliases/${official.id}`, 'DELETE')).status, 404);
        await json(`/api/v1/admin/aliases/${alias.id}`, 'PATCH', { name: "SQL ' ; -- 测试" });
        assert.equal(
          (await batch([{ inputId: 'a', names: ["SQL ' ; -- 测试"] }])).results[0].subject.id,
          100,
        );
        const backup = await json('/api/v1/admin/export');
        const restored = await runtime(kind === 'node' ? 'worker' : 'node', false);
        try {
          for (const record of backup.records) {
            const response = await restored.fetch('/api/v1/admin/restore', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(record),
            });
            assert.equal(response.status, 200, await response.text());
          }
          const roundtrip = await restored.fetch('/api/v1/admin/export', {
            headers: { Authorization: `Bearer ${token}` },
          });
          assert.deepEqual(await roundtrip.json(), backup);
        } finally {
          await restored.close();
        }
        assert.equal((await json('/api/v1/admin/retention')).actionable, false);
        await target.sql(
          "INSERT INTO subject_usage_daily(subject_id,day,hits) VALUES(100,'2000-01-01',2)",
        );
        assert.equal((await json('/api/v1/admin/stats/prune', 'POST', { days: 90 })).deleted, 1);
        // 统计写入失败仍返回正常评分，而且事务不留下半份 daily 记录。
        await target.sql(
          "CREATE TRIGGER reject_usage BEFORE INSERT ON subject_usage BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        );
        assert.equal(
          (await batch([{ inputId: 'a', subjectId: 100 }])).results[0].status,
          'matched',
        );
      } finally {
        await target.close();
      }
    });
}

test('Node CLI: Archive 断点、备份恢复与流式解压', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-test-'));
  const source = await readFile('tests/fixtures/subject.jsonl', 'utf8');
  const zip = join(dir, 'archive.zip');
  const extracted = join(dir, 'subject.jsonlines');
  await writeFile(
    zip,
    zipSync({ 'subject.jsonlines': strToU8(source), 'ignored.txt': strToU8('ignore') }),
  );
  await extractSubjects(zip, extracted);
  assert.equal(await readFile(extracted, 'utf8'), source);
  const run = (args: string[], database = join(dir, 'source.sqlite')) =>
    promisify(execFile)(process.execPath, ['dist/node/cli.js', ...args], {
      env: { ...process.env, DATABASE_PATH: database, ADMIN_TOKEN: token, STATS_ENABLED: 'false' },
    });
  const args = [
    'sync-archive',
    '--file',
    extracted,
    '--as-of',
    '2026-01-01T00:00:00Z',
    '--limit',
    '1',
  ];
  assert.equal(JSON.parse((await run(args)).stdout).imported, 1);
  assert.equal(JSON.parse((await run(args)).stdout).imported, 1);
  const silent = await run([...args, '--log-level', 'silent']);
  assert.equal(JSON.parse(silent.stdout).imported, 0);
  assert(!silent.stderr.split('\n').some((line) => line.startsWith('{')));
  await run(['alias-add', '--id', '100', '--name', '人工别名']);
  const backup = join(dir, 'backup.jsonl');
  await run(['export', '--out', backup]);
  const target = join(dir, 'target.sqlite');
  assert.equal(JSON.parse((await run(['import', '--file', backup], target)).stdout).restored, 2);
  const backup2 = join(dir, 'backup2.jsonl');
  await run(['export', '--out', backup2], target);
  assert.equal(await readFile(backup2, 'utf8'), await readFile(backup, 'utf8'));
});

test('Node 打包入口能启动、自动迁移并返回 JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-entry-'));
  const child = spawn(process.execPath, ['dist/node/node.js'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_PATH: join(dir, 'app.sqlite'),
      STATS_ENABLED: 'false',
      ADMIN_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Node 启动超时 ${stderr}`)), 10000);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        const line = stdout.split('\n').find((s) => s.includes('"listening"'));
        if (line) {
          clearTimeout(timer);
          resolve((JSON.parse(line) as { port: number }).port);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Node 提前退出 ${stderr}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      schemaVersion: 1,
      statisticsEnabled: false,
    });
  } finally {
    child.kill('SIGTERM');
    await stopped;
  }
});

test('Archive 可跳过损坏行，记录错误并在断点续跑后保留 partial 状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-invalid-'));
  const file = join(dir, 'subject.jsonlines');
  const database = join(dir, 'app.sqlite');
  const valid = (id: number) => JSON.stringify({ id, type: 2, name: `动画${id}` });
  // 与实际第 2002 行一致：infobox 结束前多出独立反斜杠。
  const broken = JSON.stringify({
    id: 2174,
    type: 2,
    name: '损坏条目',
    infobox: '{{Infobox animanga\n|别名=测试\n\\\n}}',
  });
  await writeFile(file, [valid(1), broken, '{invalid json', valid(2), valid(3)].join('\n') + '\n');
  const run = (extra: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-01-01T00:00:00Z',
        ...extra,
      ],
      {
        env: {
          ...process.env,
          DATABASE_PATH: database,
          ADMIN_TOKEN: token,
          STATS_ENABLED: 'false',
        },
      },
    );
  await assert.rejects(run([]), (error: unknown) =>
    String((error as { stderr: string }).stderr).includes('第 2 行导入失败'),
  );
  const first = JSON.parse((await run(['--skip-invalid', '--limit', '2'])).stdout);
  assert.equal(first.imported, 2);
  assert.equal(first.skipped, 2);
  assert.equal(first.skippedTotal, 2);
  assert.equal(first.line, 4);
  assert.equal(first.complete, false);
  const errors = (await readFile(`${file}.errors.jsonl`, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    errors.map((e) => e.line),
    [2, 3],
  );
  assert.equal(errors[0].subjectId, 2174);
  assert.equal(errors[1].subjectId, null);
  assert(errors.every((e) => typeof e.message === 'string' && e.message.length > 0));
  const resumed = JSON.parse((await run(['--skip-invalid'])).stdout);
  assert.equal(resumed.imported, 1);
  assert.equal(resumed.skipped, 0);
  assert.equal(resumed.skippedTotal, 2);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.status, 'partial');
  assert.equal((await readFile(`${file}.errors.jsonl`, 'utf8')).trim().split('\n').length, 2);
  const driver = new SqliteDriver(database);
  try {
    assert.deepEqual(
      driver.db
        .prepare('SELECT id FROM subjects ORDER BY id')
        .all()
        .map((r) => r.id),
      [1, 2, 3],
    );
  } finally {
    driver.close();
  }
});

test('Archive 跳过模式仍在数据库写入失败时停止，且不越过失败行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-write-error-'));
  const file = join(dir, 'subject.jsonlines');
  const database = join(dir, 'app.sqlite');
  await writeFile(file, JSON.stringify({ id: 1, type: 2, name: '有效条目' }) + '\n');
  const driver = new SqliteDriver(database);
  driver.migrate();
  driver.db.exec(
    "CREATE TRIGGER reject_import BEFORE INSERT ON subjects BEGIN SELECT RAISE(ABORT, 'storage failure'); END",
  );
  driver.close();
  const run = () =>
    promisify(execFile)(
      process.execPath,
      [
        'dist/node/cli.js',
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-01-01T00:00:00Z',
        '--skip-invalid',
      ],
      {
        env: {
          ...process.env,
          DATABASE_PATH: database,
          ADMIN_TOKEN: token,
          STATS_ENABLED: 'false',
        },
      },
    );
  await assert.rejects(run(), (error: unknown) =>
    String((error as { stderr: string }).stderr).includes('第 1 行导入失败'),
  );
  const check = new SqliteDriver(database);
  try {
    assert.equal(check.db.prepare('SELECT COUNT(*) AS count FROM sync_state').get()!.count, 0);
    check.db.exec('DROP TRIGGER reject_import');
  } finally {
    check.close();
  }
  assert.equal(JSON.parse((await run()).stdout).imported, 1);
});

for (const kind of ['node', 'worker'] as const)
  test(`${kind}: 远程单条同步使用服务端 Bangumi Secret，本地 CLI 只需管理令牌`, async () => {
    const requests: { url: string; headers: Headers }[] = [];
    let rejected = false;
    const target = await runtime(kind, false, {
      userAgent: 'server/bangumi-rating-query',
      accessToken: 'server-bangumi-secret',
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return rejected
          ? new Response('', { status: 401 })
          : Response.json({
              id: 777,
              type: 2,
              name: '服务端同步条目',
              infobox: [{ key: '别名', value: '服务端别名' }],
              rating: { score: 8, total: 10, rank: 3 },
            });
      }) as typeof fetch,
    });
    try {
      const denied = await target.fetch('/api/v1/admin/subjects/777/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer server-bangumi-secret' },
      });
      assert.equal(denied.status, 401);
      assert.equal(requests.length, 0);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['dist/node/cli.js', 'sync-subject', '--id', '777', '--api-url', target.baseUrl],
        {
          env: {
            ...process.env,
            ADMIN_TOKEN: token,
            BANGUMI_USER_AGENT: '',
            BANGUMI_ACCESS_TOKEN: 'unused-local-token',
          },
        },
      );
      assert.deepEqual(JSON.parse(stdout), { imported: 777 });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.url, 'https://api.bgm.tv/v0/subjects/777');
      assert.equal(requests[0]!.headers.get('Authorization'), 'Bearer server-bangumi-secret');
      assert.equal(requests[0]!.headers.get('User-Agent'), 'server/bangumi-rating-query');
      const response = await target.fetch('/api/v1/subjects/777');
      const text = await response.text();
      assert.equal(JSON.parse(text).rating.score, 8);
      assert(!text.includes('server-bangumi-secret'));
      assert.equal((await target.sql('SELECT * FROM subject_usage')).length, 0);
      const backup = await target.fetch('/api/v1/admin/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(!(await backup.text()).includes('server-bangumi-secret'));
      rejected = true;
      const failed = await target.fetch('/api/v1/admin/subjects/777/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(failed.status, 503);
      const failureText = await failed.text();
      assert.equal(JSON.parse(failureText).error.code, 'BANGUMI_API_ERROR');
      assert(!failureText.includes('server-bangumi-secret'));
    } finally {
      await target.close();
    }
  });

for (const kind of ['node', 'worker'] as const)
  test(`${kind}: calendar 批量导入保留详情、排名与别名，支持 CLI 和定时触发`, async () => {
    const requests: { url: string; headers: Headers }[] = [];
    let phase: 'normal' | 'empty' | 'malformed' | 'storage' = 'normal';
    const target = await runtime(kind, false, {
      userAgent: 'server/calendar-sync',
      accessToken: 'calendar-server-secret',
      calendarSyncEnabled: true,
      fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers) });
        if (String(url).includes('/v0/subjects/')) {
          const id = Number(String(url).split('/').pop());
          return Response.json({ id, type: 2, platform: id === 200 ? 'TV' : 'WEB' });
        }
        if (phase === 'malformed') return Response.json({ unexpected: true });
        if (phase === 'empty') return Response.json([{ items: [] }]);
        const items = [
          {
            id: 100,
            type: 2,
            name: '日历名称',
            name_cn: '日历中文名',
            air_date: '2026-10-01',
            rating: { score: 9, total: 20 },
          },
          { id: 200, type: 2, name: '新动画', name_cn: '新动画中文' },
          { id: 201, type: 2, name: '暂无评分', rating: { score: 0, total: 0 } },
        ];
        return Response.json([
          { items },
          {
            items: [
              items[0],
              ...(phase === 'storage' ? [{ id: 999, type: 2, name: '写入失败' }] : []),
            ],
          },
        ]);
      }) as typeof fetch,
    });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const sync = () =>
      target.fetch('/api/v1/admin/calendar/sync', { method: 'POST', headers: auth });
    try {
      assert.equal(
        (await target.fetch('/api/v1/admin/calendar/sync', { method: 'POST' })).status,
        401,
      );
      assert.equal(requests.length, 0);
      await target.fetch('/api/v1/admin/import', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(fixture(100, '完整详情', ['完整别名'])),
      });
      await target.fetch('/api/v1/admin/subjects/100/aliases', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: '人工别名' }),
      });
      // 模拟旧版 calendar 同步已写入的空作品形式，要求重新同步即可补齐。
      await target.sql(
        "INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(200,'旧日历条目',0,1)",
      );
      const response = await sync();
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as any;
      assert.equal(result.imported, 3);
      assert.equal(requests.length, 3);
      assert.equal(requests[0]!.url, 'https://api.bgm.tv/calendar');
      assert.equal(requests[0]!.headers.get('Authorization'), 'Bearer calendar-server-secret');
      assert.equal(requests[0]!.headers.get('User-Agent'), 'server/calendar-sync');
      assert(
        requests.every(
          (request) => request.headers.get('Authorization') === 'Bearer calendar-server-secret',
        ),
      );
      assert.equal(result.platformsUpdated, 2);
      assert.equal(result.platformsRemaining, 0);
      assert.equal(result.status, 'complete');
      assert.deepEqual(
        (await target.sql('SELECT platform FROM subjects WHERE id IN(200,201) ORDER BY id')).map(
          (r) => r.platform,
        ),
        ['TV', 'WEB'],
      );
      assert.equal(
        (await target.sql('SELECT cached_at FROM subjects WHERE id=200'))[0]!.cached_at,
        1,
      );
      const existing = await target.sql(
        'SELECT s.name,s.air_date,s.platform,s.metadata_at,r.score,r.votes,r.rank FROM subjects s JOIN ratings_current r ON r.subject_id=s.id WHERE s.id=100',
      );
      assert.deepEqual(
        { ...existing[0] },
        {
          name: '完整详情',
          air_date: '2023-01-01',
          platform: 'TV',
          metadata_at: asOf,
          score: 9,
          votes: 20,
          rank: 20,
        },
      );
      const names = (await target.sql('SELECT name FROM subject_aliases WHERE subject_id=100')).map(
        (r) => r.name,
      );
      assert(
        names.includes('人工别名') && names.includes('完整别名') && names.includes('日历名称'),
      );
      assert.equal(
        (await target.sql('SELECT * FROM ratings_current WHERE subject_id=200')).length,
        0,
      );
      assert.equal(
        (await target.sql('SELECT score FROM ratings_current WHERE subject_id=201'))[0]!.score,
        null,
      );
      assert.equal(
        (await target.sql('SELECT metadata_at FROM subjects WHERE id=200'))[0]!.metadata_at,
        0,
      );
      assert.equal((await target.sql('SELECT * FROM subject_usage')).length, 0);
      const aliasCount = (await target.sql('SELECT COUNT(*) AS count FROM subject_aliases'))[0]!
        .count;
      const run = await promisify(execFile)(
        process.execPath,
        ['dist/node/cli.js', 'sync-calendar', '--api-url', target.baseUrl],
        {
          env: {
            ...process.env,
            ADMIN_TOKEN: token,
            BANGUMI_USER_AGENT: '',
            BANGUMI_ACCESS_TOKEN: '',
          },
        },
      );
      assert.equal(JSON.parse(run.stdout).imported, 3);
      assert.equal(
        (await target.sql('SELECT COUNT(*) AS count FROM subject_aliases'))[0]!.count,
        aliasCount,
      );
      if (kind === 'worker') {
        assert(target.scheduled);
        await target.scheduled();
        assert.equal(requests.length, 5);
      }
      phase = 'malformed';
      const state = await target.sql("SELECT value FROM sync_state WHERE key='calendar:last_sync'");
      assert.equal((await sync()).status, 503);
      assert.deepEqual(
        await target.sql("SELECT value FROM sync_state WHERE key='calendar:last_sync'"),
        state,
      );
      phase = 'storage';
      await target.sql(
        "CREATE TRIGGER reject_calendar BEFORE INSERT ON subjects WHEN NEW.id=999 BEGIN SELECT RAISE(ABORT, 'test'); END",
      );
      assert.equal((await sync()).status, 503);
      assert.equal((await target.sql('SELECT * FROM subjects WHERE id=999')).length, 0);
      assert.deepEqual(
        await target.sql("SELECT value FROM sync_state WHERE key='calendar:last_sync'"),
        state,
      );
      phase = 'empty';
      const empty = await sync();
      assert.equal(((await empty.json()) as any).imported, 0);
      assert.equal((await target.sql('SELECT COUNT(*) AS count FROM subjects'))[0]!.count, 3);
      // 后续完整导入仍能补全日历创建的部分元数据，即使快照时间早于本次日历获取时间。
      await target.fetch('/api/v1/admin/import', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(fixture(200, '补全详情', ['完整信息'])),
      });
      assert.equal(
        (await target.sql('SELECT name,platform FROM subjects WHERE id=200'))[0]!.platform,
        'TV',
      );
    } finally {
      await target.close();
    }
  });

test('Worker 日历定时开关关闭时不访问上游', async () => {
  let calls = 0;
  const target = await runtime('worker', false, {
    userAgent: 'server/calendar',
    accessToken: 'secret',
    calendarSyncEnabled: false,
    fetcher: (async () => {
      calls++;
      return Response.json([]);
    }) as unknown as typeof fetch,
  });
  try {
    assert(target.scheduled);
    await target.scheduled();
    assert.equal(calls, 0);
    assert.equal((await target.sql('SELECT * FROM subjects')).length, 0);
  } finally {
    await target.close();
  }
});

for (const kind of ['node', 'worker'] as const)
  test(`${kind}: platform 补全遵守批次预算，CLI 可连续处理剩余条目`, async () => {
    const urls: string[] = [];
    const target = await runtime(kind, false, {
      userAgent: 'server/platform',
      accessToken: 'platform-secret',
      calendarPlatformBatchSize: 3,
      fetcher: (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/calendar'))
          return Response.json([
            {
              items: Array.from({ length: 12 }, (_, i) => ({
                id: i + 1,
                type: 2,
                name: `动画${i + 1}`,
              })),
            },
          ]);
        return Response.json({ id: Number(url.split('/').pop()), type: 2, platform: 'WEB' });
      }) as typeof fetch,
    });
    try {
      const first = await target.fetch('/api/v1/admin/calendar/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(first.status, 200, await first.clone().text());
      const result = (await first.json()) as any;
      assert.equal(result.platformsUpdated, 3);
      assert.equal(result.platformsRemaining, 9);
      assert.equal(result.status, 'partial');
      assert.equal(urls.length, 4);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['dist/node/cli.js', 'sync-calendar', '--complete-platforms', '--api-url', target.baseUrl],
        {
          env: {
            ...process.env,
            ADMIN_TOKEN: token,
            BANGUMI_USER_AGENT: '',
            BANGUMI_ACCESS_TOKEN: '',
          },
        },
      );
      const completed = JSON.parse(stdout);
      assert.equal(completed.platformsUpdated, 9);
      assert.equal(completed.platformsRemaining, 0);
      assert.equal(completed.rounds, 3);
      assert.equal(completed.status, 'complete');
      assert.equal(urls.length, 16);
      assert.equal(
        (await target.sql("SELECT COUNT(*) AS count FROM subjects WHERE platform='WEB'"))[0]!.count,
        12,
      );
    } finally {
      await target.close();
    }
  });
