import { importSchema, type ImportRecord } from '../../core/models.ts';
import {
  TRENDS_PAGE_SIZE,
  trendsSyncResultSchema,
  type TrendsSyncResult,
} from '../../core/trends.ts';
import type { SqlRepository } from './repository.ts';
import { aliasInsertStatements } from './season-aliases.ts';
import { sql } from './sql.ts';
import type { SQL } from 'drizzle-orm';

/** 一批详情共用版本检查、别名规划和事务，避免逐条导入耗尽免费 D1 查询额度。 */
export async function mergeTrends(
  repo: SqlRepository,
  input: ImportRecord[],
  summary: TrendsSyncResult,
) {
  const records = input.map((record) => importSchema.parse(record));
  const result = trendsSyncResultSchema.parse(summary);
  if (
    records.length > TRENDS_PAGE_SIZE ||
    new Set(records.map((r) => r.subject.id)).size !== records.length
  )
    throw new Error('热度同步批次过大或包含重复条目');
  const now = Date.parse(result.dataAsOf);
  const d = repo.dialect;
  await repo.writeAliases(async () => {
    const existing = new Map(
      (await repo.findSubjects(records.map((r) => r.subject.id))).map((s) => [s.id, s]),
    );
    const metadata = records.filter(
      (r) =>
        !existing.has(r.subject.id) ||
        r.subject.metadataAt > existing.get(r.subject.id)!.metadataAt,
    );
    const subjects = metadata.map((r) => ({ ...r.subject, pinned: Number(r.subject.pinned) }));
    const ids = subjects.map((s) => s.id);
    const statements: SQL[] = [];
    if (subjects.length) {
      statements.push(sql`INSERT INTO subjects(id,name,name_cn,air_date,platform,metadata_at,cached_at,pinned)
        SELECT ${d.value('id', 'integer')},${d.value('name')},${d.value('nameCn')},${d.value('airDate')},
          ${d.value('platform')},${d.value('metadataAt', 'integer')},${d.value('cachedAt', 'integer')},${d.value('pinned', 'integer')}
        FROM ${d.each(subjects)} WHERE true
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_cn=excluded.name_cn,air_date=excluded.air_date,
          platform=excluded.platform,metadata_at=excluded.metadata_at
        WHERE excluded.metadata_at > subjects.metadata_at`);
      statements.push(
        sql`DELETE FROM subject_aliases WHERE source='bangumi' AND subject_id IN (${d.values(ids, 'integer')})`,
      );
      // 别名版本锁涵盖所有元数据写入；同批全部名称一起规划，顺序不影响季数补全。
      statements.push(
        ...(await aliasInsertStatements(
          repo,
          metadata.flatMap((r) =>
            [...new Set([r.subject.name, r.subject.nameCn, ...r.aliases].filter(Boolean))].map(
              (name) => ({
                subjectId: r.subject.id,
                name,
                source: 'bangumi' as const,
              }),
            ),
          ),
          now,
          { replaceBangumiIds: ids },
        )),
      );
    }
    const ratings = records.flatMap((r) => (r.rating ? [r.rating] : []));
    if (ratings.length)
      statements.push(sql`INSERT INTO ratings_current(subject_id,score,votes,rank,source,data_as_of,fetched_at)
        SELECT ${d.value('subjectId', 'integer')},${d.value('score', 'real')},${d.value('votes', 'integer')},
          ${d.value('rank', 'integer')},${d.value('source')},${d.value('dataAsOf', 'integer')},${d.value('fetchedAt', 'integer')}
        FROM ${d.each(ratings)} WHERE true
        ON CONFLICT(subject_id) DO UPDATE SET score=excluded.score,votes=excluded.votes,rank=excluded.rank,
          source=excluded.source,data_as_of=excluded.data_as_of,fetched_at=excluded.fetched_at
        WHERE excluded.data_as_of > ratings_current.data_as_of`);
    statements.push(sql`INSERT INTO sync_state(key,value,updated_at)
      VALUES('trends:last_sync',${JSON.stringify(result)},${now})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      WHERE excluded.updated_at >= sync_state.updated_at`);
    return statements;
  });
}
