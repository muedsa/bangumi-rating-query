import { AppError } from './models.ts';
import type { ApplicationRepository, CalendarSource } from './ports.ts';
import type { CalendarSyncResult } from './calendar.ts';

export class CalendarSyncService {
  constructor(
    private repo: Pick<
      ApplicationRepository,
      'mergeCalendar' | 'findMissingPlatformIds' | 'fillPlatforms' | 'getState' | 'setState'
    >,
    private source?: CalendarSource,
    private platformBatchSize = 10,
  ) {
    if (!Number.isSafeInteger(platformBatchSize) || platformBatchSize < 1)
      throw new Error('日历作品形式补全批次必须为正整数');
  }

  async sync(): Promise<CalendarSyncResult> {
    if (!this.source)
      throw new AppError(
        503,
        'BANGUMI_SYNC_DISABLED',
        '请在服务端配置 BANGUMI_USER_AGENT 以启用同步',
      );
    let snapshot;
    try {
      snapshot = await this.source.getCalendar();
    } catch {
      throw new AppError(
        503,
        'BANGUMI_API_ERROR',
        'Bangumi 日历获取或校验失败，请检查服务端配置或稍后重试',
      );
    }
    await this.repo.mergeCalendar(snapshot);
    const ids = snapshot.items.map((item) => item.id);
    const missing = await this.repo.findMissingPlatformIds(ids);
    const updates: { id: number; platform: string }[] = [];
    const failures: number[] = [];
    if (missing.length) {
      const cursor = Number(await this.repo.getState('calendar:platform_cursor')) || 0;
      const batch = [
        ...missing.filter((id) => id > cursor),
        ...missing.filter((id) => id <= cursor),
      ].slice(0, this.platformBatchSize);
      for (const id of batch) {
        try {
          updates.push({ id, platform: await this.source.getSubjectPlatform(id) });
        } catch {
          failures.push(id);
        }
      }
      // 只补空字段，不将部分日历数据提升为完整元数据，也不覆盖并发写入的已有值。
      const platformsUpdated = await this.repo.fillPlatforms(updates);
      await this.repo.setState('calendar:platform_cursor', String(batch[batch.length - 1]!));
      const remaining = await this.repo.findMissingPlatformIds(ids);
      return {
        imported: snapshot.items.length,
        dataAsOf: new Date(snapshot.fetchedAt).toISOString(),
        platformsUpdated,
        platformsRemaining: remaining.length,
        platformFailures: failures,
        status: remaining.length ? 'partial' : 'complete',
      };
    }
    return {
      imported: snapshot.items.length,
      dataAsOf: new Date(snapshot.fetchedAt).toISOString(),
      platformsUpdated: 0,
      platformsRemaining: 0,
      platformFailures: [],
      status: 'complete',
    };
  }
}
