import { z } from 'zod';

export const positiveId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Bangumi 条目 ID，正安全整数。');
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe('名称；去除首尾空白后为 1～300 个字符。');
export const timestamp = z
  .number()
  .int()
  .min(0)
  .max(8640000000000000)
  .describe('Unix 毫秒时间戳，非秒；范围限于 JavaScript Date。');
export const subjectSchema = z.object({
  id: positiveId,
  name: nameSchema.describe('条目原名；去除首尾空白，不能为空。'),
  nameCn: z.string().max(300).default('').describe('中文名；缺失时为空字符串。'),
  airDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null)
    .describe('首播日期 YYYY-MM-DD；未知为 null。仅校验字符串形式。'),
  platform: z
    .string()
    .max(100)
    .default('')
    .describe('作品形式，如 TV、OVA、剧场版；未知为空字符串。'),
  metadataAt: timestamp.describe('元数据版本时间（Unix 毫秒）；仅较新的版本更新名称、日期和形式。'),
  cachedAt: timestamp.describe('首次入库时间（Unix 毫秒）；普通重新导入不覆盖已有值。'),
  pinned: z
    .boolean()
    .default(false)
    .describe('是否固定保留；true 时不列入冷数据候选，普通重新导入不覆盖。'),
});
export type Subject = z.infer<typeof subjectSchema>;
export const ratingSchema = z.object({
  subjectId: positiveId.describe('评分所属条目，必须与 subject.id 相同。'),
  score: z.number().min(0).max(10).nullable().describe('评分 0～10；暂无有效评分为 null。'),
  votes: z.number().int().nonnegative().describe('评分人数，非收藏人数。'),
  rank: z.number().int().positive().nullable().describe('Bangumi 排名；未知为 null。'),
  source: z.enum(['archive', 'api']).describe('评分来源：Archive 快照或 Bangumi API。'),
  dataAsOf: timestamp.describe('评分版本时间（Unix 毫秒）；用于新旧比较和过期判断。'),
  fetchedAt: timestamp.describe('本次获取评分的时间（Unix 毫秒）。'),
});
export type Rating = z.infer<typeof ratingSchema>;
export const aliasSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .describe('别名记录 ID；新建时为 UUID，恢复的历史 ID 不要求 UUID 格式。'),
  subjectId: positiveId.describe('别名所属条目 ID。'),
  name: nameSchema,
  normalizedName: z
    .string()
    .min(1)
    .max(600)
    .describe('检索键：NFKC、去首尾空白、连续空白合并为一个空格、转小写。'),
  source: z
    .enum(['bangumi', 'manual'])
    .describe('来源：bangumi 为上游名称及衍生名称，manual 为手动名称及衍生名称。'),
  createdAt: timestamp.describe('别名创建时间（Unix 毫秒）。'),
  updatedAt: timestamp.describe('别名最近更新时间（Unix 毫秒）。'),
});
export type Alias = z.infer<typeof aliasSchema>;
export const importSchema = z
  .object({
    subject: subjectSchema.describe('标准化的动画条目信息；调用者应确保是动画类型。'),
    aliases: z
      .array(nameSchema)
      .max(200)
      .describe('额外上游别名，必填，可为空数组；原名和中文名也会自动作为别名。'),
    rating: ratingSchema.nullable().describe('评分记录，必填；null 表示不更新已有评分。'),
  })
  .superRefine((record, ctx) => {
    if (record.rating && record.subject.id !== record.rating.subjectId)
      ctx.addIssue({ code: 'custom', message: '评分与条目 ID 不一致' });
  });
export type ImportRecord = z.infer<typeof importSchema>;
export const queryItemSchema = z
  .object({
    inputId: z
      .string()
      .min(1)
      .max(100)
      .describe('调用方关联 ID，在同一批次内必须唯一；响应原样返回。'),
    subjectId: positiveId
      .optional()
      .describe('显式条目 ID；提供后忽略 names，但仍应用年份和形式筛选。'),
    names: z
      .array(nameSchema)
      .min(1)
      .max(5)
      .optional()
      .describe(
        '同一作品的 1～5 个已知名称；至少提供 subjectId 或 names。支持官方条目链接，纯数字仍作为名称。',
      ),
    year: z
      .number()
      .int()
      .min(1800)
      .max(2200)
      .optional()
      .describe('按首播年份筛选；日期未知的条目不匹配。'),
    platform: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('按作品形式归一化后相等筛选，如 TV、OVA。'),
  })
  .refine((item) => item.subjectId !== undefined || item.names !== undefined, {
    message: '需要提供 subjectId 或 names',
  });
export const batchSchema = z
  .object({
    items: z
      .array(queryItemSchema)
      .min(1)
      .max(50)
      .describe('按输入顺序逐项匹配；inputId 不得重复。部署还受 MAX_BATCH_SIZE 限制。'),
  })
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
