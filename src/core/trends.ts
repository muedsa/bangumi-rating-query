import { z } from 'zod';
import { positiveId, timestamp } from './models.ts';

export const TRENDS_PAGE_SIZE = 20;
// 保证换算后的上游 offset 仍为安全整数。
export const MAX_TRENDS_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / TRENDS_PAGE_SIZE) + 1;
export const trendsPageSchema = z.number().int().min(1).max(MAX_TRENDS_PAGE);
export const trendsSyncRequestSchema = z.object({ page: trendsPageSchema.default(1) });

export const trendsSnapshotSchema = z.object({
  subjectIds: z.array(positiveId).max(TRENDS_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  fetchedAt: timestamp,
});

export const trendsSyncResultSchema = z.object({
  page: trendsPageSchema.describe('本次同步的搜索页码，从 1 开始。'),
  pageSize: z.literal(TRENDS_PAGE_SIZE).describe('每次固定请求 20 条搜索结果。'),
  total: z.number().int().nonnegative().describe('上游返回的匹配总数，未去重。'),
  nextPage: trendsPageSchema
    .nullable()
    .describe('下一页页码；到达末页或本页为空时为 null，不自动续跑。'),
  discovered: z.number().int().nonnegative().describe('本次搜索返回并去重后的动画条目数量。'),
  attempted: z
    .number()
    .int()
    .nonnegative()
    .describe('按收藏人数排序选取并尝试获取详情的条目数量。'),
  imported: z
    .number()
    .int()
    .nonnegative()
    .describe('成功获取并参与合并的条目数量，不等于新增数量。'),
  failedIds: z.array(positiveId).describe('详情获取或校验失败的条目 ID；没有失败时为空数组。'),
  dataAsOf: z.iso.datetime().describe('近期热门动画搜索时间；各条目的评分时间取自各自详情请求。'),
  status: z
    .enum(['complete', 'partial'])
    .describe('选中条目全部成功或搜索无结果为 complete，部分详情失败为 partial。'),
});

export type TrendsSnapshot = z.infer<typeof trendsSnapshotSchema>;
export type TrendsSyncResult = z.infer<typeof trendsSyncResultSchema>;
