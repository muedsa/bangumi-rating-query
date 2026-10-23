import type { Alias, ImportRecord, Rating, Subject } from './models.ts';
import type { BackupPage, BackupRecord } from './backup.ts';
import type { CalendarSnapshot } from './calendar.ts';
import type { SubjectSearchResult } from './subject-search.ts';

export interface AliasMiss {
  name: string;
  normalizedName: string;
  missCount: number;
  firstMissedAt: number;
  lastMissedAt: number;
  planned: boolean;
}

export interface SubjectSource {
  getSubject(id: number): Promise<ImportRecord>;
}

export interface SubjectSearchSource {
  searchSubjects(keyword: string, limit: number): Promise<SubjectSearchResult>;
}

export interface CalendarSource {
  getCalendar(): Promise<CalendarSnapshot>;
  getSubjectPlatform(id: number): Promise<string>;
}

export interface AnimeRepository {
  ready(): Promise<boolean>;
  findSubjects(ids: number[]): Promise<Subject[]>;
  findAliases(keys: string[]): Promise<Alias[]>;
  listAliases(subjectId: number): Promise<Alias[]>;
  getRatings(ids: number[]): Promise<Rating[]>;
  /** 同条目已有完全同名别名时返回原记录，来源可能为 bangumi。 */
  addManualAlias(subjectId: number, name: string, now: number): Promise<Alias>;
  updateManualAlias(id: string, name: string, now: number): Promise<Alias | null>;
  deleteManualAlias(id: string): Promise<boolean>;
  importRecord(record: ImportRecord): Promise<void>;
  recordHits(ids: number[], now: number): Promise<void>;
  recordAliasMisses(names: string[], now: number): Promise<void>;
}

/** HTTP 层依赖完整业务存储契约，而不是具体 SQL 驱动。 */
export interface ApplicationRepository extends AnimeRepository {
  mergeCalendar(snapshot: CalendarSnapshot): Promise<void>;
  findMissingPlatformIds(ids: number[]): Promise<number[]>;
  fillPlatforms(items: { id: number; platform: string }[]): Promise<number>;
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  exportPage(after: number): Promise<BackupPage>;
  restoreRecord(record: BackupRecord): Promise<void>;
  stats(): Promise<Record<string, unknown>[]>;
  aliasMissStats(planned?: boolean): Promise<AliasMiss[]>;
  setAliasMissPlanned(name: string, planned: boolean): Promise<AliasMiss | null>;
  pruneDaily(days: number): Promise<{ deleted: number; hasMore: boolean }>;
  retentionPreview(
    days: number,
    enabled: boolean,
  ): Promise<{
    actionable: boolean;
    reason: string;
    candidates: Record<string, unknown>[];
  }>;
}
