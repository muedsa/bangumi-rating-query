import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Row, SqlDriver, Statement } from './sql.ts';

// int8 和 SUM(bigint) 的 numeric 结果必须与 SQLite 的 JSON number 契约一致。
// 超过安全整数范围时拒绝返回，避免静默丢失精度。
export function parsePostgresInteger(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('PostgreSQL 整数超出 JavaScript 安全范围');
  return result;
}

type Query = (statement: Statement) => Promise<Row[]>;

/** 调用方持有事务；锁保护多个实例同时初始化空库。 */
export async function migratePostgres(query: Query, directory = 'migrations/postgres') {
  await query({ sql: 'SELECT pg_advisory_xact_lock(1650943853, 1)', params: [] });
  const table = await query({ sql: "SELECT to_regclass('schema_version') AS name", params: [] });
  if (table[0]?.name) {
    const versions = await query({ sql: 'SELECT version FROM schema_version', params: [] });
    if (versions.length !== 1 || versions[0]?.version !== 1) throw new Error('不支持的数据库版本');
    return;
  }
  const migration = await readFile(resolve(directory, '0001_initial.sql'), 'utf8');
  // 初始迁移仅含普通 DDL；逐条执行，兼容预编译查询协议。
  for (const sql of migration
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await query({ sql, params: [] });
}

export class PostgresDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;
  private readonly client;

  constructor(url: string, poolSize = 10) {
    this.client = postgres(url, {
      max: poolSize,
      connect_timeout: 10,
      idle_timeout: 20,
      connection: { statement_timeout: 30000 },
      types: {
        safeInteger: {
          to: 20,
          from: [20, 1700],
          serialize: String,
          parse: parsePostgresInteger,
        },
      },
      onnotice: () => {},
    });
  }

  async query(statement: Statement): Promise<Row[]> {
    return Array.from(await this.client.unsafe<Row[]>(statement.sql, statement.params));
  }

  async batch(statements: Statement[]): Promise<Row[][]> {
    if (!statements.length) return [];
    return this.client.begin(async (transaction) => {
      const results: Row[][] = [];
      for (const statement of statements)
        results.push(Array.from(await transaction.unsafe<Row[]>(statement.sql, statement.params)));
      return results;
    });
  }

  async migrate(directory = 'migrations/postgres') {
    await this.client.begin(async (transaction) => {
      await migratePostgres(
        async (statement) =>
          Array.from(await transaction.unsafe<Row[]>(statement.sql, statement.params)),
        directory,
      );
    });
  }

  async close() {
    await this.client.end({ timeout: 5 });
  }
}
