import { z } from 'zod';
import { AppError, nameSchema, positiveId } from './models.ts';
import type { SubjectSearchSource } from './ports.ts';

export const MAX_SEARCH_CANDIDATES = 50;
export const subjectSearchRequestSchema = z.object({
  keyword: nameSchema.describe('搜索关键词，去首尾空白后为 1～300 字符。'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_CANDIDATES)
    .default(10)
    .describe('最多返回的候选数；仅获取第一页，默认 10，最大 50。'),
});
export const subjectSearchResultSchema = z.object({
  total: z.number().int().nonnegative().describe('上游返回的总匹配数，可能大于本次候选数。'),
  candidates: z
    .array(
      z.object({
        id: positiveId,
        name: nameSchema.describe('候选原名。'),
        nameCn: z.string().max(300).describe('候选中文名，缺失为空字符串。'),
        airDate: z.string().nullable().describe('首播日期；未知为 null。'),
        platform: z.string().max(100).describe('作品形式；未知为空字符串。'),
        summary: z.string().max(500).describe('简介，截取最多 500 字符；缺失为空字符串。'),
        score: z.number().min(0).max(10).nullable().describe('评分；未评分为 null。'),
        votes: z.number().int().nonnegative().describe('评分人数。'),
      }),
    )
    .max(50)
    .describe('按上游匹配度排列的动画候选，按条目 ID 去重；无结果为空数组。'),
});
export type SubjectSearchResult = z.infer<typeof subjectSearchResultSchema>;
export type SubjectSearchCandidate = SubjectSearchResult['candidates'][number];

export async function searchSubjects(
  source: SubjectSearchSource | undefined,
  keyword: string,
  limit: number,
) {
  const request = subjectSearchRequestSchema.parse({ keyword, limit });
  if (!source)
    throw new AppError(
      503,
      'BANGUMI_SEARCH_DISABLED',
      '请在服务端配置 BANGUMI_USER_AGENT 以启用搜索',
    );
  try {
    return subjectSearchResultSchema.parse(
      await source.searchSubjects(request.keyword, request.limit),
    );
  } catch (error) {
    throw new AppError(503, 'BANGUMI_API_ERROR', 'Bangumi 搜索失败，请检查认证配置或稍后重试', {
      cause: error,
    });
  }
}
