import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((s) => s === 'true');
const configSchema = z.object({
  STATS_ENABLED: bool,
  ALIAS_MISS_STATS_ENABLED: bool,
  MAX_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(20),
  RATING_TTL_HOURS: z.coerce.number().positive().max(8760).default(24),
  ADMIN_TOKEN: z
    .string()
    .default('')
    .refine((s) => !s || s.length >= 32, 'ADMIN_TOKEN 至少 32 字符'),
  BANGUMI_USER_AGENT: z.string().trim().default(''),
  BANGUMI_ACCESS_TOKEN: z.string().trim().default(''),
  CALENDAR_SYNC_ENABLED: bool,
  CALENDAR_SYNC_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(20),
  CALENDAR_PLATFORM_BATCH_SIZE: z.coerce.number().int().min(1).default(10),
});
export function readConfig(env: Record<string, unknown>) {
  return configSchema.parse(env);
}
export type Config = ReturnType<typeof readConfig>;
