import { open, rename } from 'node:fs/promises';
import { z } from 'zod';
import { readConfig } from '../config.ts';
import { nameSchema, positiveId } from '../core/models.ts';
import { createBangumiSource } from '../adapters/bangumi/client.ts';
import { downloadArchive, sha256File } from './archive.ts';
import { syncArchive } from './sync-archive.ts';
import { restoreBackup } from './restore-backup.ts';
import { localTarget, remoteTarget } from './target.ts';
import {
  aliasReviewOptionsSchema,
  resolveAliasMisses,
  type AliasReviewUI,
} from './resolve-alias-misses.ts';
import { checkCancelled } from './cancellation.ts';
import type { CommandName, CliValues } from './arguments.ts';
import type { createCliLogger } from './logger.ts';

function required(value: string | undefined, flag: string) {
  if (!value) throw new Error(`需要 ${flag}；交互终端可省略参数使用向导`);
  return value;
}
export function validateCommandOptions(command: CommandName, values: CliValues) {
  if (
    values.requestRetries !== undefined &&
    !['sync-archive', 'resolve-alias-misses'].includes(command)
  )
    throw new Error('--request-retries 仅支持 sync-archive 或 resolve-alias-misses');
  if (values.searchLimit !== undefined && command !== 'resolve-alias-misses')
    throw new Error('--search-limit 仅支持 resolve-alias-misses');
  if (values.checkpointInterval !== undefined && command !== 'sync-archive')
    throw new Error('--checkpoint-interval 仅支持 sync-archive');
  if (values.dryRun && command !== 'sync-archive') throw new Error('--dry-run 仅支持 sync-archive');
  if (command === 'resolve-alias-misses' && values.interactive === false)
    throw new Error(
      'resolve-alias-misses 需要逐项选择，请移除 --no-interactive；管道可继续输入序号、-1、0 或 q',
    );
}
export async function executeCommand(
  command: CommandName,
  values: CliValues,
  dependencies: {
    logger: ReturnType<typeof createCliLogger>;
    createReview(): AliasReviewUI & { close?(): void };
    signal?: AbortSignal;
    env?: Record<string, unknown>;
  },
): Promise<unknown> {
  const { logger, signal, env = process.env } = dependencies;
  validateCommandOptions(command, values);
  checkCancelled(signal);
  const reviewOptions =
    command === 'resolve-alias-misses'
      ? aliasReviewOptionsSchema.parse({ limit: values.limit, searchLimit: values.searchLimit })
      : undefined;
  if (['sync-archive', 'import'].includes(command)) required(values.file, '--file');
  if (['download-archive', 'export'].includes(command)) required(values.out, '--out');
  if (['sync-subject', 'alias-add'].includes(command))
    positiveId.parse(Number(required(values.id, '--id')));
  if (command === 'alias-add') nameSchema.parse(required(values.name, '--name'));
  if (values.dryRun)
    return syncArchive({
      dryRun: true,
      file: values.file!,
      asOf: values.asOf,
      limit: values.limit,
      checkpointInterval: values.checkpointInterval,
      skipInvalid: values.skipInvalid ?? false,
      logger,
      signal,
    });
  if (command === 'download-archive')
    return downloadArchive(values.out!, (progress) => logger.update(progress), signal);
  if (command === 'migrate' && values.apiUrl)
    throw new Error('远程 D1 请使用 wrangler d1 migrations apply DB --remote');
  const config = readConfig(env);
  const requestDelayMs = z.coerce
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .parse(values.requestDelayMs ?? '0');
  const requestRetries = z.coerce
    .number()
    .int()
    .min(0)
    .parse(
      values.requestRetries ??
        (['sync-archive', 'resolve-alias-misses'].includes(command) ? '3' : '0'),
    );
  logger.update({ phase: 'opening_storage' });
  const target = values.apiUrl
    ? remoteTarget(values.apiUrl, config.ADMIN_TOKEN, {
        requestDelayMs,
        requestRetries,
        log: logger.log,
      })
    : await localTarget(
        env,
        ['sync-calendar', 'sync-subject', 'resolve-alias-misses'].includes(command)
          ? createBangumiSource(config)
          : undefined,
        config.CALENDAR_PLATFORM_BATCH_SIZE,
      );
  let review: (AliasReviewUI & { close?(): void }) | undefined;
  try {
    checkCancelled(signal);
    logger.log('info', 'target_ready', '存储目标已就绪', {
      mode: values.apiUrl ? 'remote' : 'local',
      apiOrigin: values.apiUrl ? new URL(values.apiUrl).origin : undefined,
      requestDelayMs,
      requestRetries,
    });
    logger.update({ phase: command });
    switch (command) {
      case 'sync-calendar': {
        let result;
        let rounds = 0;
        let platformsUpdated = 0;
        do {
          checkCancelled(signal);
          logger.update({ phase: 'calendar_sync', round: rounds + 1 });
          logger.log('info', 'calendar_round_started', '开始同步日历', { round: rounds + 1 });
          result = await target.syncCalendar();
          rounds++;
          platformsUpdated += result.platformsUpdated;
          logger.log(
            result.platformFailures.length ? 'warn' : 'info',
            'calendar_round_completed',
            '本轮日历同步完成',
            { ...result, round: rounds, platformsUpdatedTotal: platformsUpdated },
          );
        } while (
          values.completePlatforms &&
          result.platformsRemaining > 0 &&
          result.platformsUpdated > 0 &&
          rounds < 100
        );
        return { ...result, platformsUpdated, rounds };
      }
      case 'migrate':
        return { migrated: true };
      case 'sync-archive':
        return await syncArchive({
          target,
          file: values.file!,
          asOf: values.asOf,
          limit: values.limit,
          checkpointInterval: values.checkpointInterval,
          skipInvalid: values.skipInvalid ?? false,
          requestDelayMs,
          logger,
          signal,
        });
      case 'sync-subject': {
        const id = positiveId.parse(Number(values.id));
        logger.update({ phase: 'subject_sync', subjectId: id });
        logger.log('info', 'subject_sync_started', '开始同步条目', { subjectId: id });
        return await target.syncSubject(id);
      }
      case 'resolve-alias-misses':
        review = dependencies.createReview();
        return await resolveAliasMisses({ target, ui: review, logger, ...reviewOptions, signal });
      case 'alias-add':
        return await target.alias(
          positiveId.parse(Number(values.id)),
          nameSchema.parse(values.name),
        );
      case 'export': {
        const out = values.out!;
        const stream = await open(`${out}.partial`, 'wx');
        let cursor = 0;
        let count = 0;
        try {
          while (true) {
            checkCancelled(signal);
            logger.update({ phase: 'backup_export', cursor, exported: count });
            const page = await target.exportPage(cursor);
            for (const record of page.records) {
              await stream.writeFile(JSON.stringify(record) + '\n');
              count++;
            }
            logger.log('info', 'export_page_completed', '备份分页写入完成', {
              exported: count,
              nextCursor: page.nextCursor,
            });
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
          }
        } finally {
          await stream.close();
        }
        checkCancelled(signal);
        await rename(`${out}.partial`, out);
        logger.update({ phase: 'backup_hash', output: out, exported: count });
        return { exported: count, sha256: await sha256File(out, signal) };
      }
      case 'import':
        return await restoreBackup({
          file: values.file!,
          target,
          logger,
          signal,
          maxRecordBytes: values.apiUrl ? 256 * 1024 : undefined,
        });
      case 'stats':
        return await target.stats();
      case 'alias-misses':
        return await target.aliasMisses();
      case 'stats-prune':
        return await target.prune(
          z.coerce
            .number()
            .int()
            .min(30)
            .max(3650)
            .parse(values.days ?? '90'),
        );
      case 'retention-preview':
        return await target.retention(
          z.coerce
            .number()
            .int()
            .min(1)
            .max(3650)
            .parse(values.days ?? '90'),
          config.STATS_ENABLED,
        );
    }
  } finally {
    review?.close?.();
    await target.close();
  }
}
