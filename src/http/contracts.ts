import { z } from 'zod';
import { aliasSchema, nameSchema, positiveId, ratingSchema, timestamp } from '../core/models.ts';
import { backupSchema } from '../core/backup.ts';

// 路由与 OpenAPI 共享请求结构，默认值和字段约束只维护一处。
export const aliasBodySchema = z.object({ name: nameSchema });
export const aliasMissPlanSchema = z.object({
  name: nameSchema.describe('原未命中名称；按归一化检索键定位记录。'),
  planned: z.boolean().describe('true 表示计划处理，false 表示暂不处理。'),
});
export const pruneBodySchema = z.object({
  days: z
    .number()
    .int()
    .min(30)
    .max(3650)
    .default(90)
    .describe('保留最近多少个 UTC 日期（含今天），默认 90。'),
});
export const syncStateBodySchema = z.object({
  value: z
    .string()
    .max(10000)
    .describe('不透明字符串，最多 10000 字符；若存 JSON，须先序列化为字符串。'),
});

export const errorSchema = z.object({
  error: z
    .object({
      code: z.string().describe('稳定的错误代码；业务判断应使用 code，而非 message。'),
      message: z.string().describe('可读说明；不包含 SQL、上游响应或凭证等内部信息。'),
      issues: z
        .array(
          z.object({
            path: z
              .array(z.union([z.string(), z.number().int()]))
              .describe('无效字段路径；数组位置为数字，根级错误为空数组。'),
            message: z.string().describe('字段校验说明，具体措辞可能随校验库版本变化。'),
          }),
        )
        .optional()
        .describe('仅 INVALID_INPUT 校验错误携带。'),
    })
    .describe('错误详情。'),
});
export const publicSubjectSchema = z.object({
  id: positiveId,
  name: nameSchema.describe('条目原名。'),
  nameCn: z.string().max(300).describe('中文名，缺失为空字符串。'),
  airDate: z.string().nullable().describe('首播日期 YYYY-MM-DD；未知为 null。'),
  platform: z.string().max(100).describe('作品形式，如 TV、OVA；未知为空字符串。'),
  url: z.url().describe('Bangumi 条目链接。'),
});
const publicRatingFields = {
  rating: ratingSchema
    .pick({ score: true, votes: true, rank: true, source: true })
    .nullable()
    .describe('当前已缓存评分；没有评分记录时为 null。'),
  ratingStatus: z
    .enum(['unavailable', 'unrated', 'available'])
    .describe('unavailable：无评分记录；unrated：有记录但 score=null；available：有评分。'),
  dataAsOf: z
    .string()
    .nullable()
    .describe('评分版本的 UTC ISO 8601 时间；没有评分记录时为 null。与导入使用的毫秒时间戳不同。'),
  stale: z
    .boolean()
    .describe('无评分记录或评分版本距当前时间超过 RATING_TTL_HOURS 时为 true；不会自动回源刷新。'),
};
export const matchedSchema = z.object({
  inputId: z.string().describe('请求关联 ID；按 ID 查询接口使用条目 ID 的十进制字符串。'),
  status: z.literal('matched').describe('唯一匹配到已收录条目。'),
  subject: publicSubjectSchema.describe('匹配条目。'),
  matchReason: z
    .enum(['subject_id', 'exact_alias', 'normalized_alias'])
    .describe('按显式 ID/官方链接、精确别名或归一化别名匹配。'),
  matchedAliases: z
    .array(z.object({ name: nameSchema, source: aliasSchema.shape.source }))
    .describe('参与匹配的别名；显式 subjectId 查询时为空数组。'),
  ...publicRatingFields,
});
export const notFoundSchema = z.object({
  inputId: z.string().describe('请求关联 ID。'),
  status: z
    .literal('not_found')
    .describe('未收录，或年份/形式筛选后无候选；批量接口仍返回 HTTP 200。'),
});
export const ambiguousSchema = z.object({
  inputId: z.string().describe('请求关联 ID。'),
  status: z.literal('ambiguous').describe('无法唯一确认，需调用方选择。'),
  matchReason: z
    .enum(['conflicting_names', 'shared_alias'])
    .describe('conflicting_names：不同名称指向不相交条目；shared_alias：别名被多个条目共享。'),
  candidates: z
    .array(publicSubjectSchema.extend(publicRatingFields))
    .min(1)
    .max(20)
    .describe(
      '候选包含公开条目信息、缓存评分及评分状态，按 ID 升序排列，最多 20 条；冲突筛选后也可能仅余一条但仍不自动确认。',
    ),
  candidatesTruncated: z.boolean().describe('候选超过 20 条时为 true。'),
});
export const batchResponseSchema = z.object({
  results: z
    .array(z.discriminatedUnion('status', [matchedSchema, notFoundSchema, ambiguousSchema]))
    .describe('与请求 items 一一对应，顺序相同。'),
});
const aliasMissSchema = z.object({
  name: nameSchema.describe('最近记录的原始名称，可能不是 normalizedName 的原拼写。'),
  normalizedName: aliasSchema.shape.normalizedName,
  missCount: z
    .number()
    .int()
    .positive()
    .describe('累计未命中次数；一次批量请求中同一归一化名称最多记一次。'),
  firstMissedAt: timestamp.describe('首次未命中时间（Unix 毫秒）。'),
  lastMissedAt: timestamp.describe('最近未命中时间（Unix 毫秒）。'),
  planned: z.boolean().describe('是否计划处理，新增时默认为 true；新增未命中不会重置该值。'),
});
export const responseSchemas = {
  LiveResponse: z.object({ status: z.literal('ok').describe('进程或 Worker 可响应。') }),
  ReadyResponse: z.object({
    status: z.literal('ok').describe('数据库 schema 与当前服务版本一致。'),
    schemaVersion: z
      .number()
      .int()
      .positive()
      .describe('当前数据库 schema 版本，与 API 版本和备份版本独立。'),
    statisticsEnabled: z.boolean().describe('是否启用访问统计 STATS_ENABLED。'),
  }),
  BatchResponse: batchResponseSchema,
  MatchedResponse: matchedSchema,
  AliasesResponse: z.object({
    aliases: z.array(aliasSchema).describe('该条目的全部来源别名，按来源、名称排序。'),
  }),
  AliasWriteResponse: z.object({
    alias: aliasSchema.describe('新增、修改或复用的别名；幂等复用时可能是 bangumi 来源。'),
    conflictingSubjectIds: z
      .array(positiveId)
      .describe('同名或季数互补名称关联的其他条目 ID；允许跨条目同名，不表示写入失败。'),
  }),
  DeleteAliasResponse: z.object({ deleted: z.literal(true).describe('指定手动别名已删除。') }),
  ImportResponse: z.object({
    imported: positiveId.describe('参与导入的条目 ID，不是新增或更新数量。'),
  }),
  ExportResponse: z.object({
    records: z.array(backupSchema).max(5).describe('按条目 ID 升序返回的完整备份。'),
    nextCursor: positiveId
      .nullable()
      .describe('下一页 after；当前页不足 5 条时为 null。恰好 5 条时可能还需请求一个空页。'),
  }),
  RestoreResponse: z.object({ restored: positiveId.describe('成功恢复的条目 ID。') }),
  StatsResponse: z.object({
    enabled: z.boolean().describe('当前是否启用访问统计；关闭后仍返回历史记录。'),
    subjects: z
      .array(
        z.object({
          subjectId: positiveId,
          name: nameSchema.describe('条目原名。'),
          totalHits: z
            .number()
            .int()
            .nonnegative()
            .describe('累计唯一命中次数；每日统计清理不会修改该值。'),
          lastAccessedAt: timestamp.describe('最近命中时间（Unix 毫秒）。'),
          hits7d: z
            .number()
            .int()
            .nonnegative()
            .describe('最近 7 个 UTC 日期（含今天）的命中次数之和。'),
          hits30d: z
            .number()
            .int()
            .nonnegative()
            .describe('最近 30 个 UTC 日期（含今天）的命中次数之和。'),
        }),
      )
      .max(100)
      .describe('有访问记录的条目；按 hits30d 降序、subjectId 升序，最多 100 条。'),
  }),
  AliasMissesResponse: z.object({
    enabled: z
      .boolean()
      .describe('当前是否启用 ALIAS_MISS_STATS_ENABLED；关闭后已有记录仍可管理。'),
    aliases: z
      .array(aliasMissSchema)
      .describe('先按 planned 筛选，再按次数降序、最近未命中时间降序、检索键升序返回。'),
  }),
  AliasMissPlanResponse: z.object({ alias: aliasMissSchema.describe('更新处理计划后的记录。') }),
  PruneResponse: z.object({
    deleted: z.number().int().min(0).max(1000).describe('本次删除的每日统计行数，最多 1000。'),
    hasMore: z
      .boolean()
      .describe('本次删除满 1000 行时为 true；应继续调用，最后一次可能删除 0 行。'),
  }),
  RetentionResponse: z.object({
    actionable: z.literal(false).describe('当前版本仅预览，始终 false，没有删除条目接口。'),
    reason: z.string().describe('仅预览或无法判断冷数据的原因。'),
    candidates: z
      .array(
        z.object({
          id: positiveId,
          name: nameSchema.describe('条目原名。'),
          cachedAt: timestamp.describe('首次入库时间（Unix 毫秒）。'),
          lastAccessedAt: timestamp
            .nullable()
            .describe('最近访问时间（Unix 毫秒）；未记录过访问为 null。'),
        }),
      )
      .max(100)
      .describe('按 ID 升序；入库和最后访问均早于阈值，且未固定保留的条目。统计关闭时为空。'),
  }),
  SyncStateResponse: z.object({
    value: z.string().nullable().describe('已保存的字符串；键不存在时为 null，不返回 404。'),
  }),
  SaveSyncStateResponse: z.object({
    saved: z.literal(true).describe('检查点已写入，覆盖同名键。'),
  }),
};

// 文档接口返回的是 OpenAPI 文档对象，paths/components 为可扩展规范结构。
export const openApiDocumentSchema = z
  .object({
    openapi: z.literal('3.1.0').describe('OpenAPI 规范版本。'),
    info: z
      .object({ title: z.string(), version: z.string(), description: z.string() })
      .passthrough()
      .describe('API 标识与说明。'),
    paths: z.record(z.string(), z.unknown()).describe('路径与操作定义。'),
    components: z.record(z.string(), z.unknown()).describe('可复用模型及安全方案。'),
  })
  .passthrough();
