import { sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { PgDialect } from 'drizzle-orm/pg-core';

export { sql };
export type Row = Record<string, unknown>;
export interface Statement {
  sql: string;
  params: (string | number | null)[];
}
export interface SqlDriver {
  readonly dialect?: 'sqlite' | 'postgres';
  query(statement: Statement): Promise<Row[]>;
  /** 整批语句必须原子提交或回滚。 */
  batch(statements: Statement[]): Promise<Row[][]>;
}
const sqliteDialect = new SQLiteSyncDialect();
const postgresDialect = new PgDialect();
export function compile(query: SQL, dialect: 'sqlite' | 'postgres' = 'sqlite'): Statement {
  const result = (dialect === 'postgres' ? postgresDialect : sqliteDialect).sqlToQuery(query);
  return { sql: result.sql, params: result.params as Statement['params'] };
}

/** 只封装方言差异，JSON 数据和路径均以参数传入。 */
export class StorageDialect {
  constructor(readonly name: 'sqlite' | 'postgres' = 'sqlite') {}
  compile(query: SQL) {
    return compile(query, this.name);
  }
  each(items: unknown[]) {
    const json = JSON.stringify(items);
    // 先按 text 绑定，避免 Postgres.js 把已序列化的 JSON 字符串再次编码为 JSON 标量。
    return this.name === 'postgres'
      ? sql`jsonb_array_elements(${json}::text::jsonb) AS entry(value)`
      : sql`json_each(${json})`;
  }
  value(path: string, type: 'text' | 'integer' | 'real' = 'text') {
    if (this.name === 'sqlite') return sql`json_extract(value, ${`$.${path}`})`;
    const parts = path.split('.');
    let value = sql`value`;
    for (const [index, part] of parts.entries())
      value = index === parts.length - 1 ? sql`${value}->>${part}` : sql`${value}->${part}`;
    if (type === 'integer') return sql`(${value})::bigint`;
    if (type === 'real') return sql`(${value})::double precision`;
    return sql`(${value})`;
  }
  values(items: string[] | number[], type: 'text' | 'integer') {
    if (this.name === 'sqlite') return sql`SELECT value FROM ${this.each(items)}`;
    const value = type === 'integer' ? sql`value::bigint` : sql`value`;
    return sql`SELECT ${value} FROM jsonb_array_elements_text(${JSON.stringify(items)}::text::jsonb) AS entry(value)`;
  }
}

export function isUniqueViolation(error: unknown) {
  return (
    String(error).includes('UNIQUE constraint') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
  );
}
export function chunks<T>(items: T[], size = 80): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size)
    result.push(items.slice(offset, offset + size));
  return result;
}
export function list(items: (string | number)[]) {
  return sql.join(
    items.map((v) => sql`${v}`),
    sql`, `,
  );
}
