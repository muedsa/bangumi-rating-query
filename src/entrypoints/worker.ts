import type { D1Database } from '@cloudflare/workers-types';
import { D1Driver } from '../adapters/storage/d1.ts';
import { SqlRepository } from '../adapters/storage/repository.ts';
import { readConfig } from '../config.ts';
import { createApp } from '../http/app.ts';
import { createBangumiSource } from '../adapters/bangumi/client.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { runCalendarJob } from '../scheduling/calendar.ts';
import { TrendsSyncService } from '../core/trends-sync-service.ts';
import { runTrendsJob } from '../scheduling/trends.ts';
import { createServerErrorLogger, requestErrorContext } from '../observability/errors.ts';

interface Env {
  DB: D1Database;
  STATS_ENABLED?: string;
  ALIAS_MISS_STATS_ENABLED?: string;
  ADMIN_TOKEN?: string;
  MAX_BATCH_SIZE?: string;
  RATING_TTL_HOURS?: string;
  BANGUMI_USER_AGENT?: string;
  /** 由 Cloudflare Secret 注入，不写入 vars。 */
  BANGUMI_ACCESS_TOKEN?: string;
  CALENDAR_SYNC_ENABLED?: string;
  CALENDAR_SYNC_HOUR_UTC?: string;
  CALENDAR_PLATFORM_BATCH_SIZE?: string;
  TRENDS_SYNC_ENABLED?: string;
  TRENDS_SYNC_HOUR_UTC?: string;
  TRENDS_SYNC_LIMIT?: string;
}

let cachedEnv: Env | undefined;
let cachedApp: ReturnType<typeof createApp> | undefined;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (env !== cachedEnv || !cachedApp) {
        const config = readConfig({ ...env });
        const source = createBangumiSource(config);
        cachedApp = createApp(new SqlRepository(new D1Driver(env.DB)), config, {
          subjectSource: source,
          calendarSource: source,
          searchSource: source,
          trendsSource: source,
        });
        cachedEnv = env;
      }
      return await cachedApp.fetch(request);
    } catch (error) {
      const context = requestErrorContext(request, '[worker-initialization]');
      createServerErrorLogger({ secrets: [env.ADMIN_TOKEN ?? '', env.BANGUMI_ACCESS_TOKEN ?? ''] })(
        'worker_configuration_error',
        error,
        { ...context, status: 503, code: 'CONFIGURATION_ERROR' },
      );
      return Response.json(
        { error: { code: 'CONFIGURATION_ERROR', message: '服务配置无效' } },
        { status: 503, headers: { 'X-Request-ID': context.requestId! } },
      );
    }
  },
  async scheduled(controller: { cron: string }, env: Env): Promise<void> {
    const logError = createServerErrorLogger({
      secrets: [env.ADMIN_TOKEN ?? '', env.BANGUMI_ACCESS_TOKEN ?? ''],
    });
    const jobs: (() => Promise<unknown>)[] = [];
    try {
      const config = readConfig({ ...env });
      const repo = new SqlRepository(new D1Driver(env.DB));
      const source = createBangumiSource(config);
      if (
        config.CALENDAR_SYNC_ENABLED &&
        controller.cron === `0 ${config.CALENDAR_SYNC_HOUR_UTC} * * *`
      )
        jobs.push(() =>
          runCalendarJob(
            new CalendarSyncService(repo, source, config.CALENDAR_PLATFORM_BATCH_SIZE),
            logError,
          ),
        );
      if (
        config.TRENDS_SYNC_ENABLED &&
        controller.cron === `0 ${config.TRENDS_SYNC_HOUR_UTC} * * *`
      )
        jobs.push(() =>
          runTrendsJob(new TrendsSyncService(repo, source, config.TRENDS_SYNC_LIMIT), logError),
        );
    } catch (error) {
      logError('scheduled_configuration_error', error, {
        trigger: 'scheduled',
        requestId: crypto.randomUUID(),
      });
      throw new Error('Bangumi 定时同步配置无效');
    }
    let failed = false;
    // 即使两个任务配置到同一时刻，一个失败也不能阻止另一个运行。
    for (const job of jobs) {
      try {
        await job();
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('Bangumi 定时同步失败');
  },
};
