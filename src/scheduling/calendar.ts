import type { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { createServerErrorLogger, type ServerErrorLogger } from '../observability/errors.ts';
import { startDailySchedule } from './daily.ts';

export { millisecondsUntilDailyHour } from './daily.ts';

export async function runCalendarJob(
  sync: Pick<CalendarSyncService, 'sync'>,
  logError: ServerErrorLogger = createServerErrorLogger(),
) {
  try {
    const result = await sync.sync();
    console.log(
      JSON.stringify({
        event: result.status === 'partial' ? 'calendar_sync_partial' : 'calendar_sync_complete',
        ...result,
      }),
    );
    return result;
  } catch (error) {
    logError('calendar_sync_failed', error, {
      trigger: 'scheduled',
      requestId: crypto.randomUUID(),
    });
    throw new Error('Bangumi 日历定时同步失败');
  }
}

/** Node 单实例每日调度；任务结束后安排下一次执行，避免本进程重叠。 */
export function startCalendarSchedule(
  sync: Pick<CalendarSyncService, 'sync'>,
  hourUtc: number,
  logError?: ServerErrorLogger,
) {
  return startDailySchedule(() => runCalendarJob(sync, logError), hourUtc);
}
