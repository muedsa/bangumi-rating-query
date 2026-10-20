import { z } from 'zod';

export const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const nameSchema = z.string().trim().min(1).max(300);
export const timestamp = z.number().int().min(0).max(8640000000000000);
export const subjectSchema = z.object({
  id: positiveId,
  name: nameSchema,
  nameCn: z.string().max(300).default(''),
  airDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  platform: z.string().max(100).default(''),
  metadataAt: timestamp,
  cachedAt: timestamp,
  pinned: z.boolean().default(false),
});
export type Subject = z.infer<typeof subjectSchema>;
export const ratingSchema = z.object({
  subjectId: positiveId,
  score: z.number().min(0).max(10).nullable(),
  votes: z.number().int().nonnegative(),
  rank: z.number().int().positive().nullable(),
  source: z.enum(['archive', 'api']),
  dataAsOf: timestamp,
  fetchedAt: timestamp,
});
export type Rating = z.infer<typeof ratingSchema>;
export const aliasSchema = z.object({
  id: z.string().min(1).max(100),
  subjectId: positiveId,
  name: nameSchema,
  normalizedName: z.string().min(1).max(600),
  source: z.enum(['bangumi', 'manual']),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Alias = z.infer<typeof aliasSchema>;
export const importSchema = z
  .object({
    subject: subjectSchema,
    aliases: z.array(nameSchema).max(200),
    rating: ratingSchema.nullable(),
  })
  .superRefine((record, ctx) => {
    if (record.rating && record.subject.id !== record.rating.subjectId)
      ctx.addIssue({ code: 'custom', message: '评分与条目 ID 不一致' });
  });
export type ImportRecord = z.infer<typeof importSchema>;
export const queryItemSchema = z
  .object({
    inputId: z.string().min(1).max(100),
    subjectId: positiveId.optional(),
    names: z.array(nameSchema).min(1).max(5).optional(),
    year: z.number().int().min(1800).max(2200).optional(),
    platform: z.string().trim().min(1).max(100).optional(),
  })
  .refine((item) => item.subjectId !== undefined || item.names !== undefined, {
    message: '需要提供 subjectId 或 names',
  });
export const batchSchema = z
  .object({ items: z.array(queryItemSchema).min(1).max(50) })
  .refine(
    ({ items }) => new Set(items.map((item) => item.inputId)).size === items.length,
    'inputId 必须在批次内唯一',
  );
export type QueryItem = z.infer<typeof queryItemSchema>;

export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 413 | 503,
    public code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
