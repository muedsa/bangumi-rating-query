import type { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { createServerErrorLogger, type ServerErrorLogger } from '../observability/errors.ts';

export function millisecondsUntilDailyHour(now: number, hourUtc: number): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

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
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (stopped) return;
    timer = setTimeout(
      async () => {
        try {
          await runCalendarJob(sync, logError);
        } catch {
          /* 已记录失败，保留服务运行，下一日重试。 */
        } finally {
          schedule();
        }
      },
      millisecondsUntilDailyHour(Date.now(), hourUtc),
    );
  }
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
