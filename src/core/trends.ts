import { z } from 'zod';
import { positiveId, timestamp } from './models.ts';

export const trendsSnapshotSchema = z.object({
  subjectIds: z.array(positiveId).max(100),
  fetchedAt: timestamp,
});

export const trendsSyncResultSchema = z.object({
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
