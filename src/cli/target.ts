import type { ImportRecord } from '../core/models.ts';
import type { BackupRecord } from '../core/backup.ts';
import { SqlRepository } from '../adapters/storage/repository.ts';
import { openStorage } from '../adapters/storage/node.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import type { CalendarSource, SubjectSource, SubjectSearchSource } from '../core/ports.ts';
import { SubjectSyncService } from '../core/sync-service.ts';
import { searchSubjects } from '../core/subject-search.ts';
export { remoteTarget } from './remote-target.ts';

export async function localTarget(
  env: Record<string, unknown>,
  source?: CalendarSource & SubjectSource & SubjectSearchSource,
  platformBatchSize = 10,
) {
  const driver = await openStorage(env);
  const repo = new SqlRepository(driver);
  return {
    close: () => driver.close(),
    syncCalendar: () => new CalendarSyncService(repo, source, platformBatchSize).sync(),
    syncSubject: (id: number) => new SubjectSyncService(repo, source).sync(id),
    searchSubjects: (keyword: string, limit: number) => searchSubjects(source, keyword, limit),
    importRecord: (record: ImportRecord) => repo.importRecord(record),
    getState: (key: string) => repo.getState(key),
    setState: (key: string, value: string) => repo.setState(key, value),
    exportPage: (after: number) => repo.exportPage(after),
    restore: (record: BackupRecord) => repo.restoreRecord(record),
    stats: () => repo.stats(),
    aliasMisses: (planned?: boolean, limit?: number) => repo.aliasMissStats(planned, limit),
    getAliasMiss: (name: string) => repo.getAliasMiss(name),
    setAliasMissPlanned: (name: string, planned: boolean) =>
      repo.setAliasMissPlanned(name, planned),
    prune: (days: number) => repo.pruneDaily(days),
    retention: (days: number, enabled: boolean) => repo.retentionPreview(days, enabled),
    alias: (id: number, name: string) => repo.addManualAlias(id, name, Date.now()),
  };
}
