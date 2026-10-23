import type { AnimeRepository } from './ports.ts';
import type { QueryItem, Subject } from './models.ts';
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
    const keys = [
      ...new Set(
        items
          .flatMap((item) => (item.subjectId === undefined ? (item.names ?? []) : []))
          .filter((name) => extractSubjectId(name) === null)
          .map(normalizeName),
      ),
    ];
    const aliases = await this.repo.findAliases(keys);
    const directIds = items.flatMap((item) =>
      item.subjectId
        ? [item.subjectId]
        : (item.names ?? []).flatMap((name) => extractSubjectId(name) ?? []),
    );
    const subjects = await this.repo.findSubjects([
      ...new Set([...directIds, ...aliases.map((a) => a.subjectId)]),
    ]);
    const byId = new Map(subjects.map((s) => [s.id, s]));
    const ratings = new Map(
      (await this.repo.getRatings(subjects.map((s) => s.id))).map((r) => [r.subjectId, r]),
    );
    const hits = new Set<number>();
    const misses = new Map<string, string>();
    if (this.options.aliasMissStatsEnabled) {
      const known = new Set(aliases.map((alias) => alias.normalizedName));
      for (const item of items) {
        if (item.subjectId) continue;
        for (const name of item.names ?? []) {
          const key = normalizeName(name);
          if (!extractSubjectId(name) && !known.has(key) && !misses.has(key)) misses.set(key, name);
        }
      }
    }
    const results = items.map((item) => {
      const groups = item.subjectId
        ? [new Set([item.subjectId])]
        : (item.names ?? []).map((name) => {
            const direct = extractSubjectId(name);
            return direct
              ? new Set([direct])
              : new Set(
                  aliases
                    .filter((a) => a.normalizedName === normalizeName(name))
                    .map((a) => a.subjectId),
                );
          });
      const nonempty = groups.filter((g) => g.size > 0);
      const union = new Set(nonempty.flatMap((g) => [...g]));
      const intersection = new Set([...union].filter((id) => nonempty.every((g) => g.has(id))));
      const conflict = nonempty.length > 1 && intersection.size === 0;
      const candidateIds = conflict ? union : intersection;
      const candidates = [...candidateIds]
        .flatMap((id) => byId.get(id) ?? [])
        .filter(
          (s) =>
            (item.year === undefined || s.airDate?.startsWith(`${item.year}-`)) &&
            (item.platform === undefined ||
              normalizeName(s.platform) === normalizeName(item.platform)),
        )
        .sort((a, b) => a.id - b.id);
      const base = { inputId: item.inputId };
      if (!candidates.length) return { ...base, status: 'not_found' as const };
      if (conflict || candidates.length > 1)
        return {
          ...base,
          status: 'ambiguous' as const,
          matchReason: conflict ? 'conflicting_names' : 'shared_alias',
          candidates: candidates.slice(0, 20).map(publicSubject),
          candidatesTruncated: candidates.length > 20,
        };
      const subject = candidates[0]!;
      const rating = ratings.get(subject.id);
      hits.add(subject.id);
      const matchedAliases =
        item.subjectId !== undefined
          ? []
          : aliases.filter(
              (a) =>
                a.subjectId === subject.id &&
                item.names?.some((n) => normalizeName(n) === a.normalizedName),
            );
      return {
        ...base,
        status: 'matched' as const,
        subject: publicSubject(subject),
        matchReason:
          item.subjectId || item.names?.some((n) => extractSubjectId(n) === subject.id)
            ? 'subject_id'
            : matchedAliases.some((a) => item.names?.includes(a.name))
              ? 'exact_alias'
              : 'normalized_alias',
        matchedAliases: matchedAliases.map((a) => ({ name: a.name, source: a.source })),
        rating: rating
          ? { score: rating.score, votes: rating.votes, rank: rating.rank, source: rating.source }
          : null,
        ratingStatus: !rating ? 'unavailable' : rating.score === null ? 'unrated' : 'available',
        dataAsOf: rating ? new Date(rating.dataAsOf).toISOString() : null,
        stale: !rating || now - rating.dataAsOf > this.options.ratingTtlHours * 3_600_000,
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
