import { AppError, type Alias } from '../../core/models.ts';
import { normalizeName } from '../../core/matching.ts';
import { seasonAlias } from '../../core/season-aliases.ts';
import type { SQL } from 'drizzle-orm';
import { sql } from './sql.ts';

type Seed = Pick<Alias, 'subjectId' | 'name' | 'source'>;
type Match = Seed & Pick<Alias, 'normalizedName'>;
type Reader = { query<T>(query: SQL): Promise<T[]> };

/** 在同一事务中写入原别名、季数互补别名及唯一匹配的第一季别名。 */
export async function aliasInsertStatement(
  repo: Reader,
  seeds: Seed[],
  now: number,
  options: {
    replaceBangumiIds?: number[];
    removeAliasId?: string;
    skipFullSubjects?: boolean;
    guard?: SQL;
  } = {},
): Promise<SQL | null> {
  if (!seeds.length) return null;
  const retained = sql`NOT (source='bangumi' AND subject_id IN (
    SELECT value FROM json_each(${JSON.stringify(options.replaceBangumiIds ?? [])})
  )) AND id <> ${options.removeAliasId ?? ''}`;
  const keys = new Set<string>();
  const secondNames = (name: string) =>
    ['', ' '].flatMap((gap) => [`${name.trim()}${gap}第二季`, `${name.trim()}${gap}第2季`]);
  for (const seed of seeds) {
    keys.add(normalizeName(seed.name));
    const season = seasonAlias(seed.name);
    if (season) {
      keys.add(normalizeName(season.counterpart));
      if (season.number === 2)
        for (const name of [season.base, ...season.firstNames]) keys.add(normalizeName(name));
    } else {
      // 第一季晚于第二季导入，或第一季上游刷新时，也能恢复已知的季数别名。
      for (const name of [
        ...secondNames(seed.name),
        `${seed.name.trim()}第一季`,
        `${seed.name.trim()}第1季`,
        `${seed.name.trim()} 第一季`,
        `${seed.name.trim()} 第1季`,
      ])
        keys.add(normalizeName(name));
    }
  }
  const existing = await repo.query<Match>(sql`SELECT subject_id AS subjectId, name,
    normalized_name AS normalizedName, source FROM subject_aliases
    WHERE ${retained} AND normalized_name IN (SELECT value FROM json_each(${JSON.stringify([...keys])}))`);
  const matches = new Map<string, Match[]>();
  const addMatch = (alias: Match) => {
    const list = matches.get(alias.normalizedName) ?? [];
    list.push(alias);
    matches.set(alias.normalizedName, list);
  };
  for (const alias of existing) addMatch(alias);
  const pending = new Map<string, Match>();
  const identity = (alias: Seed) => JSON.stringify([alias.subjectId, alias.name, alias.source]);
  const existingNames = new Set(existing.map(identity));
  const add = (seed: Seed, generated = false) => {
    const normalizedName = normalizeName(seed.name);
    if (
      generated &&
      (matches.get(normalizedName) ?? []).some((a) => a.subjectId === seed.subjectId)
    )
      return;
    if (seed.name.length > 300)
      throw new AppError(400, 'ALIAS_TOO_LONG', '季数转换后的别名超过 300 字符');
    if (existingNames.has(identity(seed)) || pending.has(identity(seed))) return;
    const alias = { ...seed, normalizedName };
    pending.set(identity(seed), alias);
    addMatch(alias);
  };
  // 先登记本批全部原名称，保证 calendar 内条目顺序不影响匹配。
  for (const seed of seeds) add(seed);
  for (const seed of seeds) {
    const season = seasonAlias(seed.name);
    if (season) add({ ...seed, name: season.counterpart }, true);
  }
  const inferFirst = (second: Seed) => {
    const season = seasonAlias(second.name);
    if (!season || season.number !== 2) return;
    const explicit = season.firstNames.flatMap((name) => matches.get(normalizeName(name)) ?? []);
    const candidates = explicit.length ? explicit : (matches.get(normalizeName(season.base)) ?? []);
    const ids = new Set(candidates.map((alias) => alias.subjectId));
    if (ids.size !== 1 || ids.has(second.subjectId)) return;
    const subjectId = [...ids][0]!;
    // 补充项继承被匹配名称的来源，手动名称衍生的别名仍受手动保护。
    const source = candidates.some((alias) => alias.source === 'manual') ? 'manual' : 'bangumi';
    for (const name of season.firstNames) add({ subjectId, name, source }, true);
  };
  for (const seed of seeds) {
    const season = seasonAlias(seed.name);
    if (season) inferFirst(seed);
    else
      for (const name of secondNames(seed.name))
        for (const second of matches.get(normalizeName(name)) ?? []) inferFirst(second);
  }
  if (!pending.size) return null;
  const ids = [...new Set([...pending.values()].map((alias) => alias.subjectId))];
  const counts = new Map(
    (
      await repo.query<{
        subjectId: number;
        count: number;
      }>(sql`SELECT subject_id AS subjectId, COUNT(*) AS count
      FROM subject_aliases WHERE ${retained} AND subject_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      GROUP BY subject_id`)
    ).map((row) => [row.subjectId, row.count]),
  );
  for (const alias of pending.values())
    counts.set(alias.subjectId, (counts.get(alias.subjectId) ?? 0) + 1);
  const full = new Set([...counts].filter(([, count]) => count > 250).map(([id]) => id));
  if (full.size && !options.skipFullSubjects)
    throw new AppError(400, 'ALIAS_LIMIT', '补充季数别名后超过单条目 250 条上限，请先整理别名');
  const additions = [...pending.values()]
    .filter((alias) => !full.has(alias.subjectId))
    .map((alias) => ({
      ...alias,
      id: crypto.randomUUID(),
    }));
  if (!additions.length) return null;
  return sql`INSERT INTO subject_aliases(id,subject_id,name,normalized_name,source,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.subjectId'),json_extract(value,'$.name'),
      json_extract(value,'$.normalizedName'),json_extract(value,'$.source'),${now},${now}
    FROM json_each(${JSON.stringify(additions)}) WHERE ${options.guard ?? sql`true`}
    ON CONFLICT(subject_id,name,source) DO NOTHING`;
}
