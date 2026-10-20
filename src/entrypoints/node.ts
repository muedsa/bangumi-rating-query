import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { SqliteDriver } from '../adapters/storage/sqlite.ts';
import { SqlRepository } from '../adapters/storage/repository.ts';
import { readConfig } from '../config.ts';
import { createApp } from '../http/app.ts';
import { createBangumiSource } from '../adapters/bangumi/client.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { startCalendarSchedule } from '../scheduling/calendar.ts';
import { createServerErrorLogger } from '../observability/errors.ts';

if (existsSync('.env')) loadEnvFile('.env');
const config = readConfig(process.env);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
const driver = new SqliteDriver(process.env.DATABASE_PATH ?? './data/bangumi.sqlite');
driver.migrate();
const repo = new SqlRepository(driver);
const source = createBangumiSource(config);
const app = createApp(repo, config, { subjectSource: source, calendarSource: source });
const stopCalendar = config.CALENDAR_SYNC_ENABLED
  ? startCalendarSchedule(
      new CalendarSyncService(repo, source, config.CALENDAR_PLATFORM_BATCH_SIZE),
      config.CALENDAR_SYNC_HOUR_UTC,
      createServerErrorLogger({ secrets: [config.ADMIN_TOKEN, config.BANGUMI_ACCESS_TOKEN] }),
    )
  : () => {};
const server = serve(
  { fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' },
  (info) => {
    console.log(
      JSON.stringify({
        event: 'listening',
        port: info.port,
        statisticsEnabled: config.STATS_ENABLED,
      }),
    );
  },
);
function shutdown() {
  stopCalendar();
  server.close(() => {
    driver.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
