# HTTP API 使用与参考

本服务提供 JSON API，Cloudflare Worker + D1 与 Node.js + SQLite/PostgreSQL 使用相同契约。公开查询只读取已收录数据，不自动调用 Bangumi；导入、同步和人工别名维护由管理接口完成。

本文对应 API `0.1.0`。机器可读定义由 `GET /openapi.json` 提供，使用 OpenAPI **3.1.0** 和 JSON Schema 2020-12，包含命名模型、字段说明、请求和响应示例、鉴权及逐接口错误码。批量上限取当前部署的配置；对接部署时应下载该实例的定义。服务不提供 Swagger UI 页面。

## 目录

- [开始调用](#开始调用)
- [通用约定](#通用约定)
- [接口索引](#接口索引)
- [服务状态](#服务状态)
- [评分与别名查询](#评分与别名查询)
- [手动别名管理](#手动别名管理)
- [Bangumi 搜索与同步](#bangumi-搜索与同步)
- [导入导出与恢复](#导入导出与恢复)
- [统计与冷数据](#统计与冷数据)
- [同步检查点](#同步检查点)
- [数据模型](#数据模型)
- [错误与重试](#错误与重试)
- [常见工作流](#常见工作流)

## 开始调用

自部署默认地址为 `http://localhost:3000`；Worker 使用实际域名。下面使用本地地址和虚构条目 ID，不依赖生产数据。服务启动与数据库迁移见 [README](../README.md)。

```sh
curl http://localhost:3000/health/ready
curl http://localhost:3000/openapi.json -o openapi.json
```

将批量查询保存到 UTF-8 文件 `request.json`：

```json
{
  "items": [
    { "inputId": "row-1", "names": ["示例动画", "示例别称"] },
    { "inputId": "row-2", "subjectId": 100 }
  ]
}
```

```sh
curl http://localhost:3000/api/v1/ratings/batch \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
```

Windows PowerShell 建议明确使用 `curl.exe`，从文件发送 JSON，避免不同版本的命令行引号转义问题：

```powershell
curl.exe 'http://localhost:3000/api/v1/ratings/batch' -H 'Content-Type: application/json' --data-binary '@request.json'
```

也可以原生发送 UTF-8 JSON：

```powershell
$payload = @{ items = @(@{ inputId = 'row-1'; names = @('示例动画') }) } | ConvertTo-Json -Depth 5 -Compress
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/ratings/batch' -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
```

### 管理鉴权

所有 `/api/v1/admin/*` 接口都需要本服务的管理令牌：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

| 配置                   | 用途                                       | 谁发送                |
| ---------------------- | ------------------------------------------ | --------------------- |
| `ADMIN_TOKEN`          | 本服务管理接口鉴权，非空时至少 32 字符     | 调用方向本服务发送    |
| `BANGUMI_ACCESS_TOKEN` | 可选的 Bangumi 上游认证，使用 Bearer Token | 服务端向 Bangumi 发送 |
| `BANGUMI_USER_AGENT`   | 上游请求的应用标识，启用搜索和同步所需     | 服务端向 Bangumi 发送 |

管理令牌不是 JWT。未配置 `ADMIN_TOKEN` 返回 `503 ADMIN_DISABLED`；已配置但请求缺少或使用错误令牌返回 `401 UNAUTHORIZED`。公开接口不需要令牌。不要把 Bangumi Token 当成管理令牌发给本服务。

假设终端环境已经设置 `ADMIN_TOKEN`，调用示例：

```sh
curl http://localhost:3000/api/v1/admin/stats -H "Authorization: Bearer $ADMIN_TOKEN"
```

```powershell
curl.exe 'http://localhost:3000/api/v1/admin/stats' -H "Authorization: Bearer $env:ADMIN_TOKEN"
```

Worker 的两个 Token 均使用 Cloudflare Secret；Node 使用服务端环境变量。配置方法见 [README](../README.md#cloudflare-worker-部署)。远程 CLI 不需要持有服务端的 Bangumi Token。

## 通用约定

| 项目         | 约定                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| 请求与响应   | JSON；有正文时发送 `Content-Type: application/json`，字段名区分大小写                   |
| 请求体限制   | 最多 262144 字节（256 KiB），所有路径生效，先于管理鉴权检查                             |
| 必填与默认值 | 表中“必填”不能省略；默认值在省略时应用，`null` 不等于省略。可空字段也可能必填           |
| 未声明字段   | 普通请求对象会忽略未知字段；不要依赖未知字段被保存                                      |
| 数值         | 正文中的数值用 JSON number，不传字符串。ID 为 `1..9007199254740991` 的整数              |
| 名称         | 名称字段通常先去首尾空白，再要求长度 1～300；归一化键另见下文                           |
| 时间戳       | 导入、备份、别名、统计中的时间为 **Unix 毫秒**，不是秒；范围 `0..8640000000000000`      |
| 时间字符串   | 查询与日历响应的 `dataAsOf` 为 UTC ISO 8601，如 `2026-01-01T00:00:00.000Z`              |
| 日期         | `airDate`、统计 `day` 为 `YYYY-MM-DD`；模型校验字符串形式，不保证日历日期有效           |
| 路径         | `{id}`、`{aliasId}`、`{key}` 是占位符；字符串路径参数编码为单个 URL 路径段              |
| 查询参数     | 通过 URL 传递；`planned` 只接受小写 `true` 或 `false`                                   |
| 缓存与日志   | 应用路由带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Request-ID` |
| 异常定位     | `X-Request-ID` 是服务端生成的 UUID，成功和失败均可取得；内部细节记录在服务端日志        |
| HTTP 状态    | 当前所有成功操作使用 200，包括创建、删除、未命中、歧义及日历部分完成                    |

Worker 初始化失败返回 `503 CONFIGURATION_ERROR` 并带 `X-Request-ID`，但不保证另外两个响应头存在。Node 初始化失败通常直接退出，无 HTTP 响应。平台或反向代理自身生成的超时、限流等响应不属于本服务 JSON 契约。

归一化依次执行：Unicode NFKC、去首尾空白、连续空白合并为一个空格、转小写。不执行繁简转换、模糊匹配，也不删除标点或季数。数据库别名唯一约束为 `(subject_id, name)`，按实际名称精确比较；归一化相同的不同写法可以并存。

服务没有 CORS 中间件，也没有内置应用级请求限流。部署平台额度仍生效，尤其是开启统计或批量导入时。

## 接口索引

共 19 个路径、22 个操作。所有管理接口适用[通用管理错误](#通用错误范围)。

| 方法   | 路径                                  | 用途                   | 管理鉴权 |
| ------ | ------------------------------------- | ---------------------- | -------- |
| GET    | `/health/live`                        | 存活检查               | 否       |
| GET    | `/health/ready`                       | 数据库就绪检查         | 否       |
| GET    | `/openapi.json`                       | 当前部署的机器可读文档 | 否       |
| POST   | `/api/v1/ratings/batch`               | 批量评分查询           | 否       |
| GET    | `/api/v1/subjects/{id}`               | 按 ID 查询评分         | 否       |
| GET    | `/api/v1/subjects/{id}/aliases`       | 列出别名               | 否       |
| POST   | `/api/v1/admin/subjects/{id}/aliases` | 添加手动别名           | 是       |
| PATCH  | `/api/v1/admin/aliases/{aliasId}`     | 修改手动别名           | 是       |
| DELETE | `/api/v1/admin/aliases/{aliasId}`     | 删除手动别名           | 是       |
| POST   | `/api/v1/admin/subjects/search`       | 搜索 Bangumi 动画      | 是       |
| POST   | `/api/v1/admin/subjects/{id}/sync`    | 同步一条动画           | 是       |
| POST   | `/api/v1/admin/calendar/sync`         | 同步全周放送日历       | 是       |
| POST   | `/api/v1/admin/import`                | 导入标准化数据         | 是       |
| GET    | `/api/v1/admin/export`                | 分页导出备份           | 是       |
| POST   | `/api/v1/admin/restore`               | 恢复单条备份           | 是       |
| GET    | `/api/v1/admin/stats`                 | 访问热度               | 是       |
| GET    | `/api/v1/admin/stats/alias-misses`    | 未命中别名统计         | 是       |
| PATCH  | `/api/v1/admin/stats/alias-misses`    | 修改处理计划           | 是       |
| POST   | `/api/v1/admin/stats/prune`           | 清理旧每日统计         | 是       |
| GET    | `/api/v1/admin/retention`             | 冷数据预览             | 是       |
| GET    | `/api/v1/admin/sync-state/{key}`      | 读取检查点             | 是       |
| PUT    | `/api/v1/admin/sync-state/{key}`      | 保存检查点             | 是       |

## 服务状态

### GET /health/live

无参数、无正文。不访问数据库。

```json
{ "status": "ok" }
```

200 只表示服务可响应。数据库未就绪时该接口仍可能成功。

### GET /health/ready

无参数、无正文。检查数据库 schema 版本。

```json
{ "status": "ok", "schemaVersion": 4, "statisticsEnabled": false }
```

`schemaVersion` 是数据库结构版本，与 API 版本和备份 `version` 独立。`statisticsEnabled` 对应 `STATS_ENABLED`，不表示未命中统计开关。结构版本不匹配返回 `503 NOT_READY`；缺表、连接故障通常返回 `503 SERVICE_UNAVAILABLE`。

当前初始迁移已合并并直接建立第 4 版结构，迁移框架仍保留以供后续升级。发布前第 1～3 版旧结构不再自动升级，需要通过旧版服务导出业务备份后恢复到新库；具体流程见 [README](../README.md#初始迁移与后续升级)。

### GET /openapi.json

无参数、无正文。返回完整规范对象，顶层包括 `openapi`、`info`、`servers`、`tags`、`paths`、`components`。`components.schemas` 内包含全部请求和返回模型；每个操作有唯一 `operationId` 和中文说明。`BatchRequest.items.maxItems` 与当前 `MAX_BATCH_SIZE` 一致。

结构示意（省略实际路径和模型）：

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Bangumi 动画评分查询 API", "version": "0.1.0", "description": "接口说明" },
  "paths": {},
  "components": {}
}
```

## 评分与别名查询

### POST /api/v1/ratings/batch

正文为 `{ "items": [...] }`，`items` 必填，长度 1～`MAX_BATCH_SIZE`；部署配置范围 1～20，默认 20。每个元素：

| 字段        | 类型     | 必填                  | 约束与含义                                               |
| ----------- | -------- | --------------------- | -------------------------------------------------------- |
| `inputId`   | string   | 是                    | 1～100 字符，批内唯一；响应原样返回                      |
| `subjectId` | integer  | 与 names 至少一个     | 正安全整数，显式指定条目                                 |
| `names`     | string[] | 与 subjectId 至少一个 | 同一动画的 1～5 个已知名称，每项去首尾空白后 1～300 字符 |
| `year`      | integer  | 否                    | 1800～2200，按首播年份筛选，日期未知的不匹配             |
| `platform`  | string   | 否                    | 去首尾空白后 1～100 字符，按归一化后的作品形式相等筛选   |

最小请求：

```json
{ "items": [{ "inputId": "row-1", "names": ["示例动画"] }] }
```

匹配规则：

1. `subjectId` 优先，忽略 `names`，但仍应用 `year` 和 `platform`。
2. `names` 支持 `http/https` 的 `bgm.tv`、`bangumi.tv`、`chii.in` 官方 `/subject/123` 链接。纯数字名称如 `86` 仍当名称。
3. 多个有结果的名称取候选交集。未知辅助名称不阻止已知名称命中；多个名称指向不相交集合时返回 `conflicting_names`。
4. 返回顺序与 `items` 一致。同一条目可用不同 `inputId` 重复查询，每项都有响应。
5. 歧义候选按 ID 升序，最多 20 条，超出时 `candidatesTruncated=true`。即使年份筛选后只剩一个冲突候选，也不会自动消除 `conflicting_names`。

唯一命中示例：

```json
{
  "results": [
    {
      "inputId": "row-1",
      "status": "matched",
      "subject": {
        "id": 100,
        "name": "示例动画",
        "nameCn": "示例动画中文名",
        "airDate": "2026-01-01",
        "platform": "TV",
        "url": "https://bgm.tv/subject/100"
      },
      "matchReason": "exact_alias",
      "matchedAliases": [{ "name": "示例动画", "source": "bangumi" }],
      "rating": { "score": 8.1, "votes": 120, "rank": 50, "source": "archive" },
      "ratingStatus": "available",
      "dataAsOf": "2026-01-01T00:00:00.000Z",
      "stale": true
    }
  ]
}
```

`matched` 字段：

| 字段             | 含义                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `subject`        | 公开条目：ID、原名、中文名、日期、形式、Bangumi URL；不包含内部时间或 pinned                  |
| `matchReason`    | `subject_id`：显式 ID 或官方链接；`exact_alias`：实际名称相等；`normalized_alias`：归一化相等 |
| `matchedAliases` | 实际参与匹配的别名及来源；显式 ID 查询为空数组                                                |
| `rating`         | 评分的 score、votes、rank、source；不存在评分记录时为 null                                    |
| `ratingStatus`   | `available`：score 非 null；`unrated`：有记录但 score=null；`unavailable`：没有评分记录       |
| `dataAsOf`       | 评分版本的 ISO 时间；无评分记录时 null                                                        |
| `stale`          | 无评分或评分版本距当前时间超过 `RATING_TTL_HOURS`（默认 24）时为 true，不触发自动刷新         |

无匹配仍为 HTTP 200：

```json
{ "results": [{ "inputId": "row-1", "status": "not_found" }] }
```

有歧义仍为 HTTP 200：

```json
{
  "results": [
    {
      "inputId": "row-1",
      "status": "ambiguous",
      "matchReason": "shared_alias",
      "candidates": [
        {
          "id": 100,
          "name": "示例动画",
          "nameCn": "",
          "airDate": "2026-01-01",
          "platform": "TV",
          "url": "https://bgm.tv/subject/100",
          "rating": { "score": 8.1, "votes": 120, "rank": 50, "source": "archive" },
          "ratingStatus": "available",
          "dataAsOf": "2026-01-01T00:00:00.000Z",
          "stale": true
        },
        {
          "id": 101,
          "name": "另一部动画",
          "nameCn": "",
          "airDate": null,
          "platform": "",
          "url": "https://bgm.tv/subject/101",
          "rating": null,
          "ratingStatus": "unavailable",
          "dataAsOf": null,
          "stale": true
        }
      ],
      "candidatesTruncated": false
    }
  ]
}
```

`matchReason` 为 `shared_alias` 或 `conflicting_names`。`candidates` 中每项保留公开条目字段，并附带 `rating`、`ratingStatus`、`dataAsOf` 和 `stale`，含义与上文唯一命中一致：有评分记录时返回 score、votes、rank、source；有记录但未评分时 `rating.score=null`、`ratingStatus="unrated"`；没有评分记录时 `rating=null`、`ratingStatus="unavailable"`、`dataAsOf=null`、`stale=true`。

候选评分直接取自已缓存数据，不触发 Bangumi API 刷新；候选仍按 ID 排序，不按评分排序或自动选定。选定候选后可按 ID 查询。不要把未评分当作 0 分，也不要把 `stale=true` 当作请求失败。仅展示歧义候选不计入条目访问统计。

访问统计启用时，同一请求中每个唯一命中条目只计一次。未命中统计启用时，每个未知归一化名称只计一次；即使该项通过另一个名称命中，也可能记录未知的辅助名称。显式 ID、官方链接、已知但年份不符的别名、歧义别名不作为未知名称。统计写入失败只记录日志，不把成功查询改为失败。

特有错误：`400 BATCH_TOO_LARGE`、`400 TOO_MANY_CANDIDATES`。字段错误为 `INVALID_INPUT`；超过基础校验的 50 项时也可能先返回 `INVALID_INPUT`。数据库故障返回 503，不会伪装成 `not_found`。

### GET /api/v1/subjects/{id}

路径 `id` 必填，正安全整数。无正文。响应是上文的单个 `matched` 对象，**没有 `results` 外层**，其中 `inputId` 是 ID 的十进制字符串，`matchReason="subject_id"`，`matchedAliases=[]`。

条目存在但无评分时仍返回 200：`rating=null`、`ratingStatus="unavailable"`、`dataAsOf=null`、`stale=true`。开启访问统计时记录命中。非法 ID 返回 `400 INVALID_INPUT`，未收录返回 `404 SUBJECT_NOT_FOUND`。

### GET /api/v1/subjects/{id}/aliases

路径 `id` 必填，正安全整数。无正文。不记录访问统计。

```json
{
  "aliases": [
    {
      "id": "example-alias-100",
      "subjectId": 100,
      "name": "示例动画",
      "normalizedName": "示例动画",
      "source": "bangumi",
      "createdAt": 1767225600000,
      "updatedAt": 1767225600000
    }
  ]
}
```

包含所有来源及自动生成的别名，按来源、名称排序。完整字段见 [Alias](#alias)。非法 ID 返回 `400 INVALID_INPUT`，未收录返回 `404 SUBJECT_NOT_FOUND`。

## 手动别名管理

### POST /api/v1/admin/subjects/{id}/aliases

路径 `id` 必填，正安全整数，条目须已存在。正文：

```json
{ "name": "示例别名" }
```

`name` 必填，去首尾空白后为 1～300 字符。响应：

```json
{
  "alias": {
    "id": "example-manual-100",
    "subjectId": 100,
    "name": "示例别名",
    "normalizedName": "示例别名",
    "source": "manual",
    "createdAt": 1767225600000,
    "updatedAt": 1767225600000
  },
  "conflictingSubjectIds": []
}
```

同条目已有完全同名记录时复用原 ID、来源和时间，因此响应 `alias.source` 可能为 `bangumi`。跨条目同名允许写入，其他条目 ID 放在 `conflictingSubjectIds`；该数组同时检查原名和季数互补名，不应假定顺序。插入或复用会清理对应未命中统计。

写入 `第2季` 会补充 `第二季`，反之亦然。对第二季优先查找第一季别名，无匹配时按无季数名称查找；只有唯一匹配其他条目才为其添加 `第一季` 和 `第1季`。该过程只查本地库，并保留名称来源；详细规则见 [README](../README.md#手动别名)。

特有错误：`404 SUBJECT_NOT_FOUND`；`400 ALIAS_LIMIT`、`ALIAS_TOO_LONG`、`TOO_MANY_CANDIDATES`。容量或长度校验失败时不提交该次别名写入；但 **冲突查询发生在写入之后**，`TOO_MANY_CANDIDATES` 或内部错误不保证别名未保存，应查询列表核对。

### PATCH /api/v1/admin/aliases/{aliasId}

路径 `aliasId` 必填，从列表取得，不要求 UUID 格式。正文与返回结构同添加接口。只能修改 `manual` 来源，仍会补充季数变体和清理新名称对应的未命中记录，不会删除旧名称的其他衍生记录。

不存在或为 `bangumi` 来源返回 `404 ALIAS_NOT_FOUND`；与同条目另一个实际名称重复返回 `409 ALIAS_EXISTS`，原记录保留。还可能返回 `400 ALIAS_LIMIT`、`ALIAS_TOO_LONG`、`TOO_MANY_CANDIDATES`。同样要区分写入阶段与后续冲突查询失败。

### DELETE /api/v1/admin/aliases/{aliasId}

路径 `aliasId` 必填，无正文。

```json
{ "deleted": true }
```

只删除指定的手动记录，不级联删除衍生别名。不存在、重复删除或试图删除 `bangumi` 来源时返回 `404 ALIAS_NOT_FOUND`，不会返回 `deleted=false`。

## Bangumi 搜索与同步

三个接口都使用服务端的 `BANGUMI_USER_AGENT` 和可选 `BANGUMI_ACCESS_TOKEN`。Token 配置后，访问 Bangumi API 时使用 `Authorization: Bearer ...`；调用方只需提供管理令牌。

### POST /api/v1/admin/subjects/search

| 正文字段  | 类型    | 必填 | 约束                     |
| --------- | ------- | ---- | ------------------------ |
| `keyword` | string  | 是   | 去首尾空白后 1～300 字符 |
| `limit`   | integer | 否   | 1～50，默认 10           |

```json
{ "keyword": "示例动画", "limit": 10 }
```

服务调用 Bangumi `/v0/search/subjects`，固定 `sort=match`、动画筛选 `type=[2]`、`offset=0`，只获取第一页。搜索不导入数据。

```json
{
  "total": 1,
  "candidates": [
    {
      "id": 100,
      "name": "示例动画",
      "nameCn": "示例动画中文名",
      "airDate": "2026-01-01",
      "platform": "TV",
      "summary": "虚构剧情简介",
      "score": 8.1,
      "votes": 120
    }
  ]
}
```

候选按上游匹配度排序并按 ID 去重，最多 `limit` 条；`total` 是上游总匹配数，可能大于候选数。`summary` 最多 500 字符；缺中文名、形式、简介时为空字符串，日期/评分未知为 null，`votes` 为非负整数。无结果返回 `{ "total": 0, "candidates": [] }`。

特有错误：`503 BANGUMI_SEARCH_DISABLED`（未配置上游）、`503 BANGUMI_API_ERROR`。

### POST /api/v1/admin/subjects/{id}/sync

路径 `id` 必填，正安全整数。无正文。本地不存在该条目也可同步，但上游必须是动画。成功按版本导入元数据、别名和评分，保留手动别名：

```json
{ "imported": 100 }
```

`imported` 是条目 ID，不是数量。同步不计用户访问。特有错误：`400 INVALID_INPUT`、`ALIAS_LIMIT`、`ALIAS_TOO_LONG`；`503 BANGUMI_SYNC_DISABLED`、`BANGUMI_API_ERROR`。上游 404、非动画、鉴权失败、限流、网络或响应校验问题统一映射为后者，不透传上游 HTTP 状态。

### POST /api/v1/admin/calendar/sync

无参数、无正文。抓取全周日历、合并摘要，再为缺少作品形式的条目获取详情。手动调用不受定时开关 `CALENDAR_SYNC_ENABLED` 影响。

```json
{
  "imported": 2,
  "dataAsOf": "2026-01-01T00:00:00.000Z",
  "platformsUpdated": 1,
  "platformsRemaining": 1,
  "platformFailures": [101],
  "status": "partial"
}
```

| 字段                 | 含义                                                          |
| -------------------- | ------------------------------------------------------------- |
| `imported`           | 本次日历参与合并的条目数，不等于新增数                        |
| `dataAsOf`           | 日历抓取时间，ISO 8601                                        |
| `platformsUpdated`   | 本次实际回填形式的条目数                                      |
| `platformsRemaining` | 本次日历中仍为空的形式数量                                    |
| `platformFailures`   | 本次详情请求失败的 ID；没有失败时为空数组                     |
| `status`             | `complete`：形式均已补齐；`partial`：仍有缺失，**也返回 200** |

`CALENDAR_PLATFORM_BATCH_SIZE` 默认 10，允许任意正整数，无业务上限。剩余条目可能只是未轮到本次处理，所以 `partial` 不一定有失败 ID。再次调用会重新抓取日历并轮转补全；服务端将游标保存在 `calendar:platform_cursor`。

日历摘要保留已有完整详情、手动别名及排名；空 `platform` 只用真实详情回填。别名容量不足时跳过该条目的新增别名，继续合并其他数据。单条详情失败不撤销已导入数据，不要把整个日历同步当作一个可回滚事务。

特有错误：`503 BANGUMI_SYNC_DISABLED`、`BANGUMI_API_ERROR`（日历本身获取失败）；季数生成可能返回 `400 ALIAS_TOO_LONG`。定时部署和日志见 [README](../README.md)。

## 导入导出与恢复

### POST /api/v1/admin/import

接收一条**标准化数据**，不是 `subject.jsonlines` 原始行，也不是 Bangumi 原始 JSON。正文三个顶层字段均必填：

| 字段      | 类型           | 说明                                                     |
| --------- | -------------- | -------------------------------------------------------- |
| `subject` | Subject        | 字段及默认值见 [Subject](#subject)                       |
| `aliases` | string[]       | 0～200 个额外上游别名；原名和非空中文名会自动纳入        |
| `rating`  | Rating 或 null | 评分所属 ID 必须等于 subject.id；null 表示不更新已有评分 |

带评分的完整请求：

```json
{
  "subject": {
    "id": 100,
    "name": "示例动画",
    "nameCn": "示例动画中文名",
    "airDate": "2026-01-01",
    "platform": "TV",
    "metadataAt": 1767225600000,
    "cachedAt": 1767225600000,
    "pinned": false
  },
  "aliases": ["示例别称"],
  "rating": {
    "subjectId": 100,
    "score": 8.1,
    "votes": 120,
    "rank": 50,
    "source": "archive",
    "dataAsOf": 1767225600000,
    "fetchedAt": 1767225600000
  }
}
```

最小请求也合法：

```json
{
  "subject": {
    "id": 100,
    "name": "示例动画",
    "metadataAt": 1767225600000,
    "cachedAt": 1767225600000
  },
  "aliases": [],
  "rating": null
}
```

响应 `{ "imported": 100 }`。调用者应确保数据确属动画，此标准化格式没有 `type` 字段可供服务重新判定。

已有数据按版本处理：

- 仅较新的 `metadataAt` 更新原名、中文名、日期、形式和上游别名；保留手动别名、首次 `cachedAt`、原 `pinned`。
- 仅较新的评分 `dataAsOf` 更新评分；与元数据版本独立。`rating=null` 不删除原评分。
- 同版本重放不会回滚较新数据。200 代表处理成功，不代表一定新增或更新。
- 写入时应用季数规则并清理对应未命中统计；自动补全后每条目所有来源最多 250 个别名。

特有错误：`400 ALIAS_LIMIT`、`ALIAS_TOO_LONG`；ID 不一致为 `400 INVALID_INPUT`。传秒级数值可能通过非负校验但产生错误时间，调用方须保证单位正确。

### GET /api/v1/admin/export

| 查询参数 | 类型    | 必填 | 默认与范围           |
| -------- | ------- | ---- | -------------------- |
| `after`  | integer | 否   | 默认 0，非负安全整数 |

每次返回 `id > after` 的最多 **5 条**完整 `BackupRecord`，按 ID 升序。无法自定义页大小。

```json
{
  "records": [
    {
      "version": 1,
      "subject": {
        "id": 100,
        "name": "示例动画",
        "nameCn": "",
        "airDate": null,
        "platform": "",
        "metadataAt": 1767225600000,
        "cachedAt": 1767225600000,
        "pinned": false
      },
      "aliases": [],
      "rating": null,
      "usage": null,
      "daily": []
    }
  ],
  "nextCursor": null
}
```

只有 `nextCursor=null` 才停止。当前页恰好 5 条时始终返回最后一个 ID，因此可能需要额外请求一个空页。库中无数据时返回 `{ "records": [], "nextCursor": null }`。非法游标为 `400 INVALID_INPUT`。

备份包含条目、别名及来源/ID、评分、累计访问和每日访问统计；**不含未命中统计、同步检查点、环境配置或令牌**。分页读取不构成全库一致性快照；要求稳定迁移时，应在导出期间停止源端写入。CLI 可将每个 `records` 元素保存为独立 JSONL 行。

### POST /api/v1/admin/restore

请求为单个 [BackupRecord](#backuprecord)，即导出响应中的一个 `records` 元素，不能直接提交整个导出页。成功返回 `{ "restored": 100 }`。

所有顶层字段 `version`、`subject`、`aliases`、`rating`、`usage`、`daily` 均必填，`version` 固定为 1。恢复遵循：

- 当前条目 ID 必须不存在。HTTP 接口不要求整个数据库为空；CLI 还有额外的空库检查和续跑规则。
- 同条备份中别名 ID、`(name, source)` 组合、每日统计日期均不得重复。
- 所有 `subjectId` 必须与 `subject.id` 一致；每个 `normalizedName` 必须等于按本服务规则归一化的 `name`。
- 旧备份可包含不同来源的同名记录，恢复时合并并保留 manual 记录。除此之外不推断额外季数别名。
- 单条恢复使用事务；整个文件不是单个事务，先前恢复完成的记录会保留。

特有错误：`409 SUBJECT_EXISTS`、`400 BACKUP_TOO_LARGE`；结构、重复键和关联一致性错误为 `400 INVALID_INPUT`。成功响应丢失后再次恢复可能返回 409，应先核对条目和备份，不可把所有 409 无条件当作恢复成功。

## 统计与冷数据

### GET /api/v1/admin/stats

无参数、无正文，最多返回 100 个有访问统计的条目，按近 30 天次数降序、条目 ID 升序排列。

```json
{
  "enabled": true,
  "subjects": [
    {
      "subjectId": 100,
      "name": "示例动画",
      "totalHits": 3,
      "lastAccessedAt": 1767225600000,
      "hits7d": 3,
      "hits30d": 3
    }
  ]
}
```

`enabled` 对应 `STATS_ENABLED`，默认关闭；关闭后已有记录仍可读取。`totalHits` 为累计次数，`lastAccessedAt` 为 Unix 毫秒，`hits7d`/`hits30d` 为包含今天的最近 7/30 个 **UTC 日期**之和。所有次数为非负整数。查询不再为这些条目增加访问次数。

### GET /api/v1/admin/stats/alias-misses

| 查询参数  | 类型    | 必填 | 约束                                              |
| --------- | ------- | ---- | ------------------------------------------------- |
| `planned` | boolean | 否   | `true` 仅计划处理，`false` 仅无计划；省略返回全部 |
| `limit`   | integer | 否   | 正安全整数，默认 100，无额外业务上限，无分页游标  |

例如 `/api/v1/admin/stats/alias-misses?planned=true&limit=1000`。先筛选计划状态，再按 `missCount` 降序、`lastMissedAt` 降序、`normalizedName` 升序截取。

```json
{
  "enabled": true,
  "aliases": [
    {
      "name": "尚未收录的名称",
      "normalizedName": "尚未收录的名称",
      "missCount": 3,
      "firstMissedAt": 1767225600000,
      "lastMissedAt": 1767225660000,
      "planned": true
    }
  ]
}
```

`enabled` 对应 `ALIAS_MISS_STATS_ENABLED`，默认关闭，与访问统计开关独立。`missCount` 为正整数；两个时间为 Unix 毫秒；`planned` 新增时默认 true，后续未命中不重置人工计划状态。`name` 保存最近写入的原始名称，`normalizedName` 是聚合键。

没有结果返回 `aliases=[]`。关闭开关不删除历史记录，仍可读取、修改计划。新增对应别名会清理相同归一化键的未命中记录。非法参数返回 `400 INVALID_INPUT`。大 limit 虽无业务上限，仍受响应大小、内存和平台执行时间约束。

### PATCH /api/v1/admin/stats/alias-misses

| 正文字段  | 类型    | 必填 | 说明                                     |
| --------- | ------- | ---- | ---------------------------------------- |
| `name`    | string  | 是   | 去首尾空白后 1～300 字符，按归一化键定位 |
| `planned` | boolean | 是   | 是否计划继续处理                         |

```json
{ "name": "尚未收录的名称", "planned": false }
```

响应 `{ "alias": { ... } }`，`alias` 是上一个接口中的完整单条统计结构，`planned` 为新值。只更新计划，不重置次数和时间。不存在或已因别名补充而清理时返回 `404 ALIAS_MISS_NOT_FOUND`。

### POST /api/v1/admin/stats/prune

正文 `days` 为可选整数，范围 **30～3650**，默认 90；使用默认值也须发送 `{}`：

```json
{ "days": 90 }
```

保留含今天的最近 `days` 个 UTC 日期，每次最多删除 1000 行旧每日统计。

```json
{ "deleted": 1000, "hasMore": true }
```

`deleted` 为本次删除行数，范围 0～1000；删除满 1000 行即 `hasMore=true`，继续调用直到 false，最后一次可能删 0 行。不修改累计访问、最近访问、未命中统计或条目本身。非法 days 为 `400 INVALID_INPUT`。

### GET /api/v1/admin/retention

查询 `days` 为可选整数，范围 **1～3650**，默认 90，无正文。入库和最近访问均早于 `now - days × 24h`、`pinned=false` 的条目列为候选。没有访问记录时按入库时间判断。

```json
{
  "actionable": false,
  "reason": "仅预览；统计可能不完整，首版不自动删除",
  "candidates": [
    { "id": 100, "name": "示例动画", "cachedAt": 1767225600000, "lastAccessedAt": null }
  ]
}
```

候选最多 100 条，按 ID 升序；时间为 Unix 毫秒，未记录过访问为 null。统计关闭时返回空候选和说明。`actionable` 始终 false，当前没有删除条目接口。统计开关和失败都可能产生观察空窗，候选不是可直接删除的保证。非法 days 为 `400 INVALID_INPUT`。

## 同步检查点

两个接口的 `{key}` 均必填，作为单个 URL 路径段编码。服务不定义其业务格式；调用者应使用自己的键，避免与 CLI 或 `calendar:platform_cursor` 冲突。

### GET /api/v1/admin/sync-state/{key}

无正文。存在时：

```json
{ "value": "{\"line\":20}" }
```

不存在时返回 **200** 和 `{ "value": null }`。值是字符串，不自动解析 JSON。

### PUT /api/v1/admin/sync-state/{key}

正文 `value` 必填，为不超过 10000 字符的字符串，可为空。JSON 检查点需先序列化：

```json
{ "value": "{\"line\":20}" }
```

成功返回 `{ "saved": true }`。覆盖同名键，无版本比较或并发合并。此接口不与其他导入请求组成跨请求事务，调用方须在数据确认写入后推进检查点；相同键的多个写入者可能互相覆盖。CLI 的检查点时机、`--checkpoint-interval` 和续跑行为见 [README](../README.md)。非法正文为 `400 INVALID_INPUT`。

## 数据模型

OpenAPI 将输入与输出分开：例如 `ImportRequest` 中可省略有默认值的字段，而导出的 `Subject` 和 `BackupRecord` 返回完整字段。JSON Schema 无法完整表达批内 inputId 唯一、关联 ID 一致、归一化算法等语义，服务端还会进行这些校验。

### Subject

用于标准化导入和备份；公开查询仅返回其中的展示字段及 `url`。

| 字段         | 类型           | 输入必填 | 约束 / 默认                                          |
| ------------ | -------------- | -------- | ---------------------------------------------------- |
| `id`         | integer        | 是       | 正安全整数                                           |
| `name`       | string         | 是       | 原名，去首尾空白后 1～300 字符                       |
| `nameCn`     | string         | 否       | 最多 300 字符，默认空字符串                          |
| `airDate`    | string 或 null | 否       | YYYY-MM-DD，默认 null                                |
| `platform`   | string         | 否       | 最多 100 字符，默认空字符串；如 TV、OVA、WEB、剧场版 |
| `metadataAt` | integer        | 是       | 元数据版本，Unix 毫秒                                |
| `cachedAt`   | integer        | 是       | 首次入库时间，Unix 毫秒；普通重导入不覆盖            |
| `pinned`     | boolean        | 否       | 默认 false；true 排除冷数据候选，普通重导入不覆盖    |

当前无独立 pinned 修改接口。响应中的上述字段全部存在，含默认值。

### Rating

下面所有字段均必填；评分整体在导入和备份中允许为 null。

| 字段        | 类型            | 约束 / 含义                                     |
| ----------- | --------------- | ----------------------------------------------- |
| `subjectId` | integer         | 必须与 subject.id 相同                          |
| `score`     | number 或 null  | 0～10；null 表示没有有效评分                    |
| `votes`     | integer         | 非负评分人数，不是收藏人数                      |
| `rank`      | integer 或 null | 正整数排名；未知为 null                         |
| `source`    | string          | `archive` 或 `api`                              |
| `dataAsOf`  | integer         | 评分版本时间，Unix 毫秒，用于版本比较和过期判断 |
| `fetchedAt` | integer         | 获取时间，Unix 毫秒                             |

查询响应的 `rating` 仅包含 score、votes、rank、source；其版本时间位于外层 `dataAsOf`，并转换为 ISO 字符串。

### Alias

所有字段均必填。手动添加接口只接受 `name`，其余由服务端生成；备份恢复接受完整结构。

| 字段             | 类型    | 约束 / 含义                                       |
| ---------------- | ------- | ------------------------------------------------- |
| `id`             | string  | 1～100 字符；新建为 UUID，恢复的历史值不强制 UUID |
| `subjectId`      | integer | 所属条目正安全整数 ID                             |
| `name`           | string  | 去首尾空白后 1～300 字符                          |
| `normalizedName` | string  | 1～600 字符，必须与归一化 name 一致               |
| `source`         | string  | `bangumi` 或 `manual`；衍生名称也继承来源         |
| `createdAt`      | integer | 创建时间，Unix 毫秒                               |
| `updatedAt`      | integer | 最后更新时间，Unix 毫秒                           |

### BackupRecord

全部顶层字段必填，完整示例见导出接口。建议保留服务导出的字段，不手工重建。

| 字段      | 类型           | 约束 / 含义                                                                    |
| --------- | -------------- | ------------------------------------------------------------------------------ |
| `version` | integer        | 固定 1，独立于数据库结构版本                                                   |
| `subject` | Subject        | 完整条目，输出包含所有默认字段                                                 |
| `aliases` | Alias[]        | 最多 250 条；可空，保留 ID、来源和时间                                         |
| `rating`  | Rating 或 null | 完整评分，无记录为 null                                                        |
| `usage`   | object 或 null | 有记录时包含必填 `lastAccessedAt`（毫秒）、`totalHits`（非负整数）             |
| `daily`   | object[]       | 最多 3660 项；每项必填 `day`（YYYY-MM-DD）、`hits`（非负整数）；无统计为空数组 |

## 错误与重试

错误响应示例：

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "参数无效",
    "issues": [{ "path": ["items", 0, "inputId"], "message": "字段不满足校验约束" }]
  }
}
```

`code` 用于机器判断；`message` 供阅读，具体措辞可能变化。只有字段/跨字段校验的 `INVALID_INPUT` 携带 `issues`；数组下标用数字，根级错误路径为 `[]`。本服务不在错误响应里暴露 SQL、数据库地址或凭证。排查时记录 HTTP 状态、code、时间、`X-Request-ID`。

### 通用错误范围

- 全部路由受 256 KiB 限制，可返回 `413 BODY_TOO_LARGE`；未预期故障为 `503 SERVICE_UNAVAILABLE`。Worker 初始化还可能返回 `503 CONFIGURATION_ERROR`。
- 所有管理操作额外可能返回 `401 UNAUTHORIZED`、`503 ADMIN_DISABLED`。
- 要求 JSON 正文的操作额外可能返回 `400 INVALID_JSON`、`400 INVALID_INPUT`。即使所有字段都有默认值，也须发送 `{}`，不要留空正文。
- 数值路径或查询参数无效返回 `400 INVALID_INPUT`。各接口的其余业务错误已在对应章节列出。
- 未知路径或不匹配的方法返回 `404 NOT_FOUND`，当前没有单独的 405；管理路径会先执行鉴权，未通过时优先返回鉴权错误。

### 错误码目录

| HTTP | code                      | 原因与处理                                                         |
| ---- | ------------------------- | ------------------------------------------------------------------ |
| 400  | `INVALID_INPUT`           | 必填、类型、范围、重复 inputId、备份关联等校验失败；按 issues 修正 |
| 400  | `INVALID_JSON`            | 请求体缺失或 JSON 语法错误；发送正确 JSON                          |
| 400  | `BATCH_TOO_LARGE`         | 超过当前 MAX_BATCH_SIZE；拆分批次                                  |
| 400  | `TOO_MANY_CANDIDATES`     | 名称检索涉及超过 1000 条别名记录；减少名称/批次或改用 ID           |
| 400  | `ALIAS_LIMIT`             | 自动补充后超过单条目 250 个别名；先整理别名                        |
| 400  | `ALIAS_TOO_LONG`          | 季数转换后超过 300 字符；缩短名称                                  |
| 400  | `BACKUP_TOO_LARGE`        | 单条备份超出事务预算；先整理历史统计                               |
| 401  | `UNAUTHORIZED`            | 管理令牌缺失或不正确；核对 ADMIN_TOKEN                             |
| 404  | `NOT_FOUND`               | 路径或方法不存在；核对 URL 和 HTTP 方法                            |
| 404  | `SUBJECT_NOT_FOUND`       | 条目未收录；先导入或同步                                           |
| 404  | `ALIAS_NOT_FOUND`         | 别名不存在或不是 manual 来源；重新列出别名                         |
| 404  | `ALIAS_MISS_NOT_FOUND`    | 未命中记录不存在或已自动清理；刷新列表                             |
| 409  | `ALIAS_EXISTS`            | 修改后与同条目另一名称重复；保留已有名称或选择其他名称             |
| 409  | `SUBJECT_EXISTS`          | 恢复目标已有条目；核对是否已恢复，更新使用 import/sync             |
| 413  | `BODY_TOO_LARGE`          | 请求超过 256 KiB；减少正文大小                                     |
| 503  | `ADMIN_DISABLED`          | 服务端未配置管理令牌；需管理员启用                                 |
| 503  | `NOT_READY`               | 数据库结构版本不匹配；完成迁移并核对部署版本                       |
| 503  | `BANGUMI_SEARCH_DISABLED` | 上游搜索未配置；设置 BANGUMI_USER_AGENT                            |
| 503  | `BANGUMI_SYNC_DISABLED`   | 上游同步未配置；设置 BANGUMI_USER_AGENT                            |
| 503  | `BANGUMI_API_ERROR`       | 上游网络、认证、限流、404、非动画或响应格式问题；查服务端日志      |
| 503  | `SERVICE_UNAVAILABLE`     | 存储或其他内部故障；凭 X-Request-ID 查日志                         |
| 503  | `CONFIGURATION_ERROR`     | Worker 配置/初始化失败；核对环境配置和绑定                         |

### 如何重试

当前服务没有通用幂等键或事务查询接口。不要对全部失败无限重试；配置、鉴权、校验错误应先修正。临时网络故障或 503 可采用有限次数的退避延迟；503 也可能是永久配置或上游数据问题。

| 操作                 | 响应丢失或重试的影响                                       |
| -------------------- | ---------------------------------------------------------- |
| 评分查询             | 数据结果不被修改，但启用统计时重试会再次计数               |
| 同版本 import        | 版本保护允许安全重放；成功不等于此次实际更新               |
| 添加同名别名         | 复用已有记录；先核对来源与冲突结果                         |
| 修改别名             | 可能已写入但后续冲突读取失败，先查询当前别名               |
| 删除别名             | 已删除后重复调用返回 404；先核对目标 ID                    |
| 单条 sync / calendar | 会重新请求上游；日历已完成部分不会回滚，partial 可继续调用 |
| restore              | 已恢复后重复请求返回 409；必须核对备份内容再继续           |
| prune                | 可重复调用，持续删除满足条件的旧每日行                     |
| 检查点 PUT           | 覆盖同名值；不要因延迟重试把更新的检查点倒退               |

## 常见工作流

### 处理未命中别名

1. 启用 `ALIAS_MISS_STATS_ENABLED` 收集未知名称。调用 `GET /api/v1/admin/stats/alias-misses?planned=true&limit=100` 取得待处理列表。
2. 使用每条 `name` 调用 `POST /api/v1/admin/subjects/search`。搜索仅返回候选，不绑定或导入。
3. 无合适候选可更换 keyword 搜索，或 PATCH 未命中记录为 `planned=false`；跳过则不修改记录。
4. 选定条目 ID 后调用 `POST /api/v1/admin/subjects/{id}/sync`，导入详情。
5. 调用 `POST /api/v1/admin/subjects/{id}/aliases`，以原未命中名称绑定。若已经是上游同名别名则复用，不产生重复手动记录。
6. 对应未命中记录会自动清理，再次评分查询验证即可。步骤间没有跨请求事务，失败时可依据已完成操作继续。

CLI 的 `resolve-alias-misses` 已封装上述交互和自动精确名称选择，处理数量由调用者决定；具体参数见 [README](../README.md)。

### 备份与跨存储迁移

1. 从 `after=0` 开始调用 export，将 records 逐条写入 JSONL；使用返回的 nextCursor 翻页，直到 null。
2. 目标服务完成迁移，优先选择空库。逐行将 BackupRecord 发往 restore。
3. 每条成功后才记录恢复进度；中断保留既有恢复数据。遇到 409 先核对目标数据，避免误把冲突当作成功。
4. 核对条目、别名和评分；重新配置目标服务的 Token、统计开关、定时任务。未命中统计和同步检查点不在备份内。

这套业务备份格式可跨 D1、SQLite、PostgreSQL 使用，不依赖底层 SQL 方言。已有 CLI 的备份和恢复命令还提供文件校验、断点等支持，见 README。

### 对接与维护

调用方应按 `status` 解析批量结果，并按 `ratingStatus` 判断评分可用性；请求失败按 HTTP 状态与 `error.code` 分支。不要把空数组、null、未命中和异常合并成一个状态。

修改接口时同步维护共享请求模型、响应模型、OpenAPI 和本文。仓库的契约测试覆盖路由清单、鉴权、模型引用、请求默认值、示例，以及真实 HTTP 处理与临时存储返回值；运行方式见 [CONTRIBUTING](../CONTRIBUTING.md)。
