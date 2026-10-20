import { sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

export { sql };
export type Row = Record<string, unknown>;
export interface Statement {
  sql: string;
  params: (string | number | null)[];
}
export interface SqlDriver {
  query(statement: Statement): Promise<Row[]>;
  /** 整批语句必须原子提交或回滚。 */
  batch(statements: Statement[]): Promise<Row[][]>;
}
const dialect = new SQLiteSyncDialect();
export function compile(query: SQL): Statement {
  const result = dialect.sqlToQuery(query);
  return { sql: result.sql, params: result.params as Statement['params'] };
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
