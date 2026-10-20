import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { fromArchive } from '../adapters/bangumi/parse.ts';
import type { ImportRecord } from '../core/models.ts';
import { archiveLines, sha256File } from './archive.ts';
import type { createCliLogger } from './logger.ts';

interface ArchiveTarget {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  importRecord(record: ImportRecord): Promise<void>;
}

type Options = {
  file: string;
  asOf?: string;
  limit?: string;
  skipInvalid: boolean;
  requestDelayMs?: number;
  logger: ReturnType<typeof createCliLogger>;
} & ({ dryRun: true; target?: never } | { dryRun?: false; target: ArchiveTarget });

export async function syncArchive(options: Options) {
  const { file, logger, dryRun = false } = options;
  const target = options.target;
  const meta = existsSync(`${file}.meta.json`)
    ? (JSON.parse(await readFile(`${file}.meta.json`, 'utf8')) as { dataAsOf?: string })
    : {};
  const sourceTime = options.asOf ?? meta.dataAsOf;
  if (sourceTime === undefined && !dryRun) throw new Error('需要 --as-of');
  // 纯解析不参与新旧版本合并；未指定快照时间时以 0 验证记录结构。
  const asOf =
    sourceTime === undefined ? 0 : Date.parse(z.iso.datetime({ offset: true }).parse(sourceTime));
  const limit =
    options.limit === undefined && dryRun
      ? null
      : z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .parse(options.limit ?? '1000');
  let key: string | null = null;
  let state: { line: number; skippedTotal?: number } = { line: 0 };
  if (target) {
    logger.update({ phase: 'archive_hash', file });
    logger.log('info', 'archive_hash_started', '计算文件 SHA-256，准备读取检查点', {
      file,
      asOf: new Date(asOf).toISOString(),
    });
    key = `archive:${await sha256File(file)}:${asOf}`;
    logger.update({ phase: 'checkpoint_read', file });
    state = JSON.parse((await target.getState(key)) ?? '{"line":0}') as typeof state;
  }
  const errorLog = `${file}.errors.jsonl`;
  let lineNumber = 0;
  let parsed = 0;
  let imported = 0;
  let skipped = 0;
  let skippedTotal = state.skippedTotal ?? 0;
  let ignored = 0;
  let emptyLines = 0;
  let limited = false;
  let checkpointLine = dryRun ? null : state.line;
  const startedAt = performance.now();
  const progress = (phase: string, subjectId?: number) => ({
    phase,
    file,
    dryRun,
    line: lineNumber,
    subjectId,
    parsed,
    imported,
    skipped,
    ignored,
    emptyLines,
    skippedTotal,
    checkpointLine,
    recordsPerSecond: Number(
      (
        (dryRun ? parsed : imported) / Math.max((performance.now() - startedAt) / 1000, 0.001)
      ).toFixed(2),
    ),
  });
  logger.log(
    'info',
    dryRun ? 'archive_dry_run_started' : 'archive_resumed',
    dryRun ? '开始纯解析统计，从文件首行扫描' : '已读取检查点，开始扫描文件',
    {
      file,
      archiveKey: key,
      checkpointLine,
      skippedTotal,
      limit,
      requestDelayMs: options.requestDelayMs ?? 0,
      dryRun,
    },
  );
  logger.update(progress('archive_scan'));
  async function saveCheckpoint(complete?: boolean) {
    if (!target || !key) return;
    logger.update(progress('checkpoint_write'));
    await target.setState(
      key,
      JSON.stringify({
        line: lineNumber,
        skippedTotal,
        ...(complete === undefined ? {} : { complete }),
      }),
    );
    checkpointLine = lineNumber;
    logger.log('info', 'archive_checkpoint_saved', '已保存导入检查点', progress('archive_scan'));
    logger.update(progress('archive_scan'));
  }
  for await (const line of archiveLines(file)) {
    lineNumber++;
    logger.update(progress('archive_scan'));
    if (lineNumber <= state.line) continue;
    if (!line.trim()) {
      emptyLines++;
      continue;
    }
    let raw: unknown;
    let record: ReturnType<typeof fromArchive> = null;
    try {
      raw = JSON.parse(line);
      if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number')
        logger.update(progress('archive_parse', raw.id));
      record = fromArchive(raw, asOf);
    } catch (error) {
      if (!options.skipInvalid)
        throw new Error(
          dryRun
            ? `第 ${lineNumber} 行解析失败；可添加 --skip-invalid 继续统计其他条目`
            : `第 ${lineNumber} 行导入失败，已完成数据保留；可修复后重试或添加 --skip-invalid 跳过无效条目`,
          { cause: error },
        );
      const subjectId =
        typeof raw === 'object' &&
        raw !== null &&
        'id' in raw &&
        typeof raw.id === 'number' &&
        Number.isSafeInteger(raw.id)
          ? raw.id
          : null;
      const issue = {
        event: 'archive_record_skipped',
        archiveKey: key,
        line: lineNumber,
        subjectId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      };
      // 真实导入先落盘错误记录再推进检查点；dry-run 只输出日志。
      if (!dryRun) await appendFile(errorLog, JSON.stringify(issue) + '\n', 'utf8');
      logger.log('warn', issue.event, '跳过无效 Archive 条目', {
        ...issue,
        errorMessage: issue.message,
        dryRun,
      });
      skipped++;
      skippedTotal++;
    }
    if (record) {
      parsed++;
      if (target) {
        logger.update(progress('archive_import', record.subject.id));
        logger.log('debug', 'archive_record_started', '开始导入条目', {
          line: lineNumber,
          subjectId: record.subject.id,
        });
        // 网络与存储错误不属于无效数据，不能被 skip-invalid 吞掉。
        try {
          await target.importRecord(record);
          imported++;
        } catch (error) {
          throw new Error(`第 ${lineNumber} 行导入失败，已完成数据保留，可修复后重试`, {
            cause: error,
          });
        }
        logger.log(
          'debug',
          'archive_record_imported',
          '条目导入完成',
          progress('archive_scan', record.subject.id),
        );
      } else {
        logger.log(
          'debug',
          'archive_record_parsed',
          '条目解析完成',
          progress('archive_scan', record.subject.id),
        );
      }
    } else if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type !== 2)
      ignored++;
    logger.update(progress('archive_scan'));
    if (lineNumber % 100 === 0 || parsed === limit) await saveCheckpoint();
    if (limit !== null && parsed >= limit) {
      limited = true;
      break;
    }
  }
  await saveCheckpoint(!limited);
  const status = limited ? 'in_progress' : skippedTotal > 0 ? 'partial' : 'complete';
  logger.log(
    'info',
    dryRun ? 'archive_dry_run_completed' : 'archive_completed',
    limited ? '已达到本次处理上限' : 'Archive 文件扫描完成',
    { ...progress('finished'), complete: !limited, status },
  );
  return {
    ...(dryRun ? { dryRun: true, parsed, ignored, emptyLines } : {}),
    imported,
    skipped,
    skippedTotal,
    line: lineNumber,
    complete: !limited,
    status,
    errorLog: !dryRun && skippedTotal > 0 ? errorLog : null,
  };
}
