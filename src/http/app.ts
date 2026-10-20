import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import type { Context } from 'hono';
import { z, ZodError } from 'zod';
import { AppError, batchSchema, importSchema, nameSchema, positiveId } from '../core/models.ts';
import { QueryService } from '../core/query-service.ts';
import { normalizeName } from '../core/matching.ts';
import type { ApplicationRepository, CalendarSource, SubjectSource } from '../core/ports.ts';
import { SubjectSyncService } from '../core/sync-service.ts';
import { CalendarSyncService } from '../core/calendar-sync-service.ts';
import { backupSchema } from '../core/backup.ts';
import type { Config } from '../config.ts';
import { getOpenApi } from './openapi.ts';
import { createServerErrorLogger, requestErrorContext } from '../observability/errors.ts';

export function createApp(
  repo: ApplicationRepository,
  config: Config,
  dependencies: {
    subjectSource?: SubjectSource;
    calendarSource?: CalendarSource;
    writeErrorLog?: (line: string) => void;
  } = {},
) {
  type AppEnv = { Variables: { requestId: string } };
  const app = new Hono<AppEnv>();
  const logError = createServerErrorLogger({
    secrets: [config.ADMIN_TOKEN, config.BANGUMI_ACCESS_TOKEN],
    write: dependencies.writeErrorLog,
  });
  const errorContext = (c: Context<AppEnv>, status: number, code?: string) => ({
    ...requestErrorContext(c.req.raw, routePath(c) || '[unmatched]', c.get('requestId')),
    status,
    code,
  });
  const syncService = new SubjectSyncService(repo, dependencies.subjectSource);
  const calendarSync = new CalendarSyncService(
    repo,
    dependencies.calendarSource,
    config.CALENDAR_PLATFORM_BATCH_SIZE,
  );
  const service = new QueryService(repo, {
    statsEnabled: config.STATS_ENABLED,
    ratingTtlHours: config.RATING_TTL_HOURS,
  });
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'BODY_TOO_LARGE', message: '请求体不能超过 256 KiB' } }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof AppError) {
      if (error.status >= 500)
        logError('request_failed', error, errorContext(c, error.status, error.code));
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ZodError)
      return c.json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: '参数无效',
            issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
          },
        },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: { code: 'INVALID_JSON', message: '请求体不是有效 JSON' } }, 400);
    logError('request_failed', error, errorContext(c, 503, 'SERVICE_UNAVAILABLE'));
    return c.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后重试' } },
      503,
    );
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));
  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/openapi.json', (c) => c.json(getOpenApi(config.MAX_BATCH_SIZE)));
  app.get('/health/ready', async (c) => {
    if (!(await repo.ready())) throw new AppError(503, 'NOT_READY', '数据库迁移未完成');
    return c.json({ status: 'ok', schemaVersion: 1, statisticsEnabled: config.STATS_ENABLED });
  });
  app.post('/api/v1/ratings/batch', async (c) => {
    const { items } = batchSchema.parse(await c.req.json());
    if (items.length > config.MAX_BATCH_SIZE)
      throw new AppError(400, 'BATCH_TOO_LARGE', `每批最多 ${config.MAX_BATCH_SIZE} 条`);
    return c.json(
      await service.batch(items, (error) =>
        logError('usage_write_failed', error, errorContext(c, 200)),
      ),
    );
  });
  app.get('/api/v1/subjects/:id', async (c) => {
    const id = positiveId.parse(Number(c.req.param('id')));
    const result = (
      await service.batch([{ inputId: String(id), subjectId: id }], (error) =>
        logError('usage_write_failed', error, errorContext(c, 200)),
      )
    ).results[0]!;
    if (result.status === 'not_found') throw new AppError(404, 'SUBJECT_NOT_FOUND', '条目未收录');
    return c.json(result);
  });
  app.get('/api/v1/subjects/:id/aliases', async (c) => {
    const id = positiveId.parse(Number(c.req.param('id')));
    if (!(await repo.findSubjects([id])).length)
      throw new AppError(404, 'SUBJECT_NOT_FOUND', '条目未收录');
    return c.json({ aliases: await repo.listAliases(id) });
  });
  app.use('/api/v1/admin/*', async (c, next) => {
    if (!config.ADMIN_TOKEN) throw new AppError(503, 'ADMIN_DISABLED', '管理接口未启用');
    const token = c.req.header('Authorization')?.replace(/^Bearer /u, '') ?? '';
    if (!(await equalToken(token, config.ADMIN_TOKEN)))
      throw new AppError(401, 'UNAUTHORIZED', '管理凭证无效');
    await next();
  });
  const aliasBody = z.object({ name: nameSchema });
  app.post('/api/v1/admin/calendar/sync', async (c) => c.json(await calendarSync.sync()));
  app.post('/api/v1/admin/subjects/:id/sync', async (c) => {
    const id = positiveId.parse(Number(c.req.param('id')));
    return c.json(await syncService.sync(id));
  });
  app.post('/api/v1/admin/subjects/:id/aliases', async (c) => {
    const id = positiveId.parse(Number(c.req.param('id')));
    const { name } = aliasBody.parse(await c.req.json());
    if (!(await repo.findSubjects([id])).length)
      throw new AppError(404, 'SUBJECT_NOT_FOUND', '请先导入该条目');
    const alias = await repo.addManualAlias(id, name, Date.now());
    const conflicts = [
      ...new Set(
        (await repo.findAliases([normalizeName(name)]))
          .filter((a) => a.subjectId !== id)
          .map((a) => a.subjectId),
      ),
    ];
    return c.json({ alias, conflictingSubjectIds: conflicts });
  });
  app.patch('/api/v1/admin/aliases/:id', async (c) => {
    const { name } = aliasBody.parse(await c.req.json());
    const alias = await repo.updateManualAlias(c.req.param('id'), name, Date.now());
    if (!alias) throw new AppError(404, 'ALIAS_NOT_FOUND', '手动别名不存在');
    return c.json({
      alias,
      conflictingSubjectIds: [
        ...new Set(
          (await repo.findAliases([normalizeName(name)]))
            .filter((a) => a.subjectId !== alias.subjectId)
            .map((a) => a.subjectId),
        ),
      ],
    });
  });
  app.delete('/api/v1/admin/aliases/:id', async (c) => {
    if (!(await repo.deleteManualAlias(c.req.param('id'))))
      throw new AppError(404, 'ALIAS_NOT_FOUND', '手动别名不存在');
    return c.json({ deleted: true });
  });
  app.post('/api/v1/admin/import', async (c) => {
    const record = importSchema.parse(await c.req.json());
    await repo.importRecord(record);
    return c.json({ imported: record.subject.id });
  });
  app.get('/api/v1/admin/export', async (c) => {
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(c.req.query('after') ?? '0');
    return c.json(await repo.exportPage(cursor));
  });
  app.post('/api/v1/admin/restore', async (c) => {
    const record = backupSchema.parse(await c.req.json());
    await repo.restoreRecord(record);
    return c.json({ restored: record.subject.id });
  });
  app.get('/api/v1/admin/stats', async (c) =>
    c.json({ enabled: config.STATS_ENABLED, subjects: await repo.stats() }),
  );
  app.post('/api/v1/admin/stats/prune', async (c) => {
    const { days } = z
      .object({ days: z.number().int().min(30).max(3650).default(90) })
      .parse(await c.req.json());
    return c.json(await repo.pruneDaily(days));
  });
  app.get('/api/v1/admin/retention', async (c) => {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .parse(c.req.query('days') ?? '90');
    return c.json(await repo.retentionPreview(days, config.STATS_ENABLED));
  });
  app.get('/api/v1/admin/sync-state/:key', async (c) =>
    c.json({ value: await repo.getState(c.req.param('key')) }),
  );
  app.put('/api/v1/admin/sync-state/:key', async (c) => {
    const { value } = z.object({ value: z.string().max(10000) }).parse(await c.req.json());
    await repo.setState(c.req.param('key'), value);
    return c.json({ saved: true });
  });
  return app;
}

async function equalToken(a: string, b: string) {
  // 比较定长摘要，避免直接按 token 字符串前缀提前返回。
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all(
    [a, b].map(
      async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s))),
    ),
  );
  let diff = 0;
  for (let i = 0; i < left!.length; i++) diff |= left![i]! ^ right![i]!;
  return diff === 0;
}
