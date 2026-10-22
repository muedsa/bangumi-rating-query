import { z } from 'zod';
import { aliasSchema, batchSchema, importSchema, nameSchema } from '../core/models.ts';
import { backupSchema } from '../core/backup.ts';
import { calendarSyncResultSchema } from '../core/calendar.ts';
import { subjectSearchRequestSchema, subjectSearchResultSchema } from '../core/subject-search.ts';

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});
const subject = z.object({
  id: z.number().int(),
  name: z.string(),
  nameCn: z.string(),
  airDate: z.string().nullable(),
  platform: z.string(),
  url: z.url(),
});
export const matchedSchema = z.object({
  inputId: z.string(),
  status: z.literal('matched'),
  subject,
  matchReason: z.enum(['subject_id', 'exact_alias', 'normalized_alias']),
  matchedAliases: z.array(z.object({ name: z.string(), source: z.enum(['bangumi', 'manual']) })),
  rating: z
    .object({
      score: z.number().nullable(),
      votes: z.number().int(),
      rank: z.number().int().nullable(),
      source: z.enum(['archive', 'api']),
    })
    .nullable(),
  ratingStatus: z.enum(['unavailable', 'unrated', 'available']),
  dataAsOf: z.string().nullable(),
  stale: z.boolean(),
});
export const batchResponseSchema = z.object({
  results: z.array(
    z.union([
      matchedSchema,
      z.object({ inputId: z.string(), status: z.literal('not_found') }),
      z.object({
        inputId: z.string(),
        status: z.literal('ambiguous'),
        matchReason: z.enum(['conflicting_names', 'shared_alias']),
        candidates: z.array(subject),
        candidatesTruncated: z.boolean(),
      }),
    ]),
  ),
});
const anyObject = z.record(z.string(), z.unknown());
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
const aliasParam = { name: 'aliasId', in: 'path', required: true, schema: { type: 'string' } };
function json(schema: z.ZodType) {
  return { 'application/json': { schema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) } };
}
function operation(
  summary: string,
  response: z.ZodType,
  options: { body?: z.ZodType; admin?: boolean; parameters?: unknown[] } = {},
) {
  const headers = {
    'X-Request-ID': {
      description: '服务端生成的请求关联 ID，用于查找错误日志',
      schema: { type: 'string', format: 'uuid' },
    },
  };
  return {
    summary,
    ...(options.admin ? { security: [{ bearerAuth: [] }] } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.body ? { requestBody: { required: true, content: json(options.body) } } : {}),
    responses: {
      '200': { description: '成功', content: json(response), headers },
      '400': { description: '参数无效', content: json(errorSchema), headers },
      '401': { description: '管理凭证无效', content: json(errorSchema), headers },
      '404': { description: '资源不存在', content: json(errorSchema), headers },
      '409': { description: '资源冲突', content: json(errorSchema), headers },
      '413': { description: '请求体超过 256 KiB', content: json(errorSchema), headers },
      '503': { description: '服务不可用或管理接口关闭', content: json(errorSchema), headers },
    },
  };
}
const documents = new Map<number, object>();
export function getOpenApi(maxBatchSize: number) {
  const cached = documents.get(maxBatchSize);
  if (cached) return cached;
  const aliasBody = z.object({ name: nameSchema });
  const aliasResult = z.object({
    alias: aliasSchema,
    conflictingSubjectIds: z.array(z.number().int()),
  });
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'Bangumi 动画评分查询 API',
      version: '0.1.0',
      description: `纯 JSON API。每批最多 ${maxBatchSize} 条、每项最多 5 个已知名称。数字名称不会自动当作 ID，请使用 subjectId。按输入顺序返回；共享别名或冲突名称返回候选。数据库整体故障返回 HTTP 503，不伪装成未收录。内部导入/备份时间为 Unix 毫秒，查询 dataAsOf 为 ISO 8601。`,
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/health/live': { get: operation('存活检查', z.object({ status: z.literal('ok') })) },
      '/health/ready': { get: operation('数据库与配置就绪检查', anyObject) },
      '/api/v1/ratings/batch': {
        post: operation('批量匹配与评分查询', batchResponseSchema, {
          body: batchSchema.safeExtend({ items: batchSchema.shape.items.max(maxBatchSize) }),
        }),
      },
      '/api/v1/subjects/{id}': {
        get: operation('按条目 ID 查询', matchedSchema, { parameters: [idParam] }),
      },
      '/api/v1/subjects/{id}/aliases': {
        get: operation('列出条目别名', z.object({ aliases: z.array(aliasSchema) }), {
          parameters: [idParam],
        }),
      },
      '/api/v1/admin/subjects/{id}/aliases': {
        post: operation(
          '幂等添加手动别名，互补末尾季数的中阿数字写法并补全唯一匹配的第一季别名',
          aliasResult,
          {
            admin: true,
            parameters: [idParam],
            body: aliasBody,
          },
        ),
      },
      '/api/v1/admin/subjects/{id}/sync': {
        post: operation(
          '使用服务端 Bangumi 凭证更新一条动画；需配置 BANGUMI_USER_AGENT',
          z.object({ imported: z.number().int() }),
          { admin: true, parameters: [idParam] },
        ),
      },
      '/api/v1/admin/subjects/search': {
        post: operation(
          '使用服务端 Bangumi 凭证按匹配度搜索动画候选，不导入数据',
          subjectSearchResultSchema,
          {
            admin: true,
            body: subjectSearchRequestSchema,
          },
        ),
      },
      '/api/v1/admin/calendar/sync': {
        post: operation(
          '从 Bangumi calendar 批量导入并分批补全空作品形式，保留已有详情/别名/排名；partial 时可再次调用继续',
          calendarSyncResultSchema,
          { admin: true },
        ),
      },
      '/api/v1/admin/aliases/{aliasId}': {
        patch: operation('修改手动别名，并应用季数别名补全规则', aliasResult, {
          admin: true,
          parameters: [aliasParam],
          body: aliasBody,
        }),
        delete: operation('删除手动别名；不能删除上游别名', z.object({ deleted: z.boolean() }), {
          admin: true,
          parameters: [aliasParam],
        }),
      },
      '/api/v1/admin/import': {
        post: operation(
          '导入一条标准化动画数据，自动补全季数别名；不覆盖手动别名',
          z.object({ imported: z.number().int() }),
          { admin: true, body: importSchema },
        ),
      },
      '/api/v1/admin/export': {
        get: operation(
          '按 ID 游标导出最多 5 条完整备份',
          z.object({ records: z.array(backupSchema), nextCursor: z.number().nullable() }),
          {
            admin: true,
            parameters: [
              { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
            ],
          },
        ),
      },
      '/api/v1/admin/restore': {
        post: operation('恢复一条备份；已存在则拒绝', z.object({ restored: z.number().int() }), {
          admin: true,
          body: backupSchema,
        }),
      },
      '/api/v1/admin/stats': {
        get: operation('最近 7/30 天及累计热度，最多 100 条', anyObject, { admin: true }),
      },
      '/api/v1/admin/stats/alias-misses': {
        get: operation(
          '未知别名的累计未命中次数，按次数降序最多 100 条',
          z.object({
            enabled: z.boolean(),
            aliases: z.array(
              z.object({
                name: z.string(),
                normalizedName: z.string(),
                missCount: z.number().int().positive(),
                firstMissedAt: z.number().int(),
                lastMissedAt: z.number().int(),
              }),
            ),
          }),
          { admin: true },
        ),
      },
      '/api/v1/admin/stats/prune': {
        post: operation(
          '分批清理历史每日统计；累计次数与最近访问时间不变',
          z.object({ deleted: z.number().int(), hasMore: z.boolean() }),
          { admin: true, body: z.object({ days: z.number().int().min(30).max(3650).default(90) }) },
        ),
      },
      '/api/v1/admin/retention': {
        get: operation('冷数据预览，不执行删除', anyObject, {
          admin: true,
          parameters: [
            {
              name: 'days',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 3650, default: 90 },
            },
          ],
        }),
      },
      '/api/v1/admin/sync-state/{key}': {
        get: operation('读取同步检查点', z.object({ value: z.string().nullable() }), {
          admin: true,
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        }),
        put: operation('保存同步检查点', z.object({ saved: z.boolean() }), {
          admin: true,
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          body: z.object({ value: z.string().max(10000) }),
        }),
      },
    },
  };
  documents.set(maxBatchSize, document);
  return document;
}
