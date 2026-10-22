import { normalizeName } from '../../core/matching.ts';
import { sql, type StorageDialect } from './sql.ts';

/** 跟随别名写入在同一事务中执行，仅清理本次涉及且确实可查询的名称。 */
export function clearAliasMissesStatement(dialect: StorageDialect, names: string[]) {
  const keys = [...new Set(names.map(normalizeName))];
  return sql`DELETE FROM alias_miss_stats
    WHERE normalized_name IN (${dialect.values(keys, 'text')})
      AND EXISTS (SELECT 1 FROM subject_aliases
        WHERE subject_aliases.normalized_name=alias_miss_stats.normalized_name)`;
}
