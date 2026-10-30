import type { SQL } from 'drizzle-orm';
import type { AliasMiss, ApplicationRepository } from '../../core/ports.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { BackupRecord } from '../../core/backup.ts';
import { calendarSnapshotSchema, type CalendarSnapshot } from '../../core/calendar.ts';
import { exportPage, restoreRecord } from './backup.ts';
import {
  AppError,
  type Alias,
  type ImportRecord,
  type Rating,
  type Subject,
} from '../../core/models.ts';
import { normalizeName } from '../../core/matching.ts';
import {
  chunks,
  isUniqueViolation,
  list,
  sql,
  StorageDialect,
  type Row,
  type SqlDriver,
} from './sql.ts';
import { aliasInsertStatements } from './season-aliases.ts';
import { writeAliases } from './alias-write.ts';

const subjectColumns = sql`id, name, name_cn AS "nameCn", air_date AS "airDate", platform,
  metadata_at AS "metadataAt", cached_at AS "cachedAt", pinned`;
const aliasColumns = sql`id, subject_id AS "subjectId", name, normalized_name AS "normalizedName",
  source, created_at AS "createdAt", updated_at AS "updatedAt"`;
const ratingColumns = sql`subject_id AS "subjectId", score, votes, rank, source,
  data_as_of AS "dataAsOf", fetched_at AS "fetchedAt"`;
const aliasMissColumns = sql`name, normalized_name AS "normalizedName", miss_count AS "missCount",
  first_missed_at AS "firstMissedAt", last_missed_at AS "lastMissedAt", planned`;

export class SqlRepository implements ApplicationRepository {
  readonly dialect: StorageDialect;
  constructor(public readonly driver: SqlDriver) {
    this.dialect = new StorageDialect(driver.dialect);
  }
  async query<T>(q: SQL): Promise<T[]> {
    return (await this.driver.query(this.dialect.compile(q))) as T[];
  }
  batch(statements: SQL[]) {
    return this.driver.batch(statements.map((statement) => this.dialect.compile(statement)));
  }
  writeAliases(prepare: () => Promise<SQL[]>) {
    return writeAliases(this, prepare);
  }
  exportPage(after: number) {
    return exportPage(this, after);
  }
  restoreRecord(record: BackupRecord) {
    return restoreRecord(this, record);
  }
  async findMissingPlatformIds(ids: number[]) {
    if (!ids.length) return [];
    const rows = await this.query<{ id: number }>(sql`SELECT id FROM subjects
      WHERE trim(platform)='' AND id IN (${this.dialect.values(ids, 'integer')}) ORDER BY id`);
    return rows.map((row) => row.id);
  }
  async fillPlatforms(items: { id: number; platform: string }[]) {
    if (!items.length) return 0;
    const rows = await this.query(sql`UPDATE subjects SET platform=(
      SELECT ${this.dialect.value('platform')} FROM ${this.dialect.each(items)} WHERE ${this.dialect.value('id', 'integer')}=subjects.id
    ) WHERE trim(platform)='' AND id IN (
      SELECT ${this.dialect.value('id', 'integer')} FROM ${this.dialect.each(items)}
    ) RETURNING id`);
    return rows.length;
  }
  async mergeCalendar(input: CalendarSnapshot) {
    await this.writeAliases(() => this.calendarStatements(input));
  }
  private async calendarStatements(input: CalendarSnapshot) {
    const snapshot = calendarSnapshotSchema.parse(input);
    const now = snapshot.fetchedAt;
    const items = [...new Map(snapshot.items.map((item) => [item.id, item])).values()];
    const aliases = items.flatMap((item) =>
      [...new Set([item.name, item.nameCn].filter(Boolean))].map((name) => ({
        subjectId: item.id,
        name,
        source: 'bangumi' as const,
      })),
    );
    const statements: SQL[] = [];
    const d = this.dialect;
    // 使用 JSON 参数批量导入，避免每个条目消耗多次 D1 查询。
    if (items.length)
      statements.push(sql`INSERT INTO subjects(id,name,name_cn,air_date,platform,metadata_at,cached_at,pinned)
      SELECT ${d.value('id', 'integer')},${d.value('name')},${d.value('nameCn')},
        ${d.value('airDate')},'',0,${now},0 FROM ${d.each(items)} WHERE true
      ON CONFLICT(id) DO NOTHING`);
    // 日历只有名称；只补充名称，绝不删除已有官方/手动别名。
    statements.push(
      ...(await aliasInsertStatements(this, aliases, now, { skipFullSubjects: true })),
    );
    const ratings = items.filter((item) => item.rating !== null);
    if (ratings.length)
      statements.push(sql`INSERT INTO ratings_current(subject_id,score,votes,rank,source,data_as_of,fetched_at)
      SELECT ${d.value('id', 'integer')},${d.value('rating.score', 'real')},${d.value('rating.votes', 'integer')},
        NULL,'api',${now},${now} FROM ${d.each(ratings)} WHERE true
      ON CONFLICT(subject_id) DO UPDATE SET score=excluded.score,votes=excluded.votes,
        source=excluded.source,data_as_of=excluded.data_as_of,fetched_at=excluded.fetched_at
      WHERE excluded.data_as_of > ratings_current.data_as_of`);
    statements.push(sql`INSERT INTO sync_state(key,value,updated_at)
      VALUES('calendar:last_sync',${JSON.stringify({ imported: items.length, dataAsOf: new Date(now).toISOString() })},${now})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      WHERE excluded.updated_at >= sync_state.updated_at`);
    return statements;
  }
  async ready() {
    const rows = await this.query<{ version: number }>(sql`SELECT version FROM schema_version`);
    return rows.length === 1 && rows[0]?.version === SCHEMA_VERSION;
  }
  async findSubjects(ids: number[]): Promise<Subject[]> {
    const rows: Subject[] = [];
    for (const part of chunks([...new Set(ids)]))
      rows.push(
        ...(await this.query<Subject>(
          sql`SELECT ${subjectColumns} FROM subjects WHERE id IN (${list(part)})`,
        )),
      );
    return rows.map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
  }
  async findAliases(keys: string[]): Promise<Alias[]> {
    const rows: Alias[] = [];
    // 每个 key 的候选上限防止异常同名数据造成无界响应；超限拒绝自动匹配。
    for (const part of chunks([...new Set(keys)])) {
      const found = await this.query<Alias>(
        sql`SELECT ${aliasColumns} FROM subject_aliases WHERE normalized_name IN (${list(part)}) LIMIT 1001`,
      );
      if (found.length > 1000)
        throw new AppError(400, 'TOO_MANY_CANDIDATES', '候选过多，请缩小批次或使用条目 ID');
      rows.push(...found);
      if (rows.length > 1000)
        throw new AppError(400, 'TOO_MANY_CANDIDATES', '候选过多，请使用条目 ID');
    }
    return rows;
  }
  listAliases(id: number) {
    return this.query<Alias>(
      sql`SELECT ${aliasColumns} FROM subject_aliases WHERE subject_id = ${id} ORDER BY source, name`,
    );
  }
  async getRatings(ids: number[]): Promise<Rating[]> {
    const rows: Rating[] = [];
    for (const part of chunks([...new Set(ids)]))
      rows.push(
        ...(await this.query<Rating>(
          sql`SELECT ${ratingColumns} FROM ratings_current WHERE subject_id IN (${list(part)})`,
        )),
      );
    return rows;
  }
  async addManualAlias(subjectId: number, name: string, now: number) {
    await this.writeAliases(() =>
      aliasInsertStatements(this, [{ subjectId, name, source: 'manual' }], now),
    );
    const rows = await this.query<Alias>(sql`SELECT ${aliasColumns} FROM subject_aliases
      WHERE subject_id=${subjectId} AND name=${name}`);
    return rows[0]!;
  }
  async updateManualAlias(id: string, name: string, now: number) {
    try {
      const rows = await this.writeAliases(() => this.manualAliasStatements(id, name, now));
      return (rows[0]?.[0] as Alias | undefined) ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'ALIAS_EXISTS', '该条目已有相同别名');
      throw error;
    }
  }
  private async manualAliasStatements(id: string, name: string, now: number) {
    const original = (
      await this.query<Alias>(
        sql`SELECT ${aliasColumns} FROM subject_aliases WHERE id=${id} AND source='manual'`,
      )
    )[0];
    if (!original) return [];
    const aliasStatements = await aliasInsertStatements(
      this,
      [{ subjectId: original.subjectId, name, source: 'manual' }],
      now,
      {
        removeAliasId: id,
        guard: sql`EXISTS (SELECT 1 FROM subject_aliases WHERE id=${id} AND source='manual')`,
      },
    );
    // 重名更新交给唯一约束处理，避免静默合并不同 aliasId。
    return [
      sql`UPDATE subject_aliases SET name = ${name}, normalized_name = ${normalizeName(name)},
        updated_at = ${now} WHERE id = ${id} AND source = 'manual' RETURNING ${aliasColumns}`,
      ...aliasStatements,
    ];
  }
  async deleteManualAlias(id: string) {
    const rows = await this.writeAliases(async () => [
      sql`DELETE FROM subject_aliases WHERE id = ${id} AND source = 'manual' RETURNING id`,
    ]);
    return (rows[0]?.length ?? 0) > 0;
  }
  async importRecord(record: ImportRecord) {
    await this.writeAliases(() => this.importStatements(record));
  }
  private async importStatements(record: ImportRecord) {
    const s = record.subject;
    const names = [...new Set([s.name, s.nameCn, ...record.aliases].filter(Boolean))];
    const existing = (await this.findSubjects([s.id]))[0];
    const statements: SQL[] = [];
    if (!existing || s.metadataAt > existing.metadataAt) {
      statements.push(sql`INSERT INTO subjects (id, name, name_cn, air_date, platform, metadata_at, cached_at, pinned)
        VALUES (${s.id}, ${s.name}, ${s.nameCn}, ${s.airDate}, ${s.platform}, ${s.metadataAt}, ${s.cachedAt}, ${Number(s.pinned)})
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_cn=excluded.name_cn, air_date=excluded.air_date,
          platform=excluded.platform, metadata_at=excluded.metadata_at
        WHERE excluded.metadata_at > subjects.metadata_at`);
      statements.push(sql`DELETE FROM subject_aliases WHERE subject_id=${s.id} AND source='bangumi'
        AND EXISTS (SELECT 1 FROM subjects WHERE id=${s.id} AND metadata_at=${s.metadataAt})`);
      const aliasStatements = await aliasInsertStatements(
        this,
        names.map((name) => ({ subjectId: s.id, name, source: 'bangumi' })),
        s.cachedAt,
        {
          replaceBangumiIds: [s.id],
          guard: sql`EXISTS (SELECT 1 FROM subjects WHERE id=${s.id} AND metadata_at=${s.metadataAt})`,
        },
      );
      statements.push(...aliasStatements);
    }
    const r = record.rating;
    if (r) {
      const previous = (await this.getRatings([s.id]))[0];
      if (!previous || r.dataAsOf > previous.dataAsOf)
        statements.push(sql`INSERT INTO ratings_current
        (subject_id, score, votes, rank, source, data_as_of, fetched_at)
        VALUES (${s.id}, ${r.score}, ${r.votes}, ${r.rank}, ${r.source}, ${r.dataAsOf}, ${r.fetchedAt})
        ON CONFLICT(subject_id) DO UPDATE SET score=excluded.score, votes=excluded.votes, rank=excluded.rank,
          source=excluded.source, data_as_of=excluded.data_as_of, fetched_at=excluded.fetched_at
        WHERE excluded.data_as_of > ratings_current.data_as_of`);
    }
    return statements;
  }
  async recordHits(ids: number[], now: number) {
    const day = new Date(now).toISOString().slice(0, 10);
    const statements: SQL[] = [];
    for (const part of chunks([...new Set(ids)], 20)) {
      statements.push(sql`INSERT INTO subject_usage (subject_id, last_accessed_at, total_hits)
        VALUES ${sql.join(
          part.map((id) => sql`(${id}, ${now}, 1)`),
          sql`, `,
        )}
        ON CONFLICT(subject_id) DO UPDATE SET total_hits=subject_usage.total_hits+1,
          last_accessed_at=CASE WHEN subject_usage.last_accessed_at > excluded.last_accessed_at
            THEN subject_usage.last_accessed_at ELSE excluded.last_accessed_at END`);
      statements.push(sql`INSERT INTO subject_usage_daily (subject_id, day, hits)
        VALUES ${sql.join(
          part.map((id) => sql`(${id}, ${day}, 1)`),
          sql`, `,
        )}
        ON CONFLICT(subject_id, day) DO UPDATE SET hits=subject_usage_daily.hits+1`);
    }
    if (statements.length) await this.batch(statements);
  }
  async getState(key: string) {
    return (
      (await this.query<{ value: string }>(sql`SELECT value FROM sync_state WHERE key=${key}`))[0]
        ?.value ?? null
    );
  }
  async recordAliasMisses(names: string[], now: number) {
    const unique = new Map(names.map((name) => [normalizeName(name), name.trim()]));
    if (!unique.size) return;
    const d = this.dialect;
    const items = [...unique].map(([normalizedName, name]) => ({ normalizedName, name }));
    // 查询与计数之间可能已补充别名；写入前重新检查，避免延迟计数重建已清理的记录。
    await this
      .query(sql`INSERT INTO alias_miss_stats(normalized_name,name,miss_count,first_missed_at,last_missed_at)
      SELECT ${d.value('normalizedName')},${d.value('name')},1,${now},${now} FROM ${d.each(items)}
      WHERE NOT EXISTS (SELECT 1 FROM subject_aliases WHERE normalized_name=${d.value('normalizedName')})
      ON CONFLICT(normalized_name) DO UPDATE SET miss_count=alias_miss_stats.miss_count+1,
        name=CASE WHEN excluded.last_missed_at >= alias_miss_stats.last_missed_at THEN excluded.name ELSE alias_miss_stats.name END,
        first_missed_at=CASE WHEN excluded.first_missed_at < alias_miss_stats.first_missed_at THEN excluded.first_missed_at ELSE alias_miss_stats.first_missed_at END,
        last_missed_at=CASE WHEN excluded.last_missed_at > alias_miss_stats.last_missed_at THEN excluded.last_missed_at ELSE alias_miss_stats.last_missed_at END`);
  }
  async aliasMissStats(planned?: boolean, limit = 100) {
    const rows = await this.query<AliasMiss>(sql`SELECT ${aliasMissColumns} FROM alias_miss_stats
      ${planned === undefined ? sql`` : sql`WHERE planned=${Number(planned)}`}
      ORDER BY miss_count DESC, last_missed_at DESC, normalized_name LIMIT ${limit}`);
    return rows.map((row) => ({ ...row, planned: Boolean(row.planned) }));
  }
  async setAliasMissPlanned(name: string, planned: boolean) {
    const rows = await this
      .query<AliasMiss>(sql`UPDATE alias_miss_stats SET planned=${Number(planned)}
      WHERE normalized_name=${normalizeName(name)} RETURNING ${aliasMissColumns}`);
    return rows[0] ? { ...rows[0], planned: Boolean(rows[0].planned) } : null;
  }
  async setState(key: string, value: string) {
    await this
      .query(sql`INSERT INTO sync_state(key, value, updated_at) VALUES (${key}, ${value}, ${Date.now()})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  }
  async stats(now = Date.now()) {
    const since7 = new Date(now - 6 * 86400000).toISOString().slice(0, 10);
    const since30 = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
    return this
      .query<Row>(sql`SELECT u.subject_id AS "subjectId", s.name, u.total_hits AS "totalHits",
      u.last_accessed_at AS "lastAccessedAt",
      COALESCE(SUM(CASE WHEN d.day >= ${since7} THEN d.hits ELSE 0 END),0) AS "hits7d",
      COALESCE(SUM(d.hits),0) AS "hits30d"
      FROM subject_usage u JOIN subjects s ON s.id=u.subject_id
      LEFT JOIN subject_usage_daily d ON d.subject_id=u.subject_id AND d.day>=${since30}
      GROUP BY u.subject_id, s.name, u.total_hits, u.last_accessed_at ORDER BY "hits30d" DESC, u.subject_id LIMIT 100`);
  }
  async retentionPreview(days: number, statsEnabled: boolean, now = Date.now()) {
    if (!statsEnabled)
      return {
        actionable: false,
        reason: '访问统计已关闭，不能根据缺失的访问数据判断冷数据',
        candidates: [],
      };
    const cutoff = now - days * 86400000;
    const candidates = await this.query<Row>(sql`SELECT s.id, s.name, s.cached_at AS "cachedAt",
      u.last_accessed_at AS "lastAccessedAt" FROM subjects s LEFT JOIN subject_usage u ON u.subject_id=s.id
      WHERE s.pinned=0 AND s.cached_at < ${cutoff} AND COALESCE(u.last_accessed_at, s.cached_at) < ${cutoff}
      ORDER BY s.id LIMIT 100`);
    return { actionable: false, reason: '仅预览；统计可能不完整，首版不自动删除', candidates };
  }
  async pruneDaily(days: number, now = Date.now()) {
    const cutoff = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);
    const rows = await this.query(sql`DELETE FROM subject_usage_daily WHERE (subject_id, day) IN (
      SELECT subject_id, day FROM subject_usage_daily WHERE day < ${cutoff} ORDER BY day, subject_id LIMIT 1000
    ) RETURNING subject_id`);
    return { deleted: rows.length, hasMore: rows.length === 1000 };
  }
}
