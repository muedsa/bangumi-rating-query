import type { SQL } from 'drizzle-orm';
import type { SqlRepository } from './repository.ts';
import { sql } from './sql.ts';
import { AppError } from '../../core/models.ts';

// 每次别名变更换一个版本，避免跨请求、跨进程的旧关联查询覆盖新结果。
// 存放在现有内部状态表中，旧数据库首次写入时自动建立，不需要结构迁移。
export const ALIAS_WRITE_REVISION_KEY = 'internal:alias-write-revision';

function isRevisionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current);) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    if (
      ('code' in current &&
        current.code === '23502' &&
        'table_name' in current &&
        current.table_name === 'sync_state' &&
        'column_name' in current &&
        current.column_name === 'value') ||
      ('message' in current &&
        typeof current.message === 'string' &&
        current.message.includes('NOT NULL constraint failed: sync_state.value'))
    )
      return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** 先读取版本再生成计划；版本校验和全部业务写入在同一事务中完成。 */
export async function writeAliases(
  repo: Pick<SqlRepository, 'getState' | 'batch'>,
  prepare: () => Promise<SQL[]>,
) {
  let conflict: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** (attempt - 1)));
    const revision = await repo.getState(ALIAS_WRITE_REVISION_KEY);
    let statements: SQL[];
    try {
      statements = await prepare();
    } catch (error) {
      // 预查中的容量/存在性判断也可能已过时；仅在别名版本确实变化时重新判定。
      if (!(error instanceof AppError)) throw error;
      if ((await repo.getState(ALIAS_WRITE_REVISION_KEY)) === revision) throw error;
      conflict = error;
      continue;
    }
    if (!statements.length) return [];
    try {
      const result = await repo.batch([
        // D1 不支持交互式事务：冲突时利用 NOT NULL 约束中止整批，而不是先检查后写入。
        // PostgreSQL 的冲突更新会等待前一事务并校验其已提交版本；SQLite/D1 写事务串行执行。
        sql`INSERT INTO sync_state(key,value,updated_at)
          VALUES(${ALIAS_WRITE_REVISION_KEY},${crypto.randomUUID()},${Date.now()})
          ON CONFLICT(key) DO UPDATE SET
            value=CASE WHEN sync_state.value=${revision} THEN excluded.value ELSE NULL END,
            updated_at=excluded.updated_at`,
        ...statements,
      ]);
      return result.slice(1);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      conflict = error;
    }
  }
  throw new Error('别名并发写入冲突，多次重试后仍未完成，请稍后重试', { cause: conflict });
}
