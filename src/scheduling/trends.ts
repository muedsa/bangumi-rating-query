import type { TrendsSyncService } from '../core/trends-sync-service.ts';
import { createServerErrorLogger, type ServerErrorLogger } from '../observability/errors.ts';
import { startDailySchedule } from './daily.ts';

export async function runTrendsJob(
  sync: Pick<TrendsSyncService, 'sync'>,
  logError: ServerErrorLogger = createServerErrorLogger(),
) {
  const context = { trigger: 'scheduled' as const, requestId: crypto.randomUUID() };
  try {
    const result = await sync.sync((subjectId, error) =>
      logError('trends_subject_failed', error, { ...context, subjectId }),
    );
    console.log(
      JSON.stringify({
        event: result.status === 'partial' ? 'trends_sync_partial' : 'trends_sync_complete',
        ...context,
        ...result,
      }),
    );
    return result;
  } catch (error) {
    logError('trends_sync_failed', error, context);
    throw new Error('Bangumi 热度定时同步失败');
  }
}

export function startTrendsSchedule(
  sync: Pick<TrendsSyncService, 'sync'>,
  hourUtc: number,
  logError?: ServerErrorLogger,
) {
  return startDailySchedule(() => runTrendsJob(sync, logError), hourUtc);
}
