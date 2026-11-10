export function millisecondsUntilDailyHour(now: number, hourUtc: number): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

/** Node 单实例每日调度；任务结束后安排下一次执行，避免本进程重叠。 */
export function startDailySchedule(job: () => Promise<unknown>, hourUtc: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (stopped) return;
    timer = setTimeout(
      async () => {
        try {
          await job();
        } catch {
          /* job 已记录失败，保留服务运行，下一日重试。 */
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
