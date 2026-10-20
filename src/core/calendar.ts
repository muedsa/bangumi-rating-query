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
  imported: z.number().int().nonnegative(),
  dataAsOf: z.iso.datetime(),
  platformsUpdated: z.number().int().nonnegative(),
  platformsRemaining: z.number().int().nonnegative(),
  platformFailures: z.array(positiveId),
  status: z.enum(['complete', 'partial']),
});
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>;
export type CalendarSyncResult = z.infer<typeof calendarSyncResultSchema>;
