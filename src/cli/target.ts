import type { ImportRecord } from '../core/models.ts';
import type { BackupRecord } from '../core/backup.ts';
import { SqlRepository } from '../adapters/storage/repository.ts';
import { openStorage } from '../adapters/storage/node.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import type { CalendarSource } from '../core/ports.ts';
export { remoteTarget } from './remote-target.ts';

export async function localTarget(
  env: Record<string, unknown>,
  calendarSource?: CalendarSource,
  platformBatchSize = 10,
) {
  const driver = await openStorage(env);
  const repo = new SqlRepository(driver);
  return {
    close: () => driver.close(),
    syncCalendar: () => new CalendarSyncService(repo, calendarSource, platformBatchSize).sync(),
    importRecord: (record: ImportRecord) => repo.importRecord(record),
    getState: (key: string) => repo.getState(key),
    setState: (key: string, value: string) => repo.setState(key, value),
    exportPage: (after: number) => repo.exportPage(after),
    restore: (record: BackupRecord) => repo.restoreRecord(record),
    stats: () => repo.stats(),
    aliasMisses: () => repo.aliasMissStats(),
    prune: (days: number) => repo.pruneDaily(days),
    retention: (days: number, enabled: boolean) => repo.retentionPreview(days, enabled),
    alias: (id: number, name: string) => repo.addManualAlias(id, name, Date.now()),
  };
}
