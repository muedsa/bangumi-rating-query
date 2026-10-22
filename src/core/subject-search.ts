import { z } from 'zod';
import { AppError, nameSchema, positiveId } from './models.ts';
import type { SubjectSearchSource } from './ports.ts';

export const MAX_SEARCH_CANDIDATES = 50;
export const subjectSearchRequestSchema = z.object({
  keyword: nameSchema,
  limit: z.number().int().min(1).max(MAX_SEARCH_CANDIDATES).default(10),
});
export const subjectSearchResultSchema = z.object({
  total: z.number().int().nonnegative(),
  candidates: z
    .array(
      z.object({
        id: positiveId,
        name: nameSchema,
        nameCn: z.string().max(300),
        airDate: z.string().nullable(),
        platform: z.string().max(100),
        summary: z.string().max(500),
        score: z.number().min(0).max(10).nullable(),
        votes: z.number().int().nonnegative(),
      }),
    )
    .max(50),
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
