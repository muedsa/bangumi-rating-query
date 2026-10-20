import { existsSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readConfig } from '../config.ts';
import { nameSchema, positiveId } from '../core/models.ts';
import { BangumiClient, createBangumiSource } from '../adapters/bangumi/client.ts';
import { backupSchema } from '../core/backup.ts';
import { archiveLines as lines, downloadArchive, sha256File } from '../cli/archive.ts';
import { syncArchive } from '../cli/sync-archive.ts';
import { localTarget, remoteTarget } from '../cli/target.ts';
import { createCliLogger, type LogVerbosity } from '../cli/logger.ts';

if (existsSync('.env')) loadEnvFile('.env');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    'as-of': { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    'api-url': { type: 'string' },
    limit: { type: 'string' },
    days: { type: 'string', default: '90' },
    'skip-invalid': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'complete-platforms': { type: 'boolean', default: false },
    'request-delay-ms': { type: 'string', default: '0' },
    'request-retries': { type: 'string' },
    'log-level': { type: 'string', default: 'info' },
    out: { type: 'string' },
  },
});
const command = positionals[0];
function makeLogger(level: LogVerbosity) {
  return createCliLogger({
    command: command ?? 'help',
    level,
    secrets: [
      process.env.ADMIN_TOKEN ?? '',
      process.env.BANGUMI_ACCESS_TOKEN ?? '',
      process.env.ADMIN_TOKEN?.trim() ?? '',
      process.env.BANGUMI_ACCESS_TOKEN?.trim() ?? '',
    ],
  });
}
let logger = makeLogger('info');
let heartbeat: ReturnType<typeof setInterval> | undefined;
let running = false;
function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`需要 ${label}`);
  return value;
}
async function main() {
  if (!command || command === 'help') {
    console.log(
      '命令：migrate | download-archive --out 文件 | sync-archive --file 文件 [--as-of ISO时间] [--limit 1000] [--skip-invalid] [--dry-run] [--request-retries 3] | sync-subject --id ID | sync-calendar [--complete-platforms] | alias-add --id ID --name 别名 | export --out 文件 | import --file 文件 | stats | stats-prune [--days 90] | retention-preview [--days 90]\n纯解析统计：sync-archive --dry-run，不连接存储、不更新检查点，默认扫描全文件，可不指定 --as-of。\n远程 Worker / Node：追加 --api-url https://服务地址，并配置 ADMIN_TOKEN。\n远程请求间隔：--request-delay-ms 毫秒，默认 0（不延迟）。\nArchive 远程请求重试：--request-retries 次数，默认 3（首次请求之外最多重试 3 次），0 关闭；网络异常、超时和 HTTP 408/429/5xx 按 1、2、4 秒退避重试（上限 30 秒），遵循请求间隔和 Retry-After。\n日志：--log-level debug|info|warn|error|silent，默认 info；日志输出到 stderr，每 5 秒报告进度，stdout 保留命令结果。',
    );
    return;
  }
  logger = makeLogger(
    z.enum(['debug', 'info', 'warn', 'error', 'silent']).parse(values['log-level']),
  );
  running = true;
  logger.log('info', 'cli_started', '开始执行命令', {
    mode: values['dry-run'] ? 'dry-run' : values['api-url'] ? 'remote' : 'local',
  });
  heartbeat = setInterval(() => logger.progress(), 5000);
  heartbeat.unref();
  if (values['request-retries'] !== undefined && command !== 'sync-archive')
    throw new Error('--request-retries 仅支持 sync-archive');
  if (values['dry-run']) {
    if (command !== 'sync-archive') throw new Error('--dry-run 仅支持 sync-archive');
    console.log(
      JSON.stringify(
        await syncArchive({
          dryRun: true,
          file: required(values.file, '--file'),
          asOf: values['as-of'],
          limit: values.limit,
          skipInvalid: values['skip-invalid'],
          logger,
        }),
      ),
    );
    return;
  }
  if (command === 'download-archive') {
    logger.update({ phase: 'downloading_archive', output: values.out });
    console.log(
      JSON.stringify(
        await downloadArchive(required(values.out, '--out'), (progress) => logger.update(progress)),
      ),
    );
    return;
  }
  const config = readConfig(process.env);
  const requestDelayMs = z.coerce
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .parse(values['request-delay-ms']);
  const requestRetries = z.coerce
    .number()
    .int()
    .min(0)
    .parse(values['request-retries'] ?? (command === 'sync-archive' ? '3' : '0'));
  logger.update({ phase: 'opening_storage' });
  const target = values['api-url']
    ? remoteTarget(values['api-url'], config.ADMIN_TOKEN, {
        requestDelayMs,
        requestRetries,
        log: logger.log,
      })
    : localTarget(
        process.env.DATABASE_PATH ?? './data/bangumi.sqlite',
        command === 'sync-calendar' ? createBangumiSource(config) : undefined,
        config.CALENDAR_PLATFORM_BATCH_SIZE,
      );
  logger.log('info', 'target_ready', '存储目标已就绪', {
    mode: values['api-url'] ? 'remote' : 'local',
    apiOrigin: values['api-url'] ? new URL(values['api-url']).origin : undefined,
    requestDelayMs,
    requestRetries,
  });
  logger.update({ phase: command });
  try {
    switch (command) {
      case 'sync-calendar': {
        let result;
        let rounds = 0;
        let platformsUpdated = 0;
        do {
          logger.update({ phase: 'calendar_sync', round: rounds + 1, platformsUpdated });
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
          values['complete-platforms'] &&
          result.platformsRemaining > 0 &&
          result.platformsUpdated > 0 &&
          rounds < 100
        );
        console.log(JSON.stringify({ ...result, platformsUpdated, rounds }));
        break;
      }
      case 'migrate':
        if (values['api-url'])
          throw new Error('远程 D1 请使用 wrangler d1 migrations apply DB --remote');
        console.log('数据库迁移完成');
        break;
      case 'sync-archive': {
        console.log(
          JSON.stringify(
            await syncArchive({
              target,
              file: required(values.file, '--file'),
              asOf: values['as-of'],
              limit: values.limit,
              skipInvalid: values['skip-invalid'],
              requestDelayMs,
              logger,
            }),
          ),
        );
        break;
      }
      case 'sync-subject': {
        const id = positiveId.parse(Number(values.id));
        logger.update({ phase: 'subject_sync', subjectId: id });
        logger.log('info', 'subject_sync_started', '开始同步条目', { subjectId: id });
        if ('syncSubject' in target) console.log(JSON.stringify(await target.syncSubject(id)));
        else {
          const record = await new BangumiClient(config.BANGUMI_USER_AGENT, {
            accessToken: config.BANGUMI_ACCESS_TOKEN,
          }).getSubject(id);
          await target.importRecord(record);
          console.log(JSON.stringify({ imported: id }));
        }
        break;
      }
      case 'alias-add':
        console.log(
          JSON.stringify(
            await target.alias(positiveId.parse(Number(values.id)), nameSchema.parse(values.name)),
          ),
        );
        break;
      case 'export': {
        const out = required(values.out, '--out');
        const stream = await open(`${out}.partial`, 'wx');
        let cursor = 0;
        let count = 0;
        try {
          while (true) {
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
        await rename(`${out}.partial`, out);
        logger.update({ phase: 'backup_hash', output: out, exported: count });
        console.log(JSON.stringify({ exported: count, sha256: await sha256File(out) }));
        break;
      }
      case 'import': {
        const file = required(values.file, '--file');
        logger.log('info', 'backup_validation_started', '开始完整校验备份文件', { file });
        // 先验证全部记录，再开始恢复；不把损坏文件的一部分悄悄当成成功。
        const seen = new Set<number>();
        for await (const line of lines(file))
          if (line.trim()) {
            const record = backupSchema.parse(JSON.parse(line));
            if (seen.has(record.subject.id))
              throw new Error(`备份中存在重复条目 ${record.subject.id}`);
            seen.add(record.subject.id);
            logger.update({ phase: 'backup_validation', file, validated: seen.size });
          }
        logger.log('info', 'backup_validation_completed', '备份文件校验完成', {
          file,
          records: seen.size,
        });
        logger.update({ phase: 'backup_check_empty', file, records: seen.size });
        if ((await target.exportPage(0)).records.length) throw new Error('恢复需要空数据库');
        let count = 0;
        for await (const line of lines(file))
          if (line.trim()) {
            const record = backupSchema.parse(JSON.parse(line));
            logger.update({
              phase: 'backup_restore',
              file,
              restored: count,
              total: seen.size,
              subjectId: record.subject.id,
            });
            await target.restore(record);
            count++;
            logger.log('debug', 'backup_record_restored', '备份条目恢复完成', {
              restored: count,
              total: seen.size,
              subjectId: record.subject.id,
            });
          }
        console.log(JSON.stringify({ restored: count }));
        break;
      }
      case 'stats':
        console.log(JSON.stringify(await target.stats(), null, 2));
        break;
      case 'stats-prune':
        console.log(
          JSON.stringify(
            await target.prune(z.coerce.number().int().min(30).max(3650).parse(values.days)),
          ),
        );
        break;
      case 'retention-preview':
        console.log(
          JSON.stringify(
            await target.retention(
              z.coerce.number().int().min(1).max(3650).parse(values.days),
              config.STATS_ENABLED,
            ),
            null,
            2,
          ),
        );
        break;
      default:
        throw new Error(`未知命令：${command}`);
    }
  } finally {
    target.close();
  }
}
main()
  .then(() => {
    if (running) logger.log('info', 'cli_completed', '命令执行完成');
  })
  .catch((error: unknown) => {
    logger.fail(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (heartbeat) clearInterval(heartbeat);
  });
