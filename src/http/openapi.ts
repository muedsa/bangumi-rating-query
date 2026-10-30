import { z } from 'zod';
import {
  aliasSchema,
  batchSchema,
  importSchema,
  ratingSchema,
  subjectSchema,
} from '../core/models.ts';
import { backupSchema } from '../core/backup.ts';
import { calendarSyncResultSchema } from '../core/calendar.ts';
import { subjectSearchRequestSchema, subjectSearchResultSchema } from '../core/subject-search.ts';
import {
  aliasBodySchema,
  aliasMissPlanSchema,
  pruneBodySchema,
  syncStateBodySchema,
  errorSchema,
  openApiDocumentSchema,
  responseSchemas,
} from './contracts.ts';
import { apiErrors, type ApiErrorCode } from './openapi-errors.ts';
import {
  aliasExample,
  aliasMissExample,
  ambiguousExample,
  backupExample,
  example,
  matchedExample,
  ratingExample,
  subjectExample,
} from './openapi-examples.ts';

export { batchResponseSchema, matchedSchema } from './contracts.ts';

type Examples = Record<string, ReturnType<typeof example>>;
type Parameter = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
  example: string | number | boolean;
};
const idParam: Parameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: '本地或上游 Bangumi 条目 ID，正安全整数。',
  schema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  example: 100,
};
const aliasParam: Parameter = {
  name: 'aliasId',
  in: 'path',
  required: true,
  description: '从别名列表取得的记录 ID，须编码为单个 URL 路径段；仅支持 manual 来源。',
  schema: { type: 'string' },
  example: 'example-manual-100',
};
const keyParam: Parameter = {
  name: 'key',
  in: 'path',
  required: true,
  description: '检查点键，须编码为单个 URL 路径段；无额外业务长度限制。',
  schema: { type: 'string' },
  example: 'my-import',
};
const headers = {
  'X-Request-ID': {
    description: '服务端生成的请求关联 ID；排查失败时连同时间和 error.code 提供给管理员。',
    schema: { type: 'string', format: 'uuid' },
  },
  'Cache-Control': {
    description: '应用路由响应不缓存。Worker 初始化失败时不保证此头存在。',
    schema: { type: 'string', const: 'no-store' },
  },
  'X-Content-Type-Options': {
    description: '禁止内容类型嗅探。Worker 初始化失败时不保证此头存在。',
    schema: { type: 'string', const: 'nosniff' },
  },
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, examples: Examples) => ({
  'application/json': { schema: ref(name), examples },
});
function errorResponses(codes: ApiErrorCode[], maxBatchSize: number) {
  const grouped = new Map<number, ApiErrorCode[]>();
  for (const code of new Set(codes)) {
    const status = apiErrors[code].status;
    grouped.set(status, [...(grouped.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...grouped].map(([status, entries]) => [
      String(status),
      {
        description: entries
          .map((code) => `**${code}**：${apiErrors[code].description}`)
          .join('\n\n'),
        headers,
        content: json(
          'Error',
          Object.fromEntries(
            entries.map((code) => [
              code,
              example(
                {
                  error: {
                    code,
                    message:
                      code === 'BATCH_TOO_LARGE'
                        ? `每批最多 ${maxBatchSize} 条`
                        : apiErrors[code].message,
                    ...(code === 'INVALID_INPUT'
                      ? { issues: [{ path: [], message: '字段类型、范围或约束不满足' }] }
                      : {}),
                  },
                },
                code,
              ),
            ]),
          ),
        ),
      },
    ]),
  );
}
type OperationOptions = {
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  response: string;
  examples: Examples;
  success?: string;
  admin?: boolean;
  parameters?: Parameter[];
  body?: { schema: string; description: string; examples: Examples };
  errors?: ApiErrorCode[];
};
function operation(options: OperationOptions, maxBatchSize: number) {
  const errors: ApiErrorCode[] = ['BODY_TOO_LARGE', 'SERVICE_UNAVAILABLE', 'CONFIGURATION_ERROR'];
  if (options.admin) errors.push('UNAUTHORIZED', 'ADMIN_DISABLED');
  if (options.body) errors.push('INVALID_INPUT', 'INVALID_JSON');
  errors.push(...(options.errors ?? []));
  return {
    operationId: options.operationId,
    tags: [options.tag],
    summary: options.summary,
    description: options.description,
    security: options.admin ? [{ bearerAuth: [] }] : [],
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.body
      ? {
          requestBody: {
            required: true,
            description: options.body.description,
            content: json(options.body.schema, options.body.examples),
          },
        }
      : {}),
    responses: {
      '200': {
        description: options.success ?? '操作成功；返回结构见模型和示例。',
        headers,
        content: json(options.response, options.examples),
      },
      ...errorResponses(errors, maxBatchSize),
    },
  };
}

const documents = new Map<number, object>();
export function getOpenApi(maxBatchSize: number) {
  const cached = documents.get(maxBatchSize);
  if (cached) return cached;
  const outputSchemas = {
    Error: errorSchema,
    Subject: subjectSchema,
    Alias: aliasSchema,
    Rating: ratingSchema,
    BackupRecord: backupSchema,
    OpenApiDocument: openApiDocumentSchema,
    ...responseSchemas,
    CalendarSyncResponse: calendarSyncResultSchema,
    SearchResponse: subjectSearchResultSchema,
  };
  const inputSchemas = {
    BatchRequest: batchSchema.safeExtend({ items: batchSchema.shape.items.max(maxBatchSize) }),
    AliasWriteRequest: aliasBodySchema,
    SearchRequest: subjectSearchRequestSchema,
    ImportRequest: importSchema,
    RestoreRequest: backupSchema,
    AliasMissPlanRequest: aliasMissPlanSchema,
    PruneRequest: pruneBodySchema,
    SyncStateRequest: syncStateBodySchema,
  };
  const schemas = Object.fromEntries([
    ...Object.entries(outputSchemas).map(
      ([name, schema]) =>
        [name, z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })] as const,
    ),
    ...Object.entries(inputSchemas).map(
      ([name, schema]) =>
        [name, z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })] as const,
    ),
  ]);
  // Zod refinement 不会自动导出；将可表达的“至少一种查找方式”显式写入 JSON Schema。
  const batchItems = schemas.BatchRequest!.properties!.items as z.core.JSONSchema.JSONSchema;
  const queryItem = batchItems.items as z.core.JSONSchema.JSONSchema;
  queryItem.anyOf = ['subjectId', 'names'].map((key) => ({
    type: 'object',
    properties: { [key]: queryItem.properties![key]! },
    required: [key],
  }));
  (schemas.BatchResponse!.properties!.results as z.core.JSONSchema.JSONSchema).maxItems =
    maxBatchSize;
  (schemas.Error!.properties!.error as z.core.JSONSchema.JSONSchema).properties!.code = {
    type: 'string',
    enum: Object.keys(apiErrors),
    description: '稳定的错误代码；具体接口可返回的代码见对应 HTTP 状态的说明。',
  };
  const op = (options: OperationOptions) => operation(options, maxBatchSize);
  const body = (
    schema: string,
    value: unknown,
    description = 'JSON 请求对象；字段默认值仅在省略时应用，不能用 null 替代。',
  ) => ({ schema, description, examples: { default: example(value) } });
  const aliasWrite = {
    alias: {
      ...aliasExample,
      id: 'example-manual-100',
      name: '示例别名',
      normalizedName: '示例别名',
      source: 'manual',
    },
    conflictingSubjectIds: [],
  };
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'Bangumi 动画评分查询 API',
      version: '0.1.0',
      license: { name: 'MIT', identifier: 'MIT' },
      description: `仅提供 JSON，无前端。Node/SQLite/PostgreSQL 与 Worker/D1 共用 API。每批最多 ${maxBatchSize} 条，由当前部署 MAX_BATCH_SIZE 决定。查询仅访问本地缓存，不自动回源；未命中、歧义和日历部分完成均可能是 HTTP 200，须检查业务状态。\n\n管理接口使用 ADMIN_TOKEN；BANGUMI_ACCESS_TOKEN 仅由服务端访问上游时使用。请求体上限 256 KiB，所有响应带 X-Request-ID。导入、备份及统计时间为 Unix 毫秒；查询和日历 dataAsOf 为 UTC ISO 8601。未知路径或不支持的方法返回 404 NOT_FOUND（管理路径先执行鉴权），没有单独的 405 响应。此文档中的示例均为虚构数据。\n\n模型中的 required 表示必须提供；可空字段仍可能必填。服务端忽略未声明的 JSON 对象字段，跨字段唯一性和 ID 一致性仍以请求说明及服务端校验为准。`,
    },
    servers: [{ url: '/', description: '当前部署地址；本地默认 http://localhost:3000。' }],
    tags: [
      { name: '服务状态', description: '健康检查和机器可读接口契约。' },
      { name: '评分查询', description: '只查本地缓存，可按配置记录访问和未命中统计。' },
      { name: '别名管理', description: '手动别名维护及季数名称补全。' },
      { name: '上游同步', description: '服务端访问 Bangumi，须配置 BANGUMI_USER_AGENT。' },
      { name: '数据迁移', description: '标准化导入和跨存储备份恢复。' },
      { name: '统计维护', description: '访问统计、未命中处理、历史清理和冷数据预览。' },
      { name: '同步状态', description: '供 CLI 或客户端保存同步检查点。' },
    ],
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Authorization: Bearer <ADMIN_TOKEN>。这是本服务管理员令牌，不是 JWT，也不是 BANGUMI_ACCESS_TOKEN。未配置时返回 503 ADMIN_DISABLED。',
        },
      },
      responses: { NotFound: errorResponses(['NOT_FOUND'], maxBatchSize)['404'] },
    },
    paths: {
      '/health/live': {
        get: op({
          operationId: 'getLiveness',
          tag: '服务状态',
          summary: '存活检查',
          description: '不读取数据库。200 只表示应用可响应，不保证数据库可用。',
          response: 'LiveResponse',
          examples: { default: example({ status: 'ok' }) },
        }),
      },
      '/health/ready': {
        get: op({
          operationId: 'getReadiness',
          tag: '服务状态',
          summary: '数据库就绪检查',
          description:
            '检查数据库 schema 版本。缺表或连接失败可能返回 SERVICE_UNAVAILABLE；statisticsEnabled 仅表示访问统计开关。',
          response: 'ReadyResponse',
          examples: {
            default: example({ status: 'ok', schemaVersion: 4, statisticsEnabled: false }),
          },
          errors: ['NOT_READY'],
        }),
      },
      '/openapi.json': {
        get: op({
          operationId: 'getOpenApiDocument',
          tag: '服务状态',
          summary: '获取当前部署的 OpenAPI 3.1 文档',
          description:
            '无需鉴权，批量请求上限与当前部署一致。示例仅演示文档外层，实际响应包含全部路径、模型及示例。',
          response: 'OpenApiDocument',
          examples: {
            structure: example({
              openapi: '3.1.0',
              info: {
                title: 'Bangumi 动画评分查询 API',
                version: '0.1.0',
                description: '结构示例',
              },
              paths: {},
              components: {},
            }),
          },
        }),
      },
      '/api/v1/ratings/batch': {
        post: op({
          operationId: 'queryRatingsBatch',
          tag: '评分查询',
          summary: '按 ID 或多个名称批量查询评分',
          description: `每批 1～${maxBatchSize} 项，inputId 在批内唯一；每项至少提供 subjectId 或 names。显式 ID 优先，但仍应用 year/platform。官方 bgm.tv、bangumi.tv、chii.in 的 /subject/ID 链接可作为 names；纯数字作为名称。多个命中名称取交集，未命中名称不影响其他命中；不相交时返回 conflicting_names。结果与输入同序，歧义候选最多 20 条并按 ID 排序，每个候选包含缓存评分 rating、ratingStatus、dataAsOf 和 stale，含义与唯一命中一致。开启统计时记录唯一命中和未知名称，统计写入失败不改变查询成功结果。`,
          response: 'BatchResponse',
          success:
            '查询完成；逐项检查 status=matched、not_found 或 ambiguous，后两者不是 HTTP 错误。',
          body: {
            schema: 'BatchRequest',
            description: 'inputId 必须批内唯一；每个 item 至少含 subjectId 或 names。',
            examples: {
              byName: example(
                {
                  items: [
                    {
                      inputId: 'item-1',
                      names: ['示例动画', '示例动画中文名'],
                      year: 2026,
                      platform: 'TV',
                    },
                  ],
                },
                '使用多个已知名称及筛选',
              ),
              byId: example({ items: [{ inputId: 'item-1', subjectId: 100 }] }, '显式 ID'),
            },
          },
          examples: {
            matched: example({ results: [matchedExample] }),
            missing: example({ results: [{ inputId: 'item-2', status: 'not_found' }] }),
            ambiguous: example({ results: [ambiguousExample] }),
            unrated: example({
              results: [
                {
                  ...matchedExample,
                  rating: { ...matchedExample.rating, score: null },
                  ratingStatus: 'unrated',
                },
              ],
            }),
            unavailable: example({
              results: [
                {
                  ...matchedExample,
                  rating: null,
                  ratingStatus: 'unavailable',
                  dataAsOf: null,
                  stale: true,
                },
              ],
            }),
          },
          errors: ['BATCH_TOO_LARGE', 'TOO_MANY_CANDIDATES'],
        }),
      },
      '/api/v1/subjects/{id}': {
        get: op({
          operationId: 'getSubjectRating',
          tag: '评分查询',
          summary: '按 ID 查询单条评分',
          description:
            '只查询本地库，不自动同步。inputId 为 ID 字符串，matchedAliases 为空。启用访问统计时记录命中；条目存在但无评分仍返回 200。',
          parameters: [idParam],
          response: 'MatchedResponse',
          examples: {
            default: example({
              ...matchedExample,
              inputId: '100',
              matchReason: 'subject_id',
              matchedAliases: [],
            }),
          },
          errors: ['INVALID_INPUT', 'SUBJECT_NOT_FOUND'],
        }),
      },
      '/api/v1/subjects/{id}/aliases': {
        get: op({
          operationId: 'listSubjectAliases',
          tag: '评分查询',
          summary: '查询条目的全部别名',
          description: '按来源和名称排序，包含 bangumi/manual 来源及季数衍生别名；不记录访问统计。',
          parameters: [idParam],
          response: 'AliasesResponse',
          examples: { default: example({ aliases: [aliasExample] }) },
          errors: ['INVALID_INPUT', 'SUBJECT_NOT_FOUND'],
        }),
      },
      '/api/v1/admin/subjects/{id}/aliases': {
        post: op({
          operationId: 'addSubjectAlias',
          tag: '别名管理',
          admin: true,
          summary: '幂等添加手动别名',
          description:
            '条目必须先存在。同条目同名精确比较，存在则复用原记录（可能为 bangumi 来源）。互补第N季的中文/阿拉伯数字名称；第二季可为唯一匹配的第一季补全名称。清理相同检索键的未命中记录。conflictingSubjectIds 表示其他条目的同名冲突，不阻止写入。冲突查询发生在写入后，查询失败不表示别名未保存。',
          parameters: [idParam],
          body: body('AliasWriteRequest', { name: '示例别名' }),
          response: 'AliasWriteResponse',
          examples: {
            created: example(aliasWrite),
            reused: example({ alias: aliasExample, conflictingSubjectIds: [] }, '复用已有上游别名'),
          },
          errors: ['SUBJECT_NOT_FOUND', 'ALIAS_LIMIT', 'ALIAS_TOO_LONG', 'TOO_MANY_CANDIDATES'],
        }),
      },
      '/api/v1/admin/aliases/{aliasId}': {
        patch: op({
          operationId: 'updateManualAlias',
          tag: '别名管理',
          admin: true,
          summary: '修改手动别名',
          description:
            '仅修改 manual 来源。与同条目另一名称冲突时返回 409；否则补全季数变体并清理新名称对应未命中记录。不会自动删除旧名称的其他衍生别名。冲突查询在写入后执行，错误响应不保证未修改。',
          parameters: [aliasParam],
          body: body('AliasWriteRequest', { name: '示例别名' }),
          response: 'AliasWriteResponse',
          examples: { default: example(aliasWrite) },
          errors: [
            'ALIAS_NOT_FOUND',
            'ALIAS_EXISTS',
            'ALIAS_LIMIT',
            'ALIAS_TOO_LONG',
            'TOO_MANY_CANDIDATES',
          ],
        }),
        delete: op({
          operationId: 'deleteManualAlias',
          tag: '别名管理',
          admin: true,
          summary: '删除一个手动别名',
          description:
            '无请求正文。仅删除该 manual 记录，不级联删除季数衍生别名。不存在、重复删除或试图删除 bangumi 来源均返回 404。',
          parameters: [aliasParam],
          response: 'DeleteAliasResponse',
          examples: { default: example({ deleted: true }) },
          errors: ['ALIAS_NOT_FOUND'],
        }),
      },
      '/api/v1/admin/subjects/search': {
        post: op({
          operationId: 'searchBangumiSubjects',
          tag: '上游同步',
          admin: true,
          summary: '从 Bangumi 搜索动画候选',
          description:
            '需配置 BANGUMI_USER_AGENT；可选 BANGUMI_ACCESS_TOKEN。请求 /v0/search/subjects，按匹配度排序、筛选 type=2、offset=0；仅获取第一页，不写入数据库。total 为上游总数，可能大于返回候选数。无结果返回空数组。',
          body: body('SearchRequest', { keyword: '示例动画', limit: 10 }),
          response: 'SearchResponse',
          examples: {
            found: example({
              total: 1,
              candidates: [
                {
                  id: 100,
                  name: '示例动画',
                  nameCn: '示例动画中文名',
                  airDate: '2026-01-01',
                  platform: 'TV',
                  summary: '虚构剧情简介',
                  score: 8.1,
                  votes: 120,
                },
              ],
            }),
            empty: example({ total: 0, candidates: [] }),
          },
          errors: ['BANGUMI_SEARCH_DISABLED', 'BANGUMI_API_ERROR'],
        }),
      },
      '/api/v1/admin/subjects/{id}/sync': {
        post: op({
          operationId: 'syncBangumiSubject',
          tag: '上游同步',
          admin: true,
          summary: '从 Bangumi 同步一条动画',
          description:
            '无请求正文；本地不存在也可同步。只接受动画；使用服务端上游配置抓取详情并按版本导入，保留手动别名。上游 404、非动画、鉴权、限流及网络失败均映射为 503 BANGUMI_API_ERROR。',
          parameters: [idParam],
          response: 'ImportResponse',
          examples: { default: example({ imported: 100 }) },
          errors: [
            'INVALID_INPUT',
            'BANGUMI_SYNC_DISABLED',
            'BANGUMI_API_ERROR',
            'ALIAS_LIMIT',
            'ALIAS_TOO_LONG',
          ],
        }),
      },
      '/api/v1/admin/calendar/sync': {
        post: op({
          operationId: 'syncBangumiCalendar',
          tag: '上游同步',
          admin: true,
          summary: '同步全周放送日历并补全作品形式',
          description:
            '无请求正文；手动调用不受 CALENDAR_SYNC_ENABLED 定时开关控制。日历摘要合并保留既有详情、别名和排名，然后补全空 platform。单条详情失败不撤销已导入数据；status=partial 时仍返回 200，可再次调用重新抓取日历并继续补全。CALENDAR_PLATFORM_BATCH_SIZE 默认 10，允许任意正整数，不设业务上限。imported 是参与合并数量，不是新增数量。',
          response: 'CalendarSyncResponse',
          success: '同步完成或部分完成；检查 status、platformsRemaining 和 platformFailures。',
          examples: {
            complete: example({
              imported: 2,
              dataAsOf: '2026-01-01T00:00:00.000Z',
              platformsUpdated: 2,
              platformsRemaining: 0,
              platformFailures: [],
              status: 'complete',
            }),
            partial: example({
              imported: 2,
              dataAsOf: '2026-01-01T00:00:00.000Z',
              platformsUpdated: 1,
              platformsRemaining: 1,
              platformFailures: [101],
              status: 'partial',
            }),
          },
          errors: ['BANGUMI_SYNC_DISABLED', 'BANGUMI_API_ERROR', 'ALIAS_TOO_LONG'],
        }),
      },
      '/api/v1/admin/import': {
        post: op({
          operationId: 'importSubject',
          tag: '数据迁移',
          admin: true,
          summary: '导入一条标准化动画记录',
          description:
            '接受标准化数据，不接受原始 Archive 行或上游 JSON。rating.subjectId 必须与 subject.id 一致。较新 metadataAt 才更新元数据和 bangumi 来源别名，保留 manual、原 cachedAt/pinned；较新 dataAsOf 才更新评分，rating=null 不删除已有评分。自动补全季数名称并清理对应未命中记录。相同版本可以重放；imported 不表示数据一定发生变化。',
          body: body('ImportRequest', {
            subject: subjectExample,
            aliases: ['示例别称'],
            rating: ratingExample,
          }),
          response: 'ImportResponse',
          examples: { default: example({ imported: 100 }) },
          errors: ['ALIAS_LIMIT', 'ALIAS_TOO_LONG'],
        }),
      },
      '/api/v1/admin/export': {
        get: op({
          operationId: 'exportSubjects',
          tag: '数据迁移',
          admin: true,
          summary: '按 ID 游标导出备份',
          description:
            '返回 id > after 的最多 5 条记录，按 ID 升序。nextCursor 非 null 时继续请求；恰好满 5 条即产生游标，尾部可能还需请求一个空页。不提供全库一致性快照；不包含未命中统计、同步检查点或配置。',
          parameters: [
            {
              name: 'after',
              in: 'query',
              required: false,
              description: '上一页 nextCursor；首次省略或传 0。',
              schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
              example: 0,
            },
          ],
          response: 'ExportResponse',
          examples: {
            lastPage: example({ records: [backupExample], nextCursor: null }),
            empty: example({ records: [], nextCursor: null }),
          },
          errors: ['INVALID_INPUT'],
        }),
      },
      '/api/v1/admin/restore': {
        post: op({
          operationId: 'restoreSubject',
          tag: '数据迁移',
          admin: true,
          summary: '恢复一条完整备份',
          description:
            '逐条事务恢复，当前 subject.id 必须不存在；HTTP 接口不检查整个库为空。别名 ID、名称与来源组合、统计日期不得重复；各 subjectId 和 normalizedName 必须一致。兼容旧备份跨来源同名，保留 manual；不推断新的季数别名。已有条目返回 409，不能用于覆盖更新；响应丢失后重试可能返回 SUBJECT_EXISTS，应先核对数据。',
          body: body(
            'RestoreRequest',
            backupExample,
            'version=1 的单条备份，不是导出页外层或 JSONL 全文件。时间为 Unix 毫秒。',
          ),
          response: 'RestoreResponse',
          examples: { default: example({ restored: 100 }) },
          errors: ['SUBJECT_EXISTS', 'BACKUP_TOO_LARGE'],
        }),
      },
      '/api/v1/admin/stats': {
        get: op({
          operationId: 'getUsageStats',
          tag: '统计维护',
          admin: true,
          summary: '查询访问热度',
          description:
            '最多 100 条，按 hits30d 降序、subjectId 升序；7/30 天按包含今天的 UTC 日期计算。enabled=false 表示不再写新统计，已有统计仍可读取。',
          response: 'StatsResponse',
          examples: {
            default: example({
              enabled: true,
              subjects: [
                {
                  subjectId: 100,
                  name: '示例动画',
                  totalHits: 3,
                  lastAccessedAt: 1767225600000,
                  hits7d: 3,
                  hits30d: 3,
                },
              ],
            }),
          },
        }),
      },
      '/api/v1/admin/stats/alias-misses': {
        get: op({
          operationId: 'listAliasMisses',
          tag: '统计维护',
          admin: true,
          summary: '查询未命中别名统计',
          description:
            '先筛选计划状态，再按 missCount 降序、lastMissedAt 降序、normalizedName 升序取 limit 条。无业务数量上限，也无分页游标。开关关闭后仍可管理历史记录。新增匹配别名会清理对应归一化键的记录。',
          parameters: [
            {
              name: 'planned',
              in: 'query',
              required: false,
              description: 'true 仅计划处理，false 仅无计划；省略返回全部。只接受小写 true/false。',
              schema: { type: 'boolean' },
              example: true,
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description:
                '最多返回的记录数；默认 100，无额外业务上限，受安全整数及运行环境资源限制。',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                default: 100,
              },
              example: 1000,
            },
          ],
          response: 'AliasMissesResponse',
          examples: { default: example({ enabled: true, aliases: [aliasMissExample] }) },
          errors: ['INVALID_INPUT'],
        }),
        patch: op({
          operationId: 'setAliasMissPlan',
          tag: '统计维护',
          admin: true,
          summary: '设置未命中别名的处理计划',
          description:
            '按 name 的归一化键定位记录，只改变 planned。false 对应 CLI 的“无计划”；后续再次未命中不会自动重置为 true。已清理或不存在时返回 404。',
          body: body('AliasMissPlanRequest', { name: '尚未收录的名称', planned: false }),
          response: 'AliasMissPlanResponse',
          examples: { default: example({ alias: { ...aliasMissExample, planned: false } }) },
          errors: ['ALIAS_MISS_NOT_FOUND'],
        }),
      },
      '/api/v1/admin/stats/alias-misses/lookup': {
        get: op({
          operationId: 'getAliasMiss',
          tag: '统计维护',
          admin: true,
          summary: '精确查询单个未命中别名的当前状态',
          description:
            '按 name 的归一化键查询，包含无计划记录，不受列表排名或 limit 影响。不存在或已清理时返回 alias=null，不返回 404；此查询不写入访问或未命中统计。统计开关关闭后仍可查询历史记录。',
          parameters: [
            {
              name: 'name',
              in: 'query',
              required: true,
              description: '原未命中名称；去除首尾空白后须为 1～300 字符，按归一化检索键定位。',
              schema: { type: 'string', minLength: 1, maxLength: 300 },
              example: '尚未收录的名称',
            },
          ],
          response: 'AliasMissLookupResponse',
          examples: {
            planned: example({ alias: aliasMissExample }),
            unplanned: example({ alias: { ...aliasMissExample, planned: false } }),
            absent: example({ alias: null }),
          },
          errors: ['INVALID_INPUT'],
        }),
      },
      '/api/v1/admin/stats/prune': {
        post: op({
          operationId: 'pruneDailyStats',
          tag: '统计维护',
          admin: true,
          summary: '分批清理旧每日统计',
          description:
            '保留含今天的最近 days 个 UTC 日期；每次最多删除 1000 行。hasMore=true 时重复调用，最后一次可能删除 0 行。不影响累计次数、最近访问时间或未命中统计。采用默认值仍须发送 {}。',
          body: body('PruneRequest', {}),
          response: 'PruneResponse',
          examples: { default: example({ deleted: 12, hasMore: false }) },
        }),
      },
      '/api/v1/admin/retention': {
        get: op({
          operationId: 'previewRetention',
          tag: '统计维护',
          admin: true,
          summary: '预览冷数据候选',
          description:
            '仅预览，不删除，actionable 始终 false。入库时间及最后访问均早于 now-days×24h、pinned=false 的条目成为候选；无访问记录时按入库时间判断。最多 100 条，按 ID 升序。统计关闭时不推断冷数据，返回空候选。',
          parameters: [
            {
              name: 'days',
              in: 'query',
              required: false,
              description: '冷却天数，默认 90；与统计清理接口的最小天数不同。',
              schema: { type: 'integer', minimum: 1, maximum: 3650, default: 90 },
              example: 90,
            },
          ],
          response: 'RetentionResponse',
          examples: {
            disabled: example({
              actionable: false,
              reason: '访问统计未启用，无法判断冷数据',
              candidates: [],
            }),
            preview: example({
              actionable: false,
              reason: '仅预览，不执行删除',
              candidates: [
                { id: 100, name: '示例动画', cachedAt: 1767225600000, lastAccessedAt: null },
              ],
            }),
          },
          errors: ['INVALID_INPUT'],
        }),
      },
      '/api/v1/admin/sync-state/{key}': {
        get: op({
          operationId: 'getSyncState',
          tag: '同步状态',
          admin: true,
          summary: '读取同步检查点',
          description: '返回不透明字符串；不存在时为 200 和 value=null，不返回 404。',
          parameters: [keyParam],
          response: 'SyncStateResponse',
          examples: { found: example({ value: '{"line":20}' }), missing: example({ value: null }) },
        }),
        put: op({
          operationId: 'saveSyncState',
          tag: '同步状态',
          admin: true,
          summary: '写入同步检查点',
          description:
            '覆盖同名键，无版本比较；value 可为空字符串。若内容为 JSON，先序列化成字符串。客户端负责保存时机和并发协调，不要覆盖正在运行的 CLI 检查点。',
          parameters: [keyParam],
          body: body('SyncStateRequest', { value: '{"line":20}' }),
          response: 'SaveSyncStateResponse',
          examples: { default: example({ saved: true }) },
        }),
      },
    },
  };
  documents.set(maxBatchSize, document);
  return document;
}
