import type { D1Database } from '@cloudflare/workers-types';
import type { Row, SqlDriver, Statement } from './sql.ts';

export class D1Driver implements SqlDriver {
  constructor(private db: D1Database) {}
  private prepare(s: Statement) {
    return this.db.prepare(s.sql).bind(...s.params);
  }
  async query(s: Statement): Promise<Row[]> {
    const result = await this.prepare(s).all<Row>();
    if (!result.success) throw new Error('D1 查询失败');
    return result.results;
  }
  async batch(statements: Statement[]): Promise<Row[][]> {
    if (statements.length > 40) throw new Error('单次事务超出 D1 语句预算');
    const results = await this.db.batch<Row>(statements.map((s) => this.prepare(s)));
    if (results.some((r) => !r.success)) throw new Error('D1 事务失败');
    return results.map((r) => r.results);
  }
}
