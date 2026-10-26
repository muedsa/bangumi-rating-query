import { z } from 'zod';
import { aliasSchema, ratingSchema, subjectSchema, timestamp } from './models.ts';
import { normalizeName } from './matching.ts';

export const backupSchema = z
  .object({
    version: z.literal(1).describe('业务备份格式版本，固定为 1；与数据库 schema 版本不同。'),
    subject: subjectSchema.describe('完整条目记录。'),
    aliases: z
      .array(aliasSchema)
      .max(250)
      .describe(
        '完整别名，含来源、ID 和时间；同条目 ID、归一化键必须一致。旧版跨来源同名记录恢复时保留 manual。',
      ),
    rating: ratingSchema.nullable().describe('完整评分；null 表示备份中没有评分记录。'),
    usage: z
      .object({
        lastAccessedAt: timestamp.describe('最近唯一命中时间（Unix 毫秒）。'),
        totalHits: z.number().int().nonnegative().describe('累计命中次数。'),
      })
      .nullable()
      .describe('累计访问统计；未记录时为 null。'),
    daily: z
      .array(
        z.object({
          day: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe('UTC 统计日期 YYYY-MM-DD；同条目不得重复。'),
          hits: z.number().int().nonnegative().describe('当日命中次数。'),
        }),
      )
      .max(3660)
      .describe('每日访问统计；没有统计时为空数组。'),
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
