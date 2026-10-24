import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteDriver } from '../src/adapters/storage/sqlite.ts';

const cli = join(process.cwd(), 'dist/node/cli.js');
const cleanEnv = {
  ...process.env,
  DATABASE_DRIVER: 'sqlite',
  ADMIN_TOKEN: '',
  CI: '',
  NO_COLOR: '1',
  TERM: 'xterm-256color',
  FORCE_COLOR: undefined,
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-cli-ui-'));
  const database = join(dir, 'test.sqlite');
  const seed = new SqliteDriver(database);
  seed.migrate();
  seed.close();
  const mock = join(dir, 'tty.mjs');
  // 在 CI 中通过流注入键盘事件；不依赖机器是否连接了终端。
  await writeFile(
    mock,
    `
import { appendFileSync } from 'node:fs';
for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
process.stdin.setRawMode = (value) => { process.stdin.isRaw = value; return process.stdin; };
process.stderr.columns = 100; process.stderr.rows = 30;
globalThis.fetch = async (input, init) => {
  if (process.env.TEST_CANCEL_WRITE) {
    const trace = (event) => appendFileSync(process.env.TEST_CANCEL_WRITE, JSON.stringify(event) + '\\n');
    if (String(input).includes('/sync-state/')) {
      if (init.method === 'PUT') {
        trace({ event: 'checkpoint', state: JSON.parse(JSON.parse(init.body).value) });
        return process.env.TEST_FAIL_CHECKPOINT ? Response.json({ error: 'checkpoint failed' }, { status: 500 }) : Response.json({ ok: true });
      }
      return Response.json({ value: null });
    }
    if (String(input).endsWith('/import')) {
      trace({ event: 'import_started' });
      setTimeout(() => process.emit('SIGINT'), 20);
      await new Promise((resolve) => setTimeout(resolve, 100));
      trace({ event: 'import_completed' });
      return Response.json({ ok: true });
    }
  }
  if (String(input).includes('/v0/search/subjects?')) {
    const keyword = JSON.parse(init.body).keyword;
    return Response.json({ total: 1, data: [{ id: keyword === '新关键词' ? 8 : 7, type: 2, name: '候选作品', platform: 'TV' }] });
  }
  if (String(input).endsWith('/v0/subjects/8')) return Response.json({ id: 8, type: 2, name: '新作品', platform: 'TV', rating: { score: 0, total: 0 } });
  if (String(input).endsWith('/v0/subjects/7')) return Response.json({ id: 7, type: 2, name: '候选作品', platform: 'TV', rating: { score: 0, total: 0 } });
  throw new Error('unexpected network request');
};`,
  );
  return { dir, database, mock };
}
async function terminal(
  args: string[],
  env: Record<string, string | undefined>,
  directory: string,
  mock: string,
  steps: { prompt: string; input: string | string[] }[],
) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, cli, ...args], {
    cwd: directory,
    env,
    stdio: 'pipe',
  });
  let stdout = '',
    stderr = '',
    since = '';
  let index = 0;
  const completed = new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`交互超时：步骤 ${index}\n${stderr.slice(-3000)}`));
      }, 15000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        since += chunk;
        const step = steps[index];
        if (step && since.includes(step.prompt)) {
          index++;
          since = '';
          // 让提示完成渲染并安装监听器，再发送本次按键。
          const chunks = Array.isArray(step.input) ? step.input : [step.input];
          let next = 0;
          const writeNext = () => {
            if (child.stdin.destroyed) return;
            child.stdin.write(chunks[next++]!);
            if (next < chunks.length) setTimeout(writeNext, 30);
          };
          setTimeout(writeNext, 30);
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    },
  );
  const result = await completed;
  assert.equal(index, steps.length, result.stderr);
  return result;
}

test('CLI JSON 与非交互模式不混入界面，日志文件保留调试事件，缺少参数不创建数据库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bangumi-cli-json-'));
  const file = join(dir, 'subject.jsonlines');
  const log = join(dir, 'logs', 'run.jsonl');
  const database = join(dir, 'untouched.sqlite');
  await writeFile(file, JSON.stringify({ id: 1, type: 2, name: '测试作品' }));
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], {
      cwd: dir,
      env: { ...cleanEnv, DATABASE_PATH: database },
    });
  const result = await run([
    'sync-archive',
    '--file',
    file,
    '--dry-run',
    '--json',
    '--no-interactive',
    '--log-level',
    'silent',
    '--log-file',
    log,
  ]);
  assert.equal(JSON.parse(result.stdout).parsed, 1);
  assert(!result.stdout.includes('\u001b'));
  assert(!result.stderr.includes('选择操作'));
  const logs = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(logs.some((entry) => entry.event === 'archive_record_parsed'));
  assert(logs.some((entry) => entry.event === 'cli_completed'));
  for (const args of [
    ['sync-archive', '--no-interactive'],
    ['resolve-alias-misses', '--no-interactive'],
  ])
    await assert.rejects(
      run(args),
      (error: any) => error.code === 1 && !error.stdout && !error.stderr.includes('选择操作'),
    );
  assert.equal(existsSync(database), false);
});

test('Clack 主菜单可查看统计并返回菜单，Ctrl+C 退出且不把界面写入 stdout', async () => {
  const { dir, database, mock } = await setup();
  const result = await terminal([], { ...cleanEnv, DATABASE_PATH: database }, dir, mock, [
    { prompt: '选择操作目标', input: '\r' },
    { prompt: '选择操作（', input: '\u001b[B'.repeat(6) + '\r' },
    { prompt: '选择操作（', input: '\u0003' },
  ]);
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.stdout, '');
  assert(result.stderr.includes('暂无访问统计'));
  assert(result.stderr.includes('已取消'));
  assert(!/\u001b\[[\d;]*m/u.test(result.stderr));
});

test('Clack 文件选择默认正斜杠路径可直接确认', async () => {
  const { dir, database, mock } = await setup();
  await mkdir(join(dir, 'data'));
  await writeFile(
    join(dir, 'data', 'subject.jsonlines'),
    JSON.stringify({ id: 1, type: 2, name: '路径测试' }),
  );
  const result = await terminal(
    ['sync-archive', '--dry-run', '--json', '--limit', '1', '--skip-invalid'],
    { ...cleanEnv, DATABASE_PATH: database },
    dir,
    mock,
    [{ prompt: '选择 subject.jsonlines', input: '\r' }],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).parsed, 1);
  assert(!result.stderr.includes('No matches found'));
});

test('Clack 文件选择可输入带空格的相对或绝对路径，并用 Tab 补全后导入', async () => {
  const { dir, database, mock } = await setup();
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'data space'));
  await writeFile(
    join(dir, 'data', 'subject.jsonlines'),
    JSON.stringify({ id: 1, type: 2, name: '默认文件' }),
  );
  const selected = join(dir, 'data space', 'subject.jsonlines');
  await writeFile(
    selected,
    [2, 3].map((id) => JSON.stringify({ id, type: 2, name: `选中文件${id}` })).join('\n'),
  );
  const inputs = [
    './data space/subject.jso',
    (process.platform === 'win32' ? selected.replaceAll('\\', '/') : selected).slice(0, -5),
    ...(process.platform === 'win32'
      ? ['data space\\subject.jso', '.\\data space/subject.jso']
      : []),
  ];
  for (const input of inputs) {
    const result = await terminal(
      ['sync-archive', '--dry-run', '--json', '--limit', '10', '--skip-invalid'],
      { ...cleanEnv, DATABASE_PATH: database },
      dir,
      mock,
      [{ prompt: '选择 subject.jsonlines', input: ['\u0015', input, '\t', '\r'] }],
    );
    assert.equal(result.code, 0, `${input}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).parsed, 2, input);
  }
});

test('Clack 下一批复用参数和检查点，JSON 重定向始终为独立结果', async () => {
  const { dir, database, mock } = await setup();
  const file = join(dir, 'subject.jsonlines');
  await writeFile(
    file,
    [1, 2, 3].map((id) => JSON.stringify({ id, type: 2, name: `作品${id}` })).join('\n'),
  );
  const result = await terminal(
    ['sync-archive', '--file', file, '--as-of', '2026-10-20T00:00:00Z', '--limit', '2', '--json'],
    { ...cleanEnv, DATABASE_PATH: database },
    dir,
    mock,
    [{ prompt: '继续导入下一批', input: '\u001b[D\r' }],
  );
  assert.equal(result.code, 0, result.stderr);
  const batches = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    batches.map((b) => b.imported),
    [2, 1],
  );
  assert.equal(batches[1].complete, true);
  assert(result.stderr.includes('从第 3 行继续'));
});

test('进度动画中 SIGINT 等待当前写入并保存检查点，保存失败仍以错误退出', async () => {
  for (const failCheckpoint of [false, true]) {
    const { dir, database, mock } = await setup();
    const file = join(dir, 'subject.jsonlines');
    const trace = join(dir, 'requests.jsonl');
    await writeFile(
      file,
      [1, 2].map((id) => JSON.stringify({ id, type: 2, name: `作品${id}` })).join('\n'),
    );
    const result = await terminal(
      [
        'sync-archive',
        '--file',
        file,
        '--as-of',
        '2026-10-20T00:00:00Z',
        '--api-url',
        'https://example.com',
        '--request-retries',
        '0',
        '--json',
      ],
      {
        ...cleanEnv,
        DATABASE_PATH: database,
        ADMIN_TOKEN: 'test-admin-token-for-cli'.repeat(2),
        TEST_CANCEL_WRITE: trace,
        TEST_FAIL_CHECKPOINT: failCheckpoint ? '1' : '',
      },
      dir,
      mock,
      [],
    );
    assert(existsSync(trace), result.stderr);
    const requests = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      requests.map((r) => r.event),
      ['import_started', 'import_completed', 'checkpoint'],
    );
    assert.equal(requests[2].state.line, 1);
    assert.equal(requests[2].state.complete, false);
    assert.equal(result.code, failCheckpoint ? 1 : 130, result.stderr);
    if (failCheckpoint) {
      assert.equal(result.stdout, '');
      assert(result.stderr.includes('checkpoint failed'));
    } else
      assert.deepEqual(
        { ...JSON.parse(result.stdout) },
        {
          imported: 1,
          skipped: 0,
          skippedTotal: 0,
          line: 1,
          complete: false,
          status: 'stopped',
          errorLog: null,
        },
      );
  }
});

test('Clack 真实键盘流程：有候选时换词搜索，选择后仍绑定原别名', async () => {
  const { dir, database, mock } = await setup();
  const seed = new SqliteDriver(database);
  seed.db.exec(
    "INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at) VALUES('原别名','原别名',1,1,1)",
  );
  seed.close();
  const result = await terminal(
    ['resolve-alias-misses', '--limit', '1', '--search-limit', '2', '--json'],
    {
      ...cleanEnv,
      DATABASE_PATH: database,
      BANGUMI_USER_AGENT: 'test/ui',
      BANGUMI_ACCESS_TOKEN: '',
    },
    dir,
    mock,
    [
      { prompt: '选择匹配作品或操作', input: '\u001b[B\r' },
      { prompt: '新的搜索名称', input: '新关键词\r' },
      { prompt: '选择匹配作品或操作', input: '\r' },
    ],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resolved, 1);
  const check = new SqliteDriver(database);
  try {
    assert.deepEqual(
      check.db
        .prepare("SELECT name, subject_id FROM subject_aliases WHERE source='manual'")
        .all()
        .map((r) => ({ ...r })),
      [{ name: '原别名', subject_id: 8 }],
    );
    assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM alias_miss_stats').get()!.n, 0);
  } finally {
    check.close();
  }
});

test('TTY 自动处理未命中别名不询问参数或读取输入，跳过后继续并复用官方别名', async () => {
  const { dir, database, mock } = await setup();
  const seed = new SqliteDriver(database);
  seed.db
    .exec(`INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at)
    VALUES('不匹配','不匹配',2,1,1),('候选作品','候选作品',1,1,1)`);
  seed.close();
  const result = await terminal(
    ['resolve-alias-misses', '--auto', '--json'],
    {
      ...cleanEnv,
      DATABASE_PATH: database,
      BANGUMI_USER_AGENT: 'test/ui',
      BANGUMI_ACCESS_TOKEN: '',
    },
    dir,
    mock,
    [],
  );
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.resolved, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.status, 'completed');
  assert(result.stderr.includes('自动跳过：不匹配'));
  assert(result.stderr.includes('自动选择：候选作品'));
  assert(!result.stderr.includes('选择匹配作品或操作'));
  assert(!result.stderr.includes('本批最多处理'));
  const check = new SqliteDriver(database);
  try {
    assert.deepEqual(
      check.db
        .prepare("SELECT source FROM subject_aliases WHERE name='候选作品'")
        .all()
        .map((r) => ({ ...r })),
      [{ source: 'bangumi' }],
    );
    assert.deepEqual(
      check.db
        .prepare('SELECT name,planned FROM alias_miss_stats')
        .all()
        .map((r) => ({ ...r })),
      [{ name: '不匹配', planned: 1 }],
    );
  } finally {
    check.close();
  }
});

test('本地 CLI 按用户数量处理超过 100 条未命中别名，不重复处理跳过项', async () => {
  const { dir, database, mock } = await setup();
  const seed = new SqliteDriver(database);
  seed.db.exec(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<125)
    INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at)
    SELECT '待处理'||n,'待处理'||n,1000-n,1,1 FROM nums`);
  seed.close();
  const result = await terminal(
    ['resolve-alias-misses', '--auto', '--limit', '121', '--json', '--log-level', 'silent'],
    {
      ...cleanEnv,
      DATABASE_PATH: database,
      BANGUMI_USER_AGENT: 'test/ui',
      BANGUMI_ACCESS_TOKEN: '',
    },
    dir,
    mock,
    [],
  );
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.total, 121);
  assert.equal(summary.processed, 121);
  assert.equal(summary.skipped, 121);
  assert.deepEqual(
    summary.results.map((r: any) => r.name),
    Array.from({ length: 121 }, (_, i) => `待处理${i + 1}`),
  );
});
