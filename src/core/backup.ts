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
    if (
      r.aliases.some(
        (a) => a.subjectId !== r.subject.id || a.normalizedName !== normalizeName(a.name),
      ) ||
      (r.rating && r.rating.subjectId !== r.subject.id)
    )
      ctx.addIssue({ code: 'custom', message: '备份条目 ID 或检索键不一致' });
  });
export type BackupRecord = z.infer<typeof backupSchema>;
export interface BackupPage {
  records: BackupRecord[];
  nextCursor: number | null;
}
