import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import { serve } from '@hono/node-server';
import { zipSync, strToU8 } from 'fflate';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';
import { SqlRepository } from '../src/adapters/storage/repository.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/adapters/storage/schema.ts';
import { createApp } from '../src/http/app.ts';
import { readConfig } from '../src/config.ts';
import { extractSubjects } from '../src/cli/archive.ts';
import type { ImportRecord } from '../src/core/models.ts';
import { batchResponseSchema } from '../src/http/openapi.ts';
import { BangumiClient } from '../src/adapters/bangumi/client.ts';
import { QueryService } from '../src/core/query-service.ts';
import { restoreBackup } from '../src/cli/restore-backup.ts';
import { remoteTarget } from '../src/cli/remote-target.ts';
import { createCliLogger } from '../src/cli/logger.ts';
import { backupFixture } from './helpers/backup.ts';
import { parseBackupRecord } from '../src/core/backup.ts';
import { normalizeName } from '../src/core/matching.ts';
import { postgresTestDatabase } from './helpers/postgres.ts';
import { assertResponse, document as openApiDocument } from './helpers/openapi.ts';
import './postgres.ts';
import './migrations.ts';
import './cli-ui.ts';
import './backup-recovery.ts';
import './openapi.ts';

const token = 'integration-test-token-with-32-characters';
const migration = MIGRATIONS.map(({ file }) => readFileSync(`migrations/${file}`, 'utf8')).join(
  '\n',
);
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
        '--checkpoint-interval',
        '1',
        '--api-url',
        `http://127.0.0.1:${address.port}`,
        ...extra,
      ],
      {
        env: {
          ...process.env,
          DATABASE_DRIVER: 'sqlite',
          DATABASE_PATH: database,
          ADMIN_TOKEN: '',
          STATS_ENABLED: 'invalid',
        },
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
          DATABASE_DRIVER: 'sqlite',
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
      env: { ...process.env, DATABASE_DRIVER: 'sqlite', DATABASE_PATH: database, ADMIN_TOKEN: '' },
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
  await assert.rejects(run(['migrate', '--checkpoint-interval', '20']), (error: unknown) =>
    (error as { stderr: string }).stderr.includes('--checkpoint-interval 仅支持 sync-archive'),
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

test('CLI Archive 检查点默认间隔 20，可配置并沿用原检查点，批次结束只保存一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-checkpoint-interval-'));
  const file = join(dir, 'subject.jsonlines');
  await writeFile(
    file,
    Array.from({ length: 45 }, (_, i) =>
      JSON.stringify({ id: i + 1, type: (i + 1) % 2 ? 4 : 2, name: `条目${i + 1}` }),
    ).join('\n') + '\n',
  );
  let state: string | null = null;
  let failId: number | undefined;
  let requests = 0;
  const saved: { line: number; complete?: boolean }[] = [];
  const imported: number[] = [];
  const keys = new Set<string>();
  const server = createServer(async (request, response) => {
    requests++;
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      keys.add(request.url!);
      response.end(JSON.stringify({ value: state }));
    } else if (request.method === 'PUT') {
      keys.add(request.url!);
      state = JSON.parse(body).value;
      saved.push(JSON.parse(state!));
      response.end('{}');
    } else {
      const id = JSON.parse(body).subject.id as number;
      if (id === failId) {
        response.writeHead(503);
        response.end('{"error":"test failure"}');
      } else {
        imported.push(id);
        response.end(JSON.stringify({ imported: id }));
      }
    }
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
        '--request-retries',
        '0',
        ...extra,
      ],
      { env: { ...process.env, ADMIN_TOKEN: token } },
    );
  const reset = () => {
    state = null;
    saved.length = 0;
    imported.length = 0;
  };
  try {
    const defaults = await run();
    assert.equal(JSON.parse(defaults.stdout).imported, 22);
    assert.deepEqual(
      saved.map((entry) => entry.line),
      [20, 40, 45],
    );
    assert.equal(saved.at(-1)!.complete, true);
    const logs = defaults.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert(logs.some((log) => log.event === 'archive_resumed' && log.checkpointInterval === 20));
    assert(
      logs
        .filter((log) => log.event === 'archive_checkpoint_saved')
        .every((log) => log.checkpointInterval === 20),
    );

    reset();
    const limited = await run(['--checkpoint-interval', '4', '--limit', '2']);
    assert.deepEqual(saved, [{ line: 4, skippedTotal: 0, complete: false }]);
    assert.equal(JSON.parse(limited.stdout).complete, false);

    reset();
    failId = 22;
    await assert.rejects(run(), (error: unknown) => {
      const failure = error as { stderr: string };
      assert(failure.stderr.includes('第 22 行导入失败'));
      return true;
    });
    assert.deepEqual(
      saved.map((entry) => entry.line),
      [20],
    );
    assert.equal(imported.length, 10);
    failId = undefined;
    const resumed = await run(['--checkpoint-interval', '7']);
    assert.equal(JSON.parse(resumed.stdout).imported, 12);
    assert.deepEqual(
      saved.map((entry) => entry.line),
      [20, 21, 28, 35, 42, 45],
    );
    assert.deepEqual(
      imported,
      Array.from({ length: 22 }, (_, i) => (i + 1) * 2),
    );
    assert.equal(saved.at(-1)!.complete, true);
    assert.equal(keys.size, 1, '修改检查点间隔不会改变文件版本的检查点键');

    for (const invalid of ['0', '-1', '0.5', 'NaN', 'Infinity', '9007199254740992']) {
      const before = requests;
      await assert.rejects(run(['--checkpoint-interval', invalid]));
      assert.equal(requests, before, '无效间隔必须在读写检查点或导入前拒绝');
    }

    // 用真实 CLI 和 HTTP 计数：200 行非动画仅合并保存一次，尾部 200 行只最终保存。
    await writeFile(
      file,
      Array.from({ length: 401 }, (_, i) =>
        JSON.stringify({ id: i + 1, type: i === 200 ? 2 : 4, name: `条目${i + 1}` }),
      ).join('\n'),
    );
    reset();
    const before = requests;
    const merged = await run();
    assert.equal(JSON.parse(merged.stdout).imported, 1);
    assert.deepEqual(saved, [
      { line: 200, skippedTotal: 0 },
      { line: 401, skippedTotal: 0, complete: true },
    ]);
    assert.deepEqual(imported, [201]);
    assert.equal(requests - before, 4, '只读一次检查点、导入一条动画、保存两次检查点');
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
  kind: 'node' | 'worker' | 'postgres',
  enabled: boolean,
  bangumi?: {
    userAgent: string;
    accessToken: string;
    fetcher: typeof fetch;
    calendarSyncEnabled?: boolean;
    calendarPlatformBatchSize?: number;
  },
  aliasMissStatsEnabled = false,
) {
  const logs: string[] = [];
  if (kind !== 'worker') {
    const pg = kind === 'postgres' ? await postgresTestDatabase() : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    await driver.migrate();
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
        ALIAS_MISS_STATS_ENABLED: String(aliasMissStatsEnabled),
        CALENDAR_PLATFORM_BATCH_SIZE: bangumi?.calendarPlatformBatchSize ?? 10,
        BANGUMI_USER_AGENT: bangumi?.userAgent ?? '',
        BANGUMI_ACCESS_TOKEN: bangumi?.accessToken ?? '',
      }),
      {
        subjectSource: source,
        calendarSource: source,
        searchSource: source,
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
        if (pg) await pg.close();
        else await driver.close();
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
        ALIAS_MISS_STATS_ENABLED: String(aliasMissStatsEnabled),
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
                body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
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

for (const kind of ['node', 'worker', 'postgres'] as const) {
  test(`${kind}: 未命中别名按自定数量读取，远程 CLI 可处理超过 100 条`, async () => {
    const searched: string[] = [];
    const target = await runtime(kind, false, {
      userAgent: 'test/alias-limit',
      accessToken: '',
      fetcher: (async (input, init) => {
        assert.equal(new URL(String(input)).pathname, '/v0/search/subjects');
        searched.push(JSON.parse(String(init?.body)).keyword);
        return Response.json({ total: 0, data: [] });
      }) as typeof fetch,
    });
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-alias-limit-'));
    const headers = { Authorization: `Bearer ${token}` };
    const path = '/api/v1/admin/stats/alias-misses';
    const load = async (query = '') => {
      const response = await target.fetch(path + query, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as any).aliases as { name: string; planned: boolean }[];
    };
    try {
      await target.sql(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<125)
        INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at,planned)
        SELECT '待处理'||n,'待处理'||n,1000-n,1,1,1 FROM nums`);
      await target.sql("INSERT INTO alias_miss_stats VALUES('无计划','无计划',2000,1,1,0)");
      assert.equal((await load()).length, 100);
      const expected = Array.from({ length: 125 }, (_, i) => `待处理${i + 1}`);
      assert.deepEqual(
        (await load('?planned=true&limit=123')).map((r) => r.name),
        expected.slice(0, 123),
      );
      assert.deepEqual(
        (await load(`?planned=true&limit=${Number.MAX_SAFE_INTEGER}`)).map((r) => r.name),
        expected,
      );
      assert.deepEqual(
        await load('?planned=false&limit=1000').then((rows) => rows.map((r) => r.name)),
        ['无计划'],
      );
      for (const invalid of ['0', '-1', '1.5', '', 'NaN', 'Infinity', '9007199254740992'])
        assert.equal((await target.fetch(`${path}?limit=${invalid}`, { headers })).status, 400);
      assert.equal((await target.fetch(`${path}?limit=1000`)).status, 401);
      const spec = (await (await target.fetch('/openapi.json')).json()) as any;
      const parameter = spec.paths[path].get.parameters.find((p: any) => p.name === 'limit');
      assert.equal(parameter.schema.default, 100);
      assert.equal(parameter.schema.maximum, Number.MAX_SAFE_INTEGER);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          join(process.cwd(), 'dist/node/cli.js'),
          'resolve-alias-misses',
          '--auto',
          '--no-interactive',
          '--json',
          '--api-url',
          target.baseUrl,
          '--limit',
          '121',
          '--request-retries',
          '0',
          '--log-level',
          'silent',
        ],
        { cwd: dir, timeout: 30000, env: { ...process.env, ADMIN_TOKEN: token } },
      );
      const summary = JSON.parse(stdout);
      assert.equal(summary.total, 121);
      assert.equal(summary.processed, 121);
      assert.equal(summary.noCandidates, 121);
      assert.equal(summary.status, 'completed');
      assert.deepEqual(searched, expected.slice(0, 121));
      assert.equal((await load('?planned=true&limit=1000')).length, 125);
    } finally {
      await target.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${kind}: CLI 自动处理未命中别名无需 stdin，跳过无匹配和歧义，复用官方名称`, async () => {
    const searched: string[] = [];
    let synced = 0;
    const target = await runtime(
      kind,
      false,
      {
        userAgent: 'test/auto',
        accessToken: 'auto-server-token',
        fetcher: (async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === '/v0/search/subjects') {
            assert.equal(url.searchParams.get('limit'), '3');
            const { keyword } = JSON.parse(String(init?.body));
            searched.push(keyword);
            const data =
              keyword === '无结果'
                ? []
                : keyword === '歧义'
                  ? [801, 802].map((id) => ({ id, type: 2, name: keyword }))
                  : [
                      { id: 800, type: 2, name: '不相关' },
                      { id: 802, type: 2, name: '原名', name_cn: '中文名' },
                    ];
            return Response.json({ total: data.length, data });
          }
          assert.equal(url.pathname, '/v0/subjects/802');
          synced++;
          return Response.json({
            id: 802,
            type: 2,
            name: '原名',
            name_cn: '中文名',
            rating: { score: 8, total: 10 },
          });
        }) as typeof fetch,
      },
      true,
    );
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-auto-review-'));
    const names = ['不匹配', '无结果', '歧义', '原名', '中文名', '超出数量'];
    try {
      for (const [i, name] of names.entries())
        await target.sql(`INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at)
          VALUES('${name}','${name}',${10 - i},1,1)`);
      await target.sql("INSERT INTO alias_miss_stats VALUES('无计划','无计划',20,1,1,0)");
      // stdin 保持打开且不输入：自动模式必须独立完成并退出。
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          join(process.cwd(), 'dist/node/cli.js'),
          'resolve-alias-misses',
          '--auto',
          '--no-interactive',
          '--json',
          '--api-url',
          target.baseUrl,
          '--limit',
          '5',
          '--search-limit',
          '3',
        ],
        {
          cwd: dir,
          timeout: 15000,
          env: {
            ...process.env,
            ADMIN_TOKEN: token,
            BANGUMI_USER_AGENT: '',
            BANGUMI_ACCESS_TOKEN: '',
          },
        },
      );
      const summary = JSON.parse(stdout);
      assert.deepEqual(searched, names.slice(0, 5));
      assert.equal(synced, 1);
      assert.equal(summary.status, 'completed');
      assert.equal(summary.processed, 5);
      assert.equal(summary.resolved, 2);
      assert.equal(summary.skipped, 2);
      assert.equal(summary.noCandidates, 1);
      assert.deepEqual(
        summary.results.slice(0, 3).map((r: any) => r.reason),
        ['no_exact_match', 'no_candidates', 'ambiguous_exact_match'],
      );
      assert(stderr.includes('alias_auto_selected'));
      assert(stderr.includes('alias_auto_skipped'));
      assert(!stderr.includes('选择序号'));
      assert.deepEqual(
        (await target.sql('SELECT name,source FROM subject_aliases ORDER BY name')).map((r) => ({
          ...r,
        })),
        ['中文名', '原名'].map((name) => ({ name, source: 'bangumi' })),
      );
      const remaining = await target.sql('SELECT name,planned FROM alias_miss_stats');
      assert.deepEqual(
        remaining.map((r) => r.name).sort(),
        ['不匹配', '无结果', '歧义', '超出数量', '无计划'].sort(),
      );
      assert(remaining.every((r) => r.planned === (r.name === '无计划' ? 0 : 1)));
    } finally {
      await target.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${kind}: 同条目同名别名跨来源唯一，复用官方记录，保留已有手动来源`, async () => {
    const target = await runtime(kind, false);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = async (path: string, body: unknown, method = 'POST') => {
      const response = await target.fetch(path, { method, headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as any;
    };
    const add = (name: string, id = 1) => send(`/api/v1/admin/subjects/${id}/aliases`, { name });
    try {
      await send('/api/v1/admin/import', fixture(1, '官方名称', ['已有别名', '作品第二季']));
      await send('/api/v1/admin/import', fixture(2, '另一作品', []));
      const before = await target.sql(
        "SELECT * FROM subject_aliases WHERE subject_id=1 AND name='已有别名'",
      );
      await target.sql(
        "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES('已有别名','已有别名',1,1,1)",
      );
      const reused = (await add('已有别名')).alias;
      assert.equal(reused.id, before[0]!.id);
      assert.equal(reused.source, 'bangumi');
      assert.equal((await add('已有别名')).alias.id, reused.id);
      assert.deepEqual(
        await target.sql("SELECT * FROM subject_aliases WHERE subject_id=1 AND name='已有别名'"),
        before,
      );
      assert.equal((await target.sql('SELECT * FROM alias_miss_stats')).length, 0);
      await add('作品第2季');
      assert.equal(
        (
          await target.sql(
            "SELECT * FROM subject_aliases WHERE subject_id=1 AND name IN ('作品第二季','作品第2季')",
          )
        ).length,
        2,
      );
      const manual = (await add('人工名称')).alias;
      const refreshed = fixture(1, '刷新名称', ['已有别名', '人工名称']);
      refreshed.subject.metadataAt++;
      await send('/api/v1/admin/import', refreshed);
      assert.equal((await add('人工名称')).alias.id, manual.id);
      assert.equal((await add('人工名称')).alias.source, 'manual');
      const conflict = await target.fetch(`/api/v1/admin/aliases/${manual.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: '已有别名' }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json()) as any).error.code, 'ALIAS_EXISTS');
      const concurrent = await Promise.all([add('并发名称'), add('并发名称')]);
      assert.equal(concurrent[0].alias.id, concurrent[1].alias.id);
      assert.equal((await add('已有别名', 2)).alias.subjectId, 2);
      await add('Case');
      await add('case');
      assert.equal(
        (
          await target.sql(
            "SELECT * FROM subject_aliases WHERE subject_id=1 AND name IN ('Case','case')",
          )
        ).length,
        2,
      );
      assert.equal(
        (
          await target.sql(
            'SELECT subject_id,name FROM subject_aliases GROUP BY subject_id,name HAVING COUNT(*)>1',
          )
        ).length,
        0,
      );
      await assert.rejects(
        target.sql(
          "INSERT INTO subject_aliases VALUES('raw-duplicate',1,'已有别名','已有别名','manual',1,1)",
        ),
      );
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 旧备份跨来源同名别名恢复去重，CLI 续跑比较规范化内容`, async () => {
    const server = await runtime(kind, false);
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-legacy-backup-'));
    try {
      const legacy = backupFixture(1);
      legacy.aliases[0]!.name = legacy.aliases[1]!.name;
      legacy.aliases[0]!.normalizedName = legacy.aliases[1]!.normalizedName;
      const target = remoteTarget(server.baseUrl, token);
      await target.restore(legacy);
      assert.deepEqual((await target.exportPage(0)).records, [parseBackupRecord(legacy)]);
      await server.sql('DELETE FROM subjects');
      const file = join(dir, 'legacy.jsonl');
      await writeFile(file, JSON.stringify(legacy));
      const logger = createCliLogger({ command: 'import', level: 'silent' });
      assert.equal((await restoreBackup({ file, target, logger })).restored, 1);
      assert.equal((await restoreBackup({ file, target, logger })).resumed, 1);
      assert.deepEqual((await target.exportPage(0)).records, [parseBackupRecord(legacy)]);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${kind}: 显式 ID 和官方链接不消耗名称候选预算，名称查询仍受限`, async () => {
    const target = await runtime(kind, true, undefined, true);
    const batch = (items: unknown[]) =>
      target.fetch('/api/v1/ratings/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
    try {
      await target.sql(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<1001)
        INSERT INTO subjects(id,name,air_date,platform,metadata_at,cached_at)
        SELECT id,'作品'||id,'2026-01-01','TV',1,1 FROM ids`);
      await target.sql(`INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
        SELECT 'a'||id,id,'共同名称','共同名称','bangumi',1,1 FROM subjects`);
      const link = 'https://bgm.tv/subject/1';
      await target.sql(`INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
        SELECT 'link'||id,id,'${link}','${normalizeName(link)}','bangumi',1,1 FROM subjects`);
      await target.sql(`INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
        VALUES('unique',1,'独有名称','独有名称','manual',1,1)`);
      const limited = await batch([{ inputId: 'name', names: ['共同名称'] }]);
      assert.equal(limited.status, 400);
      assert.equal(((await limited.json()) as any).error.code, 'TOO_MANY_CANDIDATES');
      const response = await batch([
        {
          inputId: 'id',
          subjectId: 1,
          names: ['共同名称', '忽略的未知名称', '独有名称'],
          year: 2026,
          platform: 'TV',
        },
        { inputId: 'year', subjectId: 1, names: ['共同名称'], year: 2025 },
        { inputId: 'platform', subjectId: 1, names: ['共同名称'], platform: 'OVA' },
        { inputId: 'link', names: [link] },
        { inputId: 'name', names: ['独有名称'] },
        { inputId: 'miss', names: ['真正未知'] },
      ]);
      assert.equal(response.status, 200);
      const { results } = (await response.json()) as any;
      assert.deepEqual(
        results.map((r: any) => r.status),
        ['matched', 'not_found', 'not_found', 'matched', 'matched', 'not_found'],
      );
      assert.equal(results[0].subject.id, 1);
      assert.equal(results[0].matchReason, 'subject_id');
      assert.deepEqual(results[0].matchedAliases, []);
      assert.equal(results[3].matchReason, 'subject_id');
      assert.deepEqual(results[3].matchedAliases, []);
      assert.deepEqual(results[4].matchedAliases, [{ name: '独有名称', source: 'manual' }]);
      assert.deepEqual(
        (await target.sql('SELECT name FROM alias_miss_stats')).map((r: any) => r.name),
        ['真正未知'],
      );
      assert.equal(
        (await target.sql('SELECT total_hits FROM subject_usage WHERE subject_id=1'))[0]!
          .total_hits,
        1,
      );
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 远程备份恢复响应丢失和检查点失败后续跑，数据保持原样`, async () => {
    const server = await runtime(kind, false);
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-remote-restore-'));
    const file = join(dir, 'backup.jsonl');
    const records = [backupFixture(2), backupFixture(1)];
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n'));
    const restoreRequests: number[] = [];
    const target = remoteTarget(server.baseUrl, token, {
      fetcher: (async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/restore')) {
          assert.equal(response.status, 200);
          restoreRequests.push(JSON.parse(String(init!.body)).subject.id);
          if (restoreRequests.length === 1) {
            await response.arrayBuffer();
            throw new TypeError('模拟服务器写入成功后连接断开');
          }
        }
        return response;
      }) as typeof fetch,
    });
    const logger = createCliLogger({ command: 'import', level: 'silent' });
    const run = () => restoreBackup({ file, target, logger, maxRecordBytes: 256 * 1024 });
    const setState = target.setState;
    try {
      await assert.rejects(run, /第 1 行恢复失败/);
      target.setState = async (key, value) => {
        if (JSON.parse(value).completed === 2) throw new Error('模拟检查点请求失败');
        await setState(key, value);
      };
      await assert.rejects(run, /第 2 行恢复失败/);
      target.setState = setState;
      assert.deepEqual(await run(), { restored: 0, resumed: 2, total: 2, complete: true });
      assert.deepEqual(restoreRequests, [2, 1]);
      assert.deepEqual((await target.exportPage(0)).records, records.reverse());
      assert.equal(
        JSON.parse(String((await server.sql('SELECT value FROM sync_state'))[0]!.value)).complete,
        true,
      );
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const kind of ['node', 'postgres'] as const)
  test(`${kind}: 查询后补充别名，延迟未命中计数不会重建已清理记录`, async () => {
    const pg = kind === 'postgres' ? await postgresTestDatabase() : undefined;
    const driver = pg?.driver ?? new SqliteDriver(':memory:');
    await driver.migrate();
    const repo = new SqlRepository(driver);
    try {
      await repo.importRecord(fixture(1, '原名称', []));
      await repo.recordAliasMisses(['Pending'], asOf);
      const findAliases = repo.findAliases.bind(repo);
      repo.findAliases = async (keys) => {
        const matches = await findAliases(keys);
        await repo.addManualAlias(1, 'pending', asOf + 1);
        assert.deepEqual(await repo.aliasMissStats(), []);
        return matches;
      };
      const service = new QueryService(repo, {
        statsEnabled: false,
        aliasMissStatsEnabled: true,
        ratingTtlHours: 24,
      });
      await service.batch([{ inputId: 'delayed', names: ['ＰＥＮＤＩＮＧ', '仍然未知'] }]);
      assert.deepEqual(
        (await repo.aliasMissStats()).map((row) => row.normalizedName),
        ['仍然未知'],
      );
    } finally {
      if (pg) await pg.close();
      else await driver.close();
    }
  });

for (const kind of ['node', 'worker', 'postgres'] as const)
  test(`${kind}: 未命中计划默认开启，可筛选及恢复，重复未命中不重置计划，补充别名仍清理`, async () => {
    const target = await runtime(kind, false, undefined, true);
    const path = '/api/v1/admin/stats/alias-misses';
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const patch = (body: unknown) =>
      target.fetch(path, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const stats = async (query = '') => {
      const response = await target.fetch(path + query, { headers });
      assert.equal(response.status, 200);
      return ((await response.json()) as any).aliases as any[];
    };
    const miss = () =>
      target.fetch('/api/v1/ratings/batch', {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [{ inputId: 'a', names: ['Unknown'] }] }),
      });
    try {
      assert.equal((await miss()).status, 200);
      const original = (await stats())[0];
      assert.equal(original.planned, true);
      assert.equal((await target.fetch(path, { method: 'PATCH', body: '{}' })).status, 401);
      for (const body of [
        { name: 'unknown' },
        { name: 'unknown', planned: 'false' },
        { name: '', planned: false },
      ])
        assert.equal((await patch(body)).status, 400);
      assert.equal((await target.fetch(path + '?planned=0', { headers })).status, 400);
      const marked = await patch({ name: ' ＵＮＫＮＯＷＮ ', planned: false });
      assert.equal(marked.status, 200);
      assert.deepEqual(((await marked.json()) as any).alias, { ...original, planned: false });
      assert.equal((await patch({ name: 'unknown', planned: false })).status, 200);
      assert.deepEqual(await stats('?planned=true'), []);
      assert.equal((await stats('?planned=false'))[0].planned, false);
      assert.equal((await miss()).status, 200);
      const repeated = (await stats())[0];
      assert.equal(repeated.missCount, 2);
      assert.equal(repeated.planned, false);
      assert.equal(repeated.firstMissedAt, original.firstMissedAt);
      assert.equal((await patch({ name: 'unknown', planned: true })).status, 200);
      assert.equal((await stats('?planned=true'))[0].normalizedName, 'unknown');
      const missing = await patch({ name: '不存在', planned: false });
      assert.equal(missing.status, 404);
      assert.equal(((await missing.json()) as any).error.code, 'ALIAS_MISS_NOT_FOUND');
      assert.equal((await stats()).length, 1);
      // 大量热门无计划名称不能挤占有计划列表的 LIMIT。
      await target.sql(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<101)
        INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at,planned)
        SELECT '无计划'||n,'无计划'||n,1000,1,1,0 FROM nums`);
      assert.equal((await stats()).length, 100);
      assert((await stats()).every((r) => r.planned === false));
      assert.deepEqual(
        (await stats('?planned=true')).map((r) => r.normalizedName),
        ['unknown'],
      );
      await patch({ name: 'unknown', planned: false });
      const imported = await target.fetch('/api/v1/admin/import', {
        method: 'POST',
        headers,
        body: JSON.stringify(fixture(1, '已导入', ['Unknown'])),
      });
      assert.equal(imported.status, 200);
      assert.equal((await patch({ name: 'unknown', planned: true })).status, 404);
      assert.deepEqual(
        await target.sql("SELECT * FROM alias_miss_stats WHERE normalized_name='unknown'"),
        [],
      );
      const spec = (await (await target.fetch('/openapi.json')).json()) as any;
      assert.deepEqual(spec.paths[path].patch.security, [{ bearerAuth: [] }]);
      assert(spec.paths[path].get.parameters.some((p: any) => p.name === 'planned'));
    } finally {
      await target.close();
    }
  });

for (const kind of ['node', 'worker', 'postgres'] as const)
  for (const enabled of [false, true])
    test(`${kind}: 未命中别名统计开关 ${enabled}，归一化计数、管理鉴权及写入失败隔离`, async () => {
      const target = await runtime(kind, false, undefined, enabled);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const batch = async (items: unknown[]) => {
        const response = await target.fetch('/api/v1/ratings/batch', {
          method: 'POST',
          headers,
          body: JSON.stringify({ items }),
        });
        assert.equal(response.status, 200);
        return (await response.json()) as any;
      };
      const stats = async () => {
        const response = await target.fetch('/api/v1/admin/stats/alias-misses', { headers });
        assert.equal(response.status, 200);
        return (await response.json()) as any;
      };
      try {
        assert.equal((await target.fetch('/api/v1/admin/stats/alias-misses')).status, 401);
        for (const id of [1, 2]) {
          const response = await target.fetch('/api/v1/admin/import', {
            method: 'POST',
            headers,
            body: JSON.stringify(fixture(id, `已知${id}`, ['同名'])),
          });
          assert.equal(response.status, 200);
        }
        const result = await batch([
          { inputId: 'a', names: ['已知1', 'Unknown', 'ＵＮＫＮＯＷＮ'] },
          { inputId: 'b', names: ['unknown', '另一部'] },
          { inputId: 'filter', names: ['已知1'], year: 1900 },
          { inputId: 'id', subjectId: 999, names: ['不应记录'] },
          { inputId: 'link', names: ['https://bgm.tv/subject/999'] },
          { inputId: 'shared', names: ['同名'] },
          { inputId: 'number', names: ['86'] },
        ]);
        assert.equal(result.results[0].status, 'matched');
        assert.equal(result.results[2].status, 'not_found');
        assert.equal(result.results[5].status, 'ambiguous');
        await batch([{ inputId: 'repeat', names: ['unknown'] }]);
        const records = await stats();
        assert.equal(records.enabled, enabled);
        assert.equal(records.aliases.length, enabled ? 3 : 0);
        assert.deepEqual(await target.sql('SELECT * FROM subject_usage'), []);
        if (enabled) {
          const cli = await promisify(execFile)(
            process.execPath,
            ['dist/node/cli.js', 'alias-misses', '--api-url', target.baseUrl],
            { env: { ...process.env, ADMIN_TOKEN: token } },
          );
          assert.deepEqual(JSON.parse(cli.stdout), records.aliases);
          assert.deepEqual(
            records.aliases.map((r: any) => [r.normalizedName, r.missCount]).sort(),
            [
              ['86', 1],
              ['unknown', 2],
              ['另一部', 1],
            ],
          );
          assert(
            records.aliases.every(
              (r: any) => typeof r.firstMissedAt === 'number' && r.lastMissedAt >= r.firstMissedAt,
            ),
          );
          const added = await target.fetch('/api/v1/admin/subjects/1/aliases', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'unknown' }),
          });
          assert.equal(added.status, 200);
          assert.equal(
            (await batch([{ inputId: 'fixed', names: ['unknown'] }])).results[0].status,
            'matched',
          );
          assert(!(await stats()).aliases.some((r: any) => r.normalizedName === 'unknown'));
          const statement =
            kind === 'postgres'
              ? "CREATE FUNCTION reject_miss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'miss write failure'; END $$; CREATE TRIGGER reject_miss BEFORE INSERT ON alias_miss_stats FOR EACH ROW EXECUTE FUNCTION reject_miss()"
              : "CREATE TRIGGER reject_miss BEFORE INSERT ON alias_miss_stats BEGIN SELECT RAISE(ABORT, 'miss write failure'); END";
          await target.sql(statement);
          const failed = await batch([{ inputId: 'fail', names: ['未知私密名称', '已知1'] }]);
          assert.equal(failed.results[0].status, 'matched');
          for (
            let i = 0;
            i < 20 && !target.logs.some((line) => line.includes('alias_miss_write_failed'));
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 25));
          const log = target.logs.find((line) => line.includes('alias_miss_write_failed'));
          assert(log);
          assert(!log.includes('未知私密名称'));
          assert.equal((await stats()).aliases.length, 2);
        } else {
          // 关闭开关只停止查询计数，补充别名仍应清理之前积累的记录。
          await target.sql(
            "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('unknown','Unknown',2,1,2)",
          );
          const added = await target.fetch('/api/v1/admin/subjects/1/aliases', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'ＵＮＫＮＯＷＮ' }),
          });
          assert.equal(added.status, 200);
          assert.deepEqual((await stats()).aliases, []);
          // 关闭时无需访问统计表，迁移异常也不能引入额外查询故障。
          await target.sql('DROP TABLE alias_miss_stats');
          assert.equal(
            (await batch([{ inputId: 'off', names: ['不存在'] }])).results[0].status,
            'not_found',
          );
        }
      } finally {
        await target.close();
      }
    });

for (const kind of ['node', 'worker', 'postgres'] as const) {
  test(`${kind}: 别名写入清理未命中记录，覆盖导入、手动修改、季数补全、日历和恢复`, async () => {
    const target = await runtime(
      kind,
      false,
      {
        userAgent: 'test/alias-misses',
        accessToken: '',
        fetcher: (async (url) =>
          String(url).endsWith('/calendar')
            ? Response.json([
                {
                  items: [
                    { id: 13, type: 2, name: '日历' },
                    { id: 17, type: 2, name: '日历跳过' },
                  ],
                },
              ])
            : Response.json({
                id: Number(String(url).split('/').pop()),
                type: 2,
                platform: 'TV',
              })) as typeof fetch,
      },
      true,
    );
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = async (path: string, body: unknown, method = 'POST') => {
      const response = await target.fetch(path, { method, headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as any;
    };
    const remaining = async () =>
      (
        await target.sql('SELECT normalized_name FROM alias_miss_stats ORDER BY normalized_name')
      ).map((row) => row.normalized_name);
    try {
      const missing = [
        '原作',
        '中文11',
        '导入 别称',
        '原作第2季',
        '原作第二季',
        '原作第一季',
        '原作第1季',
        ' ＡＢＣ　 别称 ',
        '改名第三季',
        '改名第3季',
        '日历',
        '日历跳过',
        '恢复名',
        '恢复别称',
        '仍然未知',
        '过期导入',
      ];
      await send('/api/v1/ratings/batch', {
        items: missing.map((name, i) => ({ inputId: String(i), names: [name] })),
      });
      assert.equal((await remaining()).length, missing.length);
      await send('/api/v1/admin/import', fixture(11, '原作', ['导入 别称']));
      for (const name of ['原作', '中文11', '导入 别称'])
        assert(!(await remaining()).includes(name));
      await send('/api/v1/admin/import', fixture(12, '原作第二季', []));
      for (const name of ['原作第2季', '原作第二季', '原作第一季', '原作第1季'])
        assert(!(await remaining()).includes(name), name);
      const manual = await send('/api/v1/admin/subjects/11/aliases', { name: 'abc 别称' });
      assert(!(await remaining()).includes('abc 别称'));
      // 重复添加已存在的别名，也能清理旧版本遗留的统计。
      await target.sql(
        "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('abc 别称','ABC 别称',2,1,2)",
      );
      const repeated = await send('/api/v1/admin/subjects/11/aliases', { name: 'abc 别称' });
      assert.equal(repeated.alias.id, manual.alias.id);
      assert(!(await remaining()).includes('abc 别称'));
      await send(`/api/v1/admin/aliases/${manual.alias.id}`, { name: '改名第三季' }, 'PATCH');
      assert(!(await remaining()).includes('改名第三季'));
      assert(!(await remaining()).includes('改名第3季'));
      // 旧快照没有实际写入别名，不能清理对应的未命中项。
      const older = fixture(11, '过期导入', []);
      older.subject.metadataAt--;
      await send('/api/v1/admin/import', older);
      await send('/api/v1/admin/import', fixture(17, '满额', []));
      await target.sql(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<248)
        INSERT INTO subject_aliases SELECT 'full-'||n,17,'满额'||n,'满额'||n,'manual',1,1 FROM nums`);
      await send('/api/v1/admin/calendar/sync', {});
      // 日历遇到别名上限会跳过该条目，仍未知的名称必须保留。
      assert((await remaining()).includes('日历跳过'));
      assert.deepEqual(await target.sql("SELECT * FROM subject_aliases WHERE name='日历跳过'"), []);
      const restored = fixture(14, '恢复名', []);
      await send('/api/v1/admin/restore', {
        version: 1,
        subject: restored.subject,
        aliases: [
          {
            id: crypto.randomUUID(),
            subjectId: 14,
            name: '恢复别称',
            normalizedName: '恢复别称',
            source: 'manual',
            createdAt: asOf,
            updatedAt: asOf,
          },
        ],
        rating: restored.rating,
        usage: null,
        daily: [],
      });
      // 备份只清理实际恢复的别名，不把条目元数据当作可查询的别名。
      assert.deepEqual(await remaining(), ['仍然未知', '恢复名', '过期导入', '日历跳过'].sort());
      // 清理参数同样要支持导入上限，避免超过 D1 每条语句 100 个参数的限制。
      await target.sql(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<200)
        INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) SELECT '批量'||n,'批量'||n,1,1,1 FROM nums`);
      await send(
        '/api/v1/admin/import',
        fixture(
          16,
          '大批量',
          Array.from({ length: 200 }, (_, i) => `批量${i + 1}`),
        ),
      );
      assert.deepEqual(await remaining(), ['仍然未知', '恢复名', '过期导入', '日历跳过'].sort());
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 未命中清理失败时别名写入整体回滚，重试后一起生效`, async () => {
    const target = await runtime(kind, false, undefined, true);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = (path: string, body: unknown) =>
      target.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      assert.equal(
        (
          await send('/api/v1/ratings/batch', {
            items: [{ inputId: 'rollback', names: ['事务清理', '仍然未知'] }],
          })
        ).status,
        200,
      );
      const before = await target.sql('SELECT * FROM alias_miss_stats ORDER BY normalized_name');
      await target.sql(
        kind === 'postgres'
          ? "CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup failure'; END $$; CREATE TRIGGER reject_cleanup BEFORE DELETE ON alias_miss_stats FOR EACH ROW EXECUTE FUNCTION reject_cleanup()"
          : "CREATE TRIGGER reject_cleanup BEFORE DELETE ON alias_miss_stats BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END",
      );
      assert.equal((await send('/api/v1/admin/import', fixture(15, '事务清理', []))).status, 503);
      assert.deepEqual(await target.sql('SELECT * FROM subjects WHERE id=15'), []);
      assert.deepEqual(await target.sql('SELECT * FROM subject_aliases WHERE subject_id=15'), []);
      assert.deepEqual(
        await target.sql('SELECT * FROM alias_miss_stats ORDER BY normalized_name'),
        before,
      );
      await target.sql(
        kind === 'postgres'
          ? 'DROP TRIGGER reject_cleanup ON alias_miss_stats'
          : 'DROP TRIGGER reject_cleanup',
      );
      assert.equal((await send('/api/v1/admin/import', fixture(15, '事务清理', []))).status, 200);
      assert.deepEqual(
        await target.sql('SELECT * FROM alias_miss_stats'),
        before.filter((row) => row.normalized_name === '仍然未知'),
      );
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 导入与手动别名互补季数，补全第一季并支持反向导入和幂等刷新`, async () => {
    const target = await runtime(kind, false);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = async (path: string, body: unknown, method = 'POST') => {
      const response = await target.fetch(path, {
        method,
        headers: auth,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as any;
    };
    const aliases = async (id: number) =>
      await target.sql(`SELECT * FROM subject_aliases WHERE subject_id=${id} ORDER BY id`);
    try {
      await send('/api/v1/admin/import', fixture(501, '星海', []));
      await send('/api/v1/admin/import', fixture(502, '星海第2季', []));
      const result = await send('/api/v1/ratings/batch', {
        items: ['星海第一季', '星海第1季', '星海第二季', '星海第2季'].map((name, i) => ({
          inputId: String(i),
          names: [name],
        })),
      });
      assert.deepEqual(
        result.results.map((r: any) => [r.status, r.subject.id]),
        [
          ['matched', 501],
          ['matched', 501],
          ['matched', 502],
          ['matched', 502],
        ],
      );
      const before = await aliases(502);
      await send('/api/v1/admin/import', fixture(502, '星海第2季', []));
      assert.deepEqual(await aliases(502), before);

      const added = await send('/api/v1/admin/subjects/502/aliases', { name: '别称第十二季' });
      const repeated = await send('/api/v1/admin/subjects/502/aliases', { name: '别称第十二季' });
      assert.equal(added.alias.id, repeated.alias.id);
      assert((await aliases(502)).some((a) => a.name === '别称第12季' && a.source === 'manual'));
      await send('/api/v1/admin/subjects/501/aliases', { name: '人工标题' });
      await send('/api/v1/admin/subjects/502/aliases', { name: '人工标题第二季' });
      assert((await aliases(501)).some((a) => a.name === '人工标题第1季' && a.source === 'manual'));
      await send(`/api/v1/admin/aliases/${added.alias.id}`, { name: '别称第3季' }, 'PATCH');
      assert((await aliases(502)).some((a) => a.name === '别称第三季' && a.source === 'manual'));
      const newer = fixture(501, '星海', []);
      newer.subject.metadataAt++;
      await send('/api/v1/admin/import', newer);
      const refreshed = await aliases(501);
      for (const name of ['星海第一季', '星海第1季', '人工标题第一季', '人工标题第1季'])
        assert(
          refreshed.some((a) => a.name === name),
          name,
        );
      await send('/api/v1/admin/import', fixture(504, '后导 第二季', []));
      await send('/api/v1/admin/import', fixture(503, '后导', []));
      assert((await aliases(503)).some((a) => a.name === '后导 第1季'));
      assert((await aliases(503)).some((a) => a.name === '后导 第一季'));
      // 旧库只有一种写法时，重复添加会补缺失项而不改变已有别名 ID。
      await target.sql("DELETE FROM subject_aliases WHERE subject_id=502 AND name='别称第三季'");
      await send('/api/v1/admin/subjects/502/aliases', { name: '别称第3季' });
      assert((await aliases(502)).some((a) => a.name === '别称第三季'));
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 第一季优先明确季名，歧义和第二季自身不自动归属，转换后的冲突可见`, async () => {
    const target = await runtime(kind, false);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const add = async (id: number, name: string, aliases: string[] = []) => {
      const response = await target.fetch('/api/v1/admin/import', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(fixture(id, name, aliases)),
      });
      assert.equal(response.status, 200, await response.clone().text());
    };
    const names = async (id: number) =>
      (await target.sql(`SELECT name FROM subject_aliases WHERE subject_id=${id}`)).map(
        (a) => a.name,
      );
    try {
      await add(510, '明确第一季');
      await target.sql("DELETE FROM subject_aliases WHERE subject_id=510 AND name='明确第1季'");
      await add(511, '明确');
      await add(512, '明确第二季');
      assert(!(await names(511)).includes('明确第一季'));
      assert((await names(510)).includes('明确第1季'));
      await add(520, '撞名');
      await add(521, '撞名');
      await add(522, '撞名第二季');
      assert(!(await names(520)).includes('撞名第一季'));
      assert(!(await names(521)).includes('撞名第1季'));
      await add(530, '冲突第一季');
      await add(531, '冲突第1季');
      await add(532, '冲突');
      await add(533, '冲突第二季');
      assert(!(await names(532)).includes('冲突第一季'));
      await add(540, '自指第二季', ['自指']);
      assert(!(await names(540)).includes('自指第一季'));
      await add(541, '其他');
      // 旧别名仅中文写法；新手动别名的数字写法也必须报告冲突。
      await target.sql("DELETE FROM subject_aliases WHERE subject_id=540 AND name='自指第2季'");
      const response = await target.fetch('/api/v1/admin/subjects/541/aliases', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: '自指第2季' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(((await response.json()) as any).conflictingSubjectIds, [540]);
      assert((await names(541)).includes('自指第二季'));
    } finally {
      await target.close();
    }
  });

  test(`${kind}: 季数扩展遵守上限，原别名与第一季补充遇到故障全部回滚`, async () => {
    const target = await runtime(kind, false);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const send = (path: string, body: unknown) =>
      target.fetch(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    try {
      assert.equal((await send('/api/v1/admin/import', fixture(600, '满员', []))).status, 200);
      await target.sql(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<247)
        INSERT INTO subject_aliases SELECT 'limit-'||n,600,'已有'||n,'已有'||n,'manual',1,1 FROM nums`);
      const before = await target.sql(
        'SELECT * FROM subject_aliases WHERE subject_id=600 ORDER BY id',
      );
      const manual = await send('/api/v1/admin/subjects/600/aliases', { name: '新作第2季' });
      assert.equal(manual.status, 400);
      assert.equal(((await manual.json()) as any).error.code, 'ALIAS_LIMIT');
      assert.deepEqual(
        await target.sql('SELECT * FROM subject_aliases WHERE subject_id=600 ORDER BY id'),
        before,
      );
      const tooMany = await send(
        '/api/v1/admin/import',
        fixture(
          601,
          '扩展超限',
          Array.from({ length: 130 }, (_, i) => `作品${i}第2季`),
        ),
      );
      assert.equal(tooMany.status, 400);
      assert.equal((await target.sql('SELECT * FROM subjects WHERE id=601')).length, 0);
      // 第一季没有容纳两个别名的空间时，第二季导入也不会部分提交。
      assert.equal(
        (await send('/api/v1/admin/import', fixture(602, '满员第二季', []))).status,
        400,
      );
      assert.equal((await target.sql('SELECT * FROM subjects WHERE id=602')).length, 0);
      const tooLong = await send('/api/v1/admin/subjects/600/aliases', {
        name: '长'.repeat(294) + '第9999季',
      });
      assert.equal(tooLong.status, 400);
      assert.equal(((await tooLong.json()) as any).error.code, 'ALIAS_TOO_LONG');
      assert.equal((await send('/api/v1/admin/import', fixture(650, '事务', []))).status, 200);
      await target.sql(
        kind === 'postgres'
          ? "CREATE FUNCTION reject_season() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='事务第一季' THEN RAISE EXCEPTION 'season test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_season BEFORE INSERT ON subject_aliases FOR EACH ROW EXECUTE FUNCTION reject_season()"
          : "CREATE TRIGGER reject_season BEFORE INSERT ON subject_aliases WHEN NEW.name='事务第一季' BEGIN SELECT RAISE(ABORT, 'season test failure'); END",
      );
      assert.equal(
        (await send('/api/v1/admin/import', fixture(651, '事务第二季', []))).status,
        503,
      );
      assert.equal((await target.sql('SELECT * FROM subjects WHERE id=651')).length, 0);
      assert.equal(
        (
          await target.sql(
            "SELECT * FROM subject_aliases WHERE name IN ('事务第一季','事务第1季','事务第2季','事务第二季')",
          )
        ).length,
        0,
      );
    } finally {
      await target.close();
    }
  });

  test(`${kind}: calendar 同批次季数补全不依赖条目顺序，重复同步不重复插入`, async () => {
    const items = [
      { id: 702, type: 2, name: '日历 第二季', name_cn: '日历 第2季' },
      { id: 701, type: 2, name: '日历' },
    ];
    const target = await runtime(kind, false, {
      userAgent: 'test/seasons',
      accessToken: '',
      fetcher: (async (url) =>
        String(url).endsWith('/calendar')
          ? Response.json([{ items }])
          : Response.json({
              id: Number(String(url).split('/').pop()),
              type: 2,
              platform: 'TV',
            })) as typeof fetch,
    });
    try {
      const sync = () =>
        target.fetch('/api/v1/admin/calendar/sync', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      const response = await sync();
      assert.equal(response.status, 200, await response.clone().text());
      const before = await target.sql('SELECT * FROM subject_aliases ORDER BY id');
      for (const name of ['日历 第一季', '日历 第1季'])
        assert(before.some((a) => a.subject_id === 701 && a.name === name));
      assert.equal(before.filter((a) => a.subject_id === 702).length, 2);
      assert.equal((await sync()).status, 200);
      assert.deepEqual(await target.sql('SELECT * FROM subject_aliases ORDER BY id'), before);
    } finally {
      await target.close();
    }
  });
}

for (const kind of ['node', 'worker', 'postgres'] as const)
  test(`${kind}: 数据库故障记录原因链和关联 ID，不泄露请求内容或凭证`, async () => {
    const bangumiSecret = 'server-error-test-bangumi-token';
    const target = await runtime(kind, false, {
      userAgent: 'tester/errors',
      accessToken: bangumiSecret,
      fetcher: (async () => Response.json({})) as unknown as typeof fetch,
    });
    try {
      await target.sql(
        kind === 'postgres'
          ? `CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage failure ${bangumiSecret}; params: private-sql-parameter'; END $$; CREATE TRIGGER reject_import BEFORE INSERT ON subjects FOR EACH ROW EXECUTE FUNCTION reject_import()`
          : `CREATE TRIGGER reject_import BEFORE INSERT ON subjects BEGIN SELECT RAISE(ABORT, 'storage failure ${bangumiSecret}; params: private-sql-parameter'); END`,
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

for (const kind of ['node', 'worker', 'postgres'] as const)
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

for (const kind of ['node', 'worker', 'postgres'] as const) {
  for (const enabled of [false, true])
    test(`${kind}: 真实 HTTP/存储契约，统计 ${enabled}`, async () => {
      const target = await runtime(kind, enabled);
      const request = async (path: string, method = 'GET', body?: unknown, auth = true) => {
        const response = await target.fetch(path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assertResponse(
          openApiDocument,
          path,
          method,
          response.status,
          await response.clone().json(),
        );
        return response;
      };
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
        assert.equal(spec.components.schemas.BatchRequest.properties.items.maxItems, 20);
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
          kind === 'postgres'
            ? "CREATE FUNCTION reject_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_usage BEFORE INSERT ON subject_usage FOR EACH ROW EXECUTE FUNCTION reject_usage()"
            : "CREATE TRIGGER reject_usage BEFORE INSERT ON subject_usage BEGIN SELECT RAISE(ABORT, 'test failure'); END",
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
      env: {
        ...process.env,
        DATABASE_DRIVER: 'sqlite',
        DATABASE_PATH: database,
        ADMIN_TOKEN: token,
        STATS_ENABLED: 'false',
      },
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
  assert.deepEqual(JSON.parse((await run(['import', '--file', backup], target)).stdout), {
    restored: 0,
    resumed: 2,
    total: 2,
    complete: true,
  });
  const backup2 = join(dir, 'backup2.jsonl');
  await run(['export', '--out', backup2], target);
  assert.equal(await readFile(backup2, 'utf8'), await readFile(backup, 'utf8'));
});

for (const databaseDriver of ['sqlite', 'postgres'] as const)
  test(`Node 打包入口 (${databaseDriver}) 能启动、自动迁移并返回 JSON`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-entry-'));
    const pg = databaseDriver === 'postgres' ? await postgresTestDatabase(false) : undefined;
    const child = spawn(process.execPath, ['dist/node/node.js'], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        DATABASE_DRIVER: databaseDriver,
        DATABASE_URL: pg?.url ?? '',
        DATABASE_POOL_SIZE: '1',
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
        schemaVersion: SCHEMA_VERSION,
        statisticsEnabled: false,
      });
    } finally {
      child.kill('SIGTERM');
      await stopped;
      await pg?.close();
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
          DATABASE_DRIVER: 'sqlite',
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
          DATABASE_DRIVER: 'sqlite',
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

for (const kind of ['node', 'worker', 'postgres'] as const)
  test(`${kind}: CLI 交互处理未命中别名使用服务端搜索与凭证，选中后导入并清理`, async () => {
    const requests: { path: string; method?: string; body?: any }[] = [];
    let fail = false;
    const target = await runtime(
      kind,
      false,
      {
        userAgent: 'test/server-search',
        accessToken: 'search-server-secret',
        fetcher: (async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('Authorization'), 'Bearer search-server-secret');
          assert.equal(headers.get('User-Agent'), 'test/server-search');
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          requests.push({ path: url.pathname, method: init?.method, body });
          if (fail) return new Response('', { status: 401 });
          if (url.pathname === '/v0/search/subjects') {
            assert.equal(init?.method, 'POST');
            assert.equal(url.searchParams.get('limit'), '2');
            assert.equal(url.searchParams.get('offset'), '0');
            assert.deepEqual(body.filter, { type: [2] });
            assert.equal(body.sort, 'match');
            return Response.json({
              total: ['甲别名', '丙无结果'].includes(body.keyword) ? 0 : 2,
              data: ['甲别名', '丙无结果'].includes(body.keyword)
                ? []
                : [801, 802].map((id) => ({
                    id,
                    type: 2,
                    name: `候选${id}`,
                    name_cn: `中文${id}`,
                    date: '2026-01-01',
                    platform: 'TV',
                    rating: { score: 8, total: 10 },
                  })),
            });
          }
          assert.equal(url.pathname, '/v0/subjects/802');
          return Response.json({
            id: 802,
            type: 2,
            name: '选定条目',
            platform: 'TV',
            infobox: [{ key: '别名', value: [{ v: '上游别名' }, { v: '乙别名' }] }],
            rating: { score: 8.6, total: 20, rank: 10 },
          });
        }) as typeof fetch,
      },
      true,
    );
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
      const denied = await target.fetch('/api/v1/admin/subjects/search', {
        method: 'POST',
        body: '{}',
      });
      assert.equal(denied.status, 401);
      const invalid = await target.fetch('/api/v1/admin/subjects/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ keyword: 'a', limit: 51 }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(requests.length, 0);
      const names = ['甲别名', '乙别名', '丙无结果', '丁跳过', '戊退出', '己超出数量'];
      for (const [i, name] of names.entries())
        await target.sql(
          `INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('${name}','${name}',${10 - i},1,1)`,
        );
      const start = () =>
        promisify(execFile)(
          process.execPath,
          [
            'dist/node/cli.js',
            'resolve-alias-misses',
            '--api-url',
            target.baseUrl,
            '--limit',
            '5',
            '--search-limit',
            '2',
            '--request-delay-ms',
            '1',
          ],
          {
            env: {
              ...process.env,
              ADMIN_TOKEN: token,
              BANGUMI_USER_AGENT: '',
              BANGUMI_ACCESS_TOKEN: 'unused-local-secret',
            },
          },
        );
      const run = start();
      run.child.stdin!.end('自定义名称\ninvalid\n2\n2\n-1\n0\nq\n');
      const { stdout, stderr } = await run.catch((error) => {
        throw new Error(`交互 CLI 失败，服务端日志：${target.logs.join('\n')}`, { cause: error });
      });
      const summary = JSON.parse(stdout);
      assert.equal(summary.status, 'stopped');
      assert.equal(summary.total, 5);
      assert.equal(summary.resolved, 2);
      assert.equal(summary.noCandidates, 0);
      assert.equal(summary.unplanned, 1);
      assert.equal(summary.skipped, 1);
      assert.equal(summary.remaining, 1);
      assert.equal(summary.importedSubjects, 1);
      assert(stderr.includes('请输入 1～2'));
      assert(stderr.includes('alias_resolved'));
      assert(!stderr.includes('search-server-secret'));
      assert(!stdout.includes('unused-local-secret'));
      assert.deepEqual(
        requests.filter((r) => r.path === '/v0/search/subjects').map((r) => r.body.keyword),
        [names[0], '自定义名称', ...names.slice(1, 5)],
      );
      assert.equal(requests.filter((r) => r.path === '/v0/subjects/802').length, 1);
      const aliases = await target.sql(
        "SELECT name FROM subject_aliases WHERE subject_id=802 AND source='manual'",
      );
      assert.deepEqual(
        aliases.map((r) => r.name),
        ['甲别名'],
      );
      const officialAlias = await target.sql(
        "SELECT source FROM subject_aliases WHERE subject_id=802 AND name='乙别名'",
      );
      assert.deepEqual(
        officialAlias.map((r) => r.source),
        ['bangumi'],
      );
      assert.deepEqual(
        (await target.sql('SELECT normalized_name FROM alias_miss_stats'))
          .map((r) => r.normalized_name)
          .sort(),
        names.slice(2).sort(),
      );
      assert.deepEqual(
        (await target.sql('SELECT id FROM subjects')).map((r) => r.id),
        [802],
      );
      assert.equal(
        (await target.sql('SELECT score FROM ratings_current WHERE subject_id=802'))[0]!.score,
        8.6,
      );
      assert.equal(
        (
          await target.sql("SELECT planned FROM alias_miss_stats WHERE normalized_name='丙无结果'")
        )[0]!.planned,
        0,
      );
      requests.length = 0;
      const next = start();
      next.child.stdin!.end('0\n0\n0\n');
      const nextSummary = JSON.parse((await next).stdout);
      assert.equal(nextSummary.total, 3);
      assert.deepEqual(
        requests.map((r) => r.body.keyword),
        names.slice(3),
      );
      fail = true;
      const failed = await target.fetch('/api/v1/admin/subjects/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ keyword: 'failed', limit: 2 }),
      });
      assert.equal(failed.status, 503);
      assert.equal(((await failed.json()) as any).error.code, 'BANGUMI_API_ERROR');
    } finally {
      await target.close();
    }
  });

test('Node CLI 本地交互处理使用本机 Bangumi Token，输入结束保留未处理记录，非法数量不创建数据库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-alias-review-'));
  const database = join(dir, 'local.sqlite');
  const mock = join(dir, 'mock.mjs');
  await writeFile(
    mock,
    `globalThis.fetch = async (url, init) => {
    if (new Headers(init.headers).get('Authorization') !== 'Bearer local-search-secret') throw new Error('missing token');
    if (String(url).includes('/v0/search/subjects?')) {
      const keyword = JSON.parse(init.body).keyword;
      if (['甲','乙','换个名称'].includes(keyword)) return Response.json({total:0,data:[]});
      if (keyword === '不再处理') throw new Error('unplanned should not be searched');
      return Response.json({total:1,data:[{id:7,type:2,name:'本地作品'}]});
    }
    if (String(url).endsWith('/v0/subjects/7')) return Response.json({id:7,type:2,name:'本地作品',infobox:[{key:'别名',value:'甲'}],rating:{score:7,total:5}});
    throw new Error('unexpected request');
  };`,
  );
  const seed = new SqliteDriver(database);
  seed.migrate();
  seed.db.exec(
    "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES ('甲','甲',3,1,1),('乙','乙',2,1,1),('丙','丙',1,1,1)",
  );
  seed.db.exec("INSERT INTO alias_miss_stats VALUES ('不再处理','不再处理',100,1,1,0)");
  seed.close();
  const env = {
    ...process.env,
    DATABASE_DRIVER: 'sqlite',
    DATABASE_PATH: database,
    ADMIN_TOKEN: '',
    BANGUMI_USER_AGENT: 'test/local-search',
    BANGUMI_ACCESS_TOKEN: 'local-search-secret',
  };
  const start = () =>
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        pathToFileURL(mock).href,
        join(process.cwd(), 'dist/node/cli.js'),
        'resolve-alias-misses',
      ],
      { env, cwd: dir },
    );
  const run = start();
  run.child.stdin!.end('本地作品\n1\n换个名称\n-1\n');
  const { stdout } = await run;
  assert.equal(JSON.parse(stdout).resolved, 1);
  assert.equal(JSON.parse(stdout).unplanned, 1);
  assert.equal(JSON.parse(stdout).status, 'stopped');
  const check = new SqliteDriver(database);
  try {
    assert.deepEqual(
      check.db
        .prepare('SELECT normalized_name FROM alias_miss_stats WHERE planned=1')
        .all()
        .map((r) => r.normalized_name),
      ['丙'],
    );
    assert.equal(
      check.db.prepare("SELECT COUNT(*) AS n FROM subject_aliases WHERE name='甲'").get()!.n,
      1,
    );
    assert.equal(
      check.db.prepare("SELECT source FROM subject_aliases WHERE name='甲'").get()!.source,
      'bangumi',
    );
    assert.equal(
      check.db.prepare("SELECT planned FROM alias_miss_stats WHERE normalized_name='乙'").get()!
        .planned,
      0,
    );
  } finally {
    check.close();
  }
  const next = start();
  next.child.stdin!.end('0\n');
  assert.equal(JSON.parse((await next).stdout).total, 1);
  const untouched = join(dir, 'untouched.sqlite');
  for (const args of [
    ['--limit', '0'],
    ['--limit', '9007199254740992'],
    ['--search-limit', '51'],
  ])
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [join(process.cwd(), 'dist/node/cli.js'), 'resolve-alias-misses', ...args],
        { cwd: dir, env: { ...env, DATABASE_PATH: untouched } },
      ),
    );
  assert(!existsSync(untouched));
});

for (const kind of ['node', 'worker', 'postgres'] as const)
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

for (const kind of ['node', 'worker', 'postgres'] as const)
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
      const calendarAlias = await target.fetch('/api/v1/admin/subjects/100/aliases', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: '日历名称' }),
      });
      const calendarAliasId = ((await calendarAlias.json()) as any).alias.id;
      // 模拟旧版 calendar 同步已写入的空作品形式，要求重新同步即可补齐。
      await target.sql(
        "INSERT INTO subjects(id,name,metadata_at,cached_at) VALUES(200,'旧日历条目',0,1)",
      );
      const response = await sync();
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as any;
      const reusedCalendarAlias = await target.sql(
        "SELECT id,source FROM subject_aliases WHERE subject_id=100 AND name='日历名称'",
      );
      assert.deepEqual(
        reusedCalendarAlias.map((a) => ({ ...a })),
        [{ id: calendarAliasId, source: 'manual' }],
      );
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
        kind === 'postgres'
          ? "CREATE FUNCTION reject_calendar() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=999 THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_calendar BEFORE INSERT ON subjects FOR EACH ROW EXECUTE FUNCTION reject_calendar()"
          : "CREATE TRIGGER reject_calendar BEFORE INSERT ON subjects WHEN NEW.id=999 BEGIN SELECT RAISE(ABORT, 'test'); END",
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

for (const kind of ['node', 'worker', 'postgres'] as const)
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
