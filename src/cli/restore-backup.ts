import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseBackupRecord, type BackupPage, type BackupRecord } from '../core/backup.ts';
import { archiveLines, sha256File } from './archive.ts';
import { checkCancelled, CliCancelled } from './cancellation.ts';
import type { createCliLogger } from './logger.ts';

interface RestoreTarget {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  exportPage(after: number): Promise<BackupPage>;
  restore(record: BackupRecord): Promise<void>;
}
const checkpointSchema = z
  .object({
    version: z.literal(1),
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .refine((s) => s.completed <= s.total && (!s.complete || s.completed === s.total));

// 数据库返回顺序和对象原型可能不同，比较规范化后的完整业务内容。
function recordHash(input: BackupRecord) {
  const record = parseBackupRecord(input);
  record.aliases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  record.daily.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export async function restoreBackup(options: {
  file: string;
  target: RestoreTarget;
  logger: ReturnType<typeof createCliLogger>;
  signal?: AbortSignal;
  maxRecordBytes?: number;
}) {
  const { file, target, logger, signal } = options;
  checkCancelled(signal);
  logger.update({ phase: 'backup_hash', file });
  const hash = await sha256File(file, signal);
  const key = `backup-restore:${hash}`;
  logger.log('info', 'backup_validation_started', '开始完整校验备份文件', { file });
  const subjects = new Set<number>();
  const aliases = new Set<string>();
  const records: string[] = [];
  let lineNumber = 0;
  for await (const line of archiveLines(file)) {
    checkCancelled(signal);
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const record = parseBackupRecord(JSON.parse(line));
      if (subjects.has(record.subject.id))
        throw new Error(`备份中存在重复条目 ${record.subject.id}`);
      subjects.add(record.subject.id);
      for (const alias of record.aliases) {
        if (aliases.has(alias.id)) throw new Error(`备份中存在重复别名 ID ${alias.id}`);
        aliases.add(alias.id);
      }
      if (
        options.maxRecordBytes !== undefined &&
        Buffer.byteLength(JSON.stringify(record)) > options.maxRecordBytes
      )
        throw new Error('单条备份超过远程接口的 256 KiB 请求体上限');
      records.push(recordHash(record));
    } catch (error) {
      throw new Error(`第 ${lineNumber} 行备份校验失败，尚未恢复任何条目`, { cause: error });
    }
    logger.update({ phase: 'backup_validation', file, validated: records.length });
  }
  if (hash !== (await sha256File(file, signal)))
    throw new Error('校验期间备份文件发生变化，请重新运行');
  const total = records.length;
  logger.log('info', 'backup_validation_completed', '备份文件校验完成', { file, records: total });
  logger.update({ phase: 'backup_check_empty', file, records: total });
  const saved = await target.getState(key);
  const resuming = saved !== null;
  let state =
    saved === null
      ? { version: 1 as const, total, completed: 0, complete: false }
      : checkpointSchema.parse(JSON.parse(saved));
  if (state.total !== total) throw new Error('备份恢复检查点与文件内容不一致');
  if (!resuming) {
    if ((await target.exportPage(0)).records.length)
      throw new Error('首次恢复需要空数据库；已有数据仅支持使用原备份的恢复检查点续跑');
    checkCancelled(signal);
    // 必须先记录文件身份，才能在第一条写入后发生中断时识别本次恢复。
    await target.setState(key, JSON.stringify(state));
  }
  logger.log(
    'info',
    'backup_restore_started',
    resuming ? '继续恢复备份，核对已写入记录' : '开始恢复备份',
    { file, total, checkpoint: state.completed, resuming },
  );
  let restored = 0;
  let resumed = 0;
  let index = 0;
  lineNumber = 0;
  for await (const line of archiveLines(file)) {
    checkCancelled(signal);
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const record = parseBackupRecord(JSON.parse(line));
      if (recordHash(record) !== records[index])
        throw new Error('备份文件在校验后发生变化，请恢复原文件后重试');
      logger.update({
        phase: 'backup_restore',
        file,
        restored: index,
        total,
        subjectId: record.subject.id,
      });
      const existing = resuming
        ? (await target.exportPage(record.subject.id - 1)).records.find(
            (r) => r.subject.id === record.subject.id,
          )
        : undefined;
      checkCancelled(signal);
      if (existing) {
        if (recordHash(existing) !== records[index])
          throw new Error(`条目 ${record.subject.id} 的现有内容与备份不一致，拒绝覆盖`);
        resumed++;
      } else {
        if (index < state.completed)
          throw new Error(`检查点中已恢复的条目 ${record.subject.id} 不存在，目标数据库可能已改变`);
        await target.restore(record);
        restored++;
      }
      index++;
      if (index > state.completed) {
        state = { ...state, completed: index, complete: false };
        // 当前条目写入完成后保存；取消也不打断这一步。失败重跑会先比较已有条目。
        await target.setState(key, JSON.stringify(state));
      }
      logger.log('debug', 'backup_record_restored', '备份条目已恢复或核对', {
        restored,
        resumed,
        completed: index,
        total,
        subjectId: record.subject.id,
      });
    } catch (error) {
      // 已完成的条目和检查点均保留；不把存储故障当作成功取消。
      if (error instanceof CliCancelled) throw error;
      throw new Error(
        `第 ${lineNumber} 行恢复失败，已完成数据保留；排除错误后用相同备份和目标重新执行命令可继续`,
        { cause: error },
      );
    }
  }
  checkCancelled(signal);
  if (index !== total)
    throw new Error('备份文件在校验后发生变化，已完成数据保留，请恢复原文件后重试');
  await target.setState(key, JSON.stringify({ ...state, complete: true }));
  return { restored, resumed, total, complete: true };
}
