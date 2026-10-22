import type { D1Database } from '@cloudflare/workers-types';
import { D1Driver } from '../adapters/storage/d1.ts';
import { SqlRepository } from '../adapters/storage/repository.ts';
import { readConfig } from '../config.ts';
import { createApp } from '../http/app.ts';
import { createBangumiSource } from '../adapters/bangumi/client.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { runCalendarJob } from '../scheduling/calendar.ts';
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
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const logError = createServerErrorLogger({
      secrets: [env.ADMIN_TOKEN ?? '', env.BANGUMI_ACCESS_TOKEN ?? ''],
    });
    let sync;
    try {
      const config = readConfig({ ...env });
      if (!config.CALENDAR_SYNC_ENABLED) return;
      sync = new CalendarSyncService(
        new SqlRepository(new D1Driver(env.DB)),
        createBangumiSource(config),
        config.CALENDAR_PLATFORM_BATCH_SIZE,
      );
    } catch (error) {
      logError('calendar_sync_failed', error, {
        trigger: 'scheduled',
        requestId: crypto.randomUUID(),
      });
      throw new Error('Bangumi 日历定时同步配置无效');
    }
    await runCalendarJob(sync, logError);
  },
};
