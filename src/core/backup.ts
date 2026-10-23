import { z } from 'zod';
import { aliasSchema, ratingSchema, subjectSchema, timestamp } from './models.ts';
import { normalizeName } from './matching.ts';

export const backupSchema = z
  .object({
    version: z.literal(1),
    subject: subjectSchema,
    aliases: z.array(aliasSchema).max(250),
    rating: ratingSchema.nullable(),
    usage: z
      .object({ lastAccessedAt: timestamp, totalHits: z.number().int().nonnegative() })
      .nullable(),
    daily: z
      .array(
        z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          hits: z.number().int().nonnegative(),
        }),
      )
      .max(3660),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.aliases.map((alias) => alias.id)).size !== r.aliases.length)
      ctx.addIssue({ code: 'custom', path: ['aliases'], message: '备份中存在重复别名 ID' });
    if (
      new Set(r.aliases.map((alias) => JSON.stringify([alias.name, alias.source]))).size !==
      r.aliases.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['aliases'],
        message: '备份中存在重复名称与来源的别名',
      });
    if (new Set(r.daily.map((day) => day.day)).size !== r.daily.length)
      ctx.addIssue({ code: 'custom', path: ['daily'], message: '备份中存在重复日期的访问统计' });
    if (
      r.aliases.some(
        (a) => a.subjectId !== r.subject.id || a.normalizedName !== normalizeName(a.name),
      ) ||
      (r.rating && r.rating.subjectId !== r.subject.id)
    )
      ctx.addIssue({ code: 'custom', message: '备份条目 ID 或检索键不一致' });
  });
export type BackupRecord = z.infer<typeof backupSchema>;

/** 兼容旧版备份：同名跨来源记录按数据库迁移规则合并，保留手动来源及其 ID。 */
export function parseBackupRecord(input: unknown): BackupRecord {
  const record = backupSchema.parse(input);
  const aliases = new Map<string, BackupRecord['aliases'][number]>();
  for (const alias of record.aliases) {
    if (!aliases.has(alias.name) || alias.source === 'manual') aliases.set(alias.name, alias);
  }
  return { ...record, aliases: [...aliases.values()] };
}

export interface BackupPage {
  records: BackupRecord[];
  nextCursor: number | null;
}
