import { z } from 'zod';
import { nameSchema, positiveId, timestamp } from './models.ts';

export const calendarItemSchema = z.object({
  id: positiveId,
  name: nameSchema,
  nameCn: z.string().trim().max(300),
  airDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  rating: z
    .object({ score: z.number().min(0).max(10).nullable(), votes: z.number().int().nonnegative() })
    .nullable(),
});
export const calendarSnapshotSchema = z.object({
  items: z.array(calendarItemSchema).max(1000),
  fetchedAt: timestamp,
});
export const calendarSyncResultSchema = z.object({
  imported: z
    .number()
    .int()
    .nonnegative()
    .describe('本次日历包含并参与合并的动画条目数，不等于新增数。'),
  dataAsOf: z.iso.datetime().describe('日历获取时间，UTC ISO 8601。'),
  platformsUpdated: z.number().int().nonnegative().describe('本次成功补全作品形式的条目数。'),
  platformsRemaining: z.number().int().nonnegative().describe('本次日历中仍缺少作品形式的条目数。'),
  platformFailures: z
    .array(positiveId)
    .describe('本次获取作品形式失败的条目 ID；不撤销已完成的日历导入。'),
  status: z
    .enum(['complete', 'partial'])
    .describe('complete 表示形式已补齐；partial 可再次调用继续处理，两者均为 HTTP 200。'),
});
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>;
export type CalendarSyncResult = z.infer<typeof calendarSyncResultSchema>;
