import { AppError } from '../../core/models.ts';
import { backupSchema, type BackupRecord } from '../../core/backup.ts';
import { chunks, sql } from './sql.ts';
import type { SqlRepository } from './repository.ts';
import { clearAliasMissesStatement } from './alias-misses.ts';

export async function exportPage(repo: SqlRepository, after: number, limit = 5) {
  const ids = await repo.query<{ id: number }>(
    sql`SELECT id FROM subjects WHERE id>${after} ORDER BY id LIMIT ${limit}`,
  );
  const records: BackupRecord[] = [];
  for (const { id } of ids) {
    const subject = (await repo.findSubjects([id]))[0]!;
    const aliases = await repo.listAliases(id);
    const rating = (await repo.getRatings([id]))[0] ?? null;
    const usage =
      (
        await repo.query<BackupRecord['usage']>(
          sql`SELECT last_accessed_at AS "lastAccessedAt", total_hits AS "totalHits" FROM subject_usage WHERE subject_id=${id}`,
        )
      )[0] ?? null;
    const daily = await repo.query<BackupRecord['daily'][number]>(
      sql`SELECT day, hits FROM subject_usage_daily WHERE subject_id=${id} ORDER BY day`,
    );
    records.push({ version: 1, subject, aliases, rating, usage, daily });
  }
  return { records, nextCursor: ids.length === limit ? ids[ids.length - 1]!.id : null };
}

export async function restoreRecord(repo: SqlRepository, input: BackupRecord) {
  const record = backupSchema.parse(input);
  const s = record.subject;
  if ((await repo.findSubjects([s.id])).length)
    throw new AppError(409, 'SUBJECT_EXISTS', '恢复目标已存在该条目；请使用空库');
  const statements = [
    sql`INSERT INTO subjects(id,name,name_cn,air_date,platform,metadata_at,cached_at,pinned)
    VALUES(${s.id},${s.name},${s.nameCn},${s.airDate},${s.platform},${s.metadataAt},${s.cachedAt},${Number(s.pinned)})`,
  ];
  for (const part of chunks(record.aliases, 20)) {
    // 每条别名 7 个参数，D1 上限为 100，进一步按 10 条拆分。
    for (const aliases of chunks(part, 10))
      statements.push(sql`INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
      VALUES ${sql.join(
        aliases.map(
          (a) =>
            sql`(${a.id},${s.id},${a.name},${a.normalizedName},${a.source},${a.createdAt},${a.updatedAt})`,
        ),
        sql`, `,
      )}`);
  }
  if (record.aliases.length)
    statements.push(
      clearAliasMissesStatement(
        repo.dialect,
        record.aliases.map((alias) => alias.name),
      ),
    );
  const r = record.rating;
  if (r)
    statements.push(sql`INSERT INTO ratings_current(subject_id,score,votes,rank,source,data_as_of,fetched_at)
    VALUES(${s.id},${r.score},${r.votes},${r.rank},${r.source},${r.dataAsOf},${r.fetchedAt})`);
  if (record.usage)
    statements.push(
      sql`INSERT INTO subject_usage VALUES(${s.id},${record.usage.lastAccessedAt},${record.usage.totalHits})`,
    );
  if (record.daily.length)
    statements.push(sql`INSERT INTO subject_usage_daily(subject_id,day,hits)
    SELECT ${s.id}, ${repo.dialect.value('day')}, ${repo.dialect.value('hits', 'integer')} FROM ${repo.dialect.each(record.daily)}`);
  if (statements.length > 40)
    throw new AppError(400, 'BACKUP_TOO_LARGE', '单条备份超出事务预算，请先归档历史统计');
  await repo.batch(statements);
}
