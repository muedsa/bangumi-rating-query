import type { AnimeRepository } from './ports.ts';
import type { Alias, QueryItem, Rating, Subject } from './models.ts';
import { extractSubjectId, normalizeName } from './matching.ts';

export class QueryService {
  constructor(
    private repo: AnimeRepository,
    private options: {
      statsEnabled: boolean;
      aliasMissStatsEnabled?: boolean;
      ratingTtlHours: number;
      now?: () => number;
      onStatsError?: (error: unknown) => void;
      onAliasMissStatsError?: (error: unknown) => void;
    },
  ) {}

  async batch(
    items: QueryItem[],
    onStatsError = this.options.onStatsError,
    onAliasMissStatsError = this.options.onAliasMissStatsError,
  ) {
    const now = (this.options.now ?? Date.now)();
    // 缓存仅在本次请求内复用；相同名称和形式无需在候选循环中反复归一化。
    const normalized = new Map<string, string>();
    const normalize = (value: string) => {
      let key = normalized.get(value);
      if (key === undefined) {
        key = normalizeName(value);
        normalized.set(value, key);
      }
      return key;
    };
    const parsedNames = new Map<string, { name: string; key: string; directId: number | null }>();
    const queries = items.map((item) => ({
      item,
      names: (item.subjectId === undefined ? (item.names ?? []) : []).map((name) => {
        let parsed = parsedNames.get(name);
        if (!parsed) {
          parsed = { name, key: normalize(name), directId: extractSubjectId(name) };
          parsedNames.set(name, parsed);
        }
        return parsed;
      }),
      platform: item.platform === undefined ? undefined : normalize(item.platform),
      yearPrefix: item.year === undefined ? undefined : `${item.year}-`,
    }));
    const keys = [
      ...new Set(
        queries.flatMap(({ names }) =>
          names.filter((name) => name.directId === null).map((name) => name.key),
        ),
      ),
    ];
    const aliases = await this.repo.findAliases(keys);
    const idsByKey = new Map<string, Set<number>>();
    const aliasesBySubject = new Map<number, Alias[]>();
    for (const alias of aliases) {
      let ids = idsByKey.get(alias.normalizedName);
      if (!ids) idsByKey.set(alias.normalizedName, (ids = new Set()));
      ids.add(alias.subjectId);
      let subjectAliases = aliasesBySubject.get(alias.subjectId);
      if (!subjectAliases) aliasesBySubject.set(alias.subjectId, (subjectAliases = []));
      subjectAliases.push(alias);
    }
    const directIds = queries.flatMap(({ item, names }) =>
      item.subjectId !== undefined
        ? [item.subjectId]
        : names.flatMap((name) => name.directId ?? []),
    );
    const subjects = await this.repo.findSubjects([
      ...new Set([...directIds, ...aliases.map((a) => a.subjectId)]),
    ]);
    const byId = new Map(subjects.map((s) => [s.id, s]));
    const hits = new Set<number>();
    const misses = new Map<string, string>();
    if (this.options.aliasMissStatsEnabled) {
      for (const { names } of queries) {
        for (const { name, key, directId } of names) {
          if (directId === null && !idsByKey.has(key) && !misses.has(key)) misses.set(key, name);
        }
      }
    }
    const matches = queries.map(({ item, names, platform, yearPrefix }) => {
      const groups =
        item.subjectId !== undefined
          ? [new Set([item.subjectId])]
          : names.map(({ directId, key }) =>
              directId !== null ? new Set([directId]) : (idsByKey.get(key) ?? new Set<number>()),
            );
      const nonempty = groups.filter((g) => g.size > 0);
      const union = new Set(nonempty.flatMap((g) => [...g]));
      const intersection = new Set([...union].filter((id) => nonempty.every((g) => g.has(id))));
      const conflict = nonempty.length > 1 && intersection.size === 0;
      const candidateIds = conflict ? union : intersection;
      const candidates = [...candidateIds]
        .flatMap((id) => byId.get(id) ?? [])
        .filter(
          (s) =>
            (yearPrefix === undefined || s.airDate?.startsWith(yearPrefix)) &&
            (platform === undefined || normalize(s.platform) === platform),
        )
        .sort((a, b) => a.id - b.id);
      const base = { inputId: item.inputId };
      if (!candidates.length) return { ...base, status: 'not_found' as const };
      if (conflict || candidates.length > 1)
        return {
          ...base,
          status: 'ambiguous' as const,
          matchReason: conflict ? 'conflicting_names' : 'shared_alias',
          candidates: candidates.slice(0, 20),
          candidatesTruncated: candidates.length > 20,
        };
      const subject = candidates[0]!;
      hits.add(subject.id);
      const nameKeys = new Set(names.map((name) => name.key));
      const matchedAliases =
        item.subjectId !== undefined
          ? []
          : (aliasesBySubject.get(subject.id) ?? []).filter((a) => nameKeys.has(a.normalizedName));
      return {
        ...base,
        status: 'matched' as const,
        subject,
        matchReason:
          item.subjectId !== undefined || names.some((name) => name.directId === subject.id)
            ? 'subject_id'
            : matchedAliases.some((a) => names.some((name) => name.name === a.name))
              ? 'exact_alias'
              : 'normalized_alias',
        matchedAliases: matchedAliases.map((a) => ({ name: a.name, source: a.source })),
      };
    });
    // 筛选、排序和截断完成后再去重读取评分，避免读取不会返回的候选评分。
    const ratingIds = [
      ...new Set(
        matches.flatMap((match) =>
          match.status === 'matched'
            ? [match.subject.id]
            : match.status === 'ambiguous'
              ? match.candidates.map((subject) => subject.id)
              : [],
        ),
      ),
    ];
    const ratings = new Map(
      (ratingIds.length ? await this.repo.getRatings(ratingIds) : []).map((r) => [r.subjectId, r]),
    );
    const results = matches.map((match) => {
      if (match.status === 'not_found') return match;
      if (match.status === 'ambiguous')
        return {
          ...match,
          candidates: match.candidates.map((subject) => ({
            ...publicSubject(subject),
            ...publicRating(ratings.get(subject.id), now, this.options.ratingTtlHours),
          })),
        };
      return {
        ...match,
        subject: publicSubject(match.subject),
        ...publicRating(ratings.get(match.subject.id), now, this.options.ratingTtlHours),
      };
    });
    if (this.options.statsEnabled && hits.size) {
      try {
        await this.repo.recordHits([...hits], now);
      } catch (error) {
        onStatsError?.(error);
      }
    }
    if (this.options.aliasMissStatsEnabled && misses.size) {
      try {
        await this.repo.recordAliasMisses([...misses.values()], now);
      } catch (error) {
        onAliasMissStatsError?.(error);
      }
    }
    return { results };
  }
}

function publicSubject(s: Subject) {
  return {
    id: s.id,
    name: s.name,
    nameCn: s.nameCn,
    airDate: s.airDate,
    platform: s.platform,
    url: `https://bgm.tv/subject/${s.id}`,
  };
}

function publicRating(rating: Rating | undefined, now: number, ratingTtlHours: number) {
  return {
    rating: rating
      ? { score: rating.score, votes: rating.votes, rank: rating.rank, source: rating.source }
      : null,
    ratingStatus: !rating ? 'unavailable' : rating.score === null ? 'unrated' : 'available',
    dataAsOf: rating ? new Date(rating.dataAsOf).toISOString() : null,
    stale: !rating || now - rating.dataAsOf > ratingTtlHours * 3_600_000,
  };
}
