# Bangumi 动画评分查询服务

使用 **Bun + TypeScript** 开发的纯 JSON 后端。提供两种部署方式：

| 部署方式   | HTTP 入口                     | 存储   |
| ---------- | ----------------------------- | ------ |
| Cloudflare | Worker                        | D1     |
| 自部署     | Node.js + Hono，可使用 Docker | SQLite |

两种入口共享查询业务、参数校验和 JSON 契约。业务层不依赖 Cloudflare 或 Node.js；数据库差异集中在适配器中。Drizzle 用于构造参数化 SQL，D1 与 SQLite 共用迁移 SQL。Node 使用内置 `node:sqlite`，不需要额外编译原生数据库插件。

## 首版功能

- 按多个名称或 Bangumi ID 批量查询，保留输入顺序，默认每批最多 20 条。
- 原名、中文名、Bangumi 别名、手动别名统一检索；支持 NFKC、大小写和空白归一化。
- 同名作品返回候选，可通过年份和作品形式筛选；多个已知名称可以交叉匹配。
- 返回评分、评分人数、排名、数据时间及过期标记；查询期间不向上游批量回源。
- 手动别名增删改、幂等添加、同名冲突提示；上游同步不覆盖手动别名。
- 写入时互补 `第2季` / `第二季` 等季数别名，并为唯一匹配的第一季条目补全季数名称。
- **访问统计默认关闭**，开启后统计条目最近访问、累计命中、每日命中和近 7/30 天热度。
- Archive 下载、SHA-256 校验、流式解压、分批断点导入，以及单条目 API 更新。
- Bangumi calendar 全周日历批量导入，支持管理接口、CLI、Worker Cron 和 Node 每日调度。
- 版本化 JSONL 备份恢复，支持 D1 与 SQLite 之间迁移，保留手动别名与统计。
- 冷数据预览、每日统计清理；首版不自动淘汰条目。
- `/openapi.json` 提供 OpenAPI 3.1 文档，无前端页面。

目前只支持动画（Bangumi `type=2`）。首版不包含模糊文本搜索、繁简转换、PostgreSQL 适配器和后台队列。未收录的名称返回 `not_found`，不会自行选取最热门的相似作品。

## 环境与安装

- Bun 1.4.3 或更高版本。
- Node.js 24.12 或更高版本，用于自部署、同步 CLI 和集成测试。

```sh
bun install --frozen-lockfile
bun run check
```

Bun 负责安装、脚本、测试和构建；自部署产物运行在 Node.js，Worker 产物不引入 Node 文件系统和 SQLite 模块。`node:sqlite` 在部分 Node 24 版本会输出实验性提示。

依赖按 2026-10-20 查询的最新发布版本安装，具体解析结果由 `bun.lock` 固定。Miniflare 使用与 Wrangler 4.151.2 自带运行时一致的 `5.20261019.0-beta`；其 npm `latest` 标签仍指向较老的 4.x。它仅用于开发与测试，不进入服务产物。

## Node.js 快速启动

将 `.env.example` 复制为 `.env`，按需填写 `ADMIN_TOKEN` 和 `BANGUMI_USER_AGENT`。不配置管理令牌时，公开查询仍可用，管理接口返回 `ADMIN_DISABLED`。

```sh
bun run build
bun run db:migrate
bun start
```

默认监听 `0.0.0.0:3000`，SQLite 位于 `data/bangumi.sqlite`。Node 启动会检查并初始化空数据库；CLI 也会自动初始化本地数据库。

可先导入仓库中的**虚构测试数据**验证调用流程：

```sh
bun run cli sync-archive --file tests/fixtures/subject.jsonl --as-of 2026-01-01T00:00:00Z
```

健康检查：`GET /health/live`、`GET /health/ready`。

## Cloudflare Worker 部署

```sh
bunx wrangler login
bunx wrangler d1 create bangumi-rating-query
```

将创建得到的 `database_id` 填入 `wrangler.jsonc`，并按自己的部署环境修改 Worker 名称和 `BANGUMI_USER_AGENT`。然后执行：

```sh
bunx wrangler d1 migrations apply DB --remote
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put BANGUMI_ACCESS_TOKEN
bun run deploy:worker
```

管理令牌建议用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成，长度至少 32 字符。不要把实际令牌写进仓库。

`ADMIN_TOKEN` 和 `BANGUMI_ACCESS_TOKEN` 均通过 Cloudflare **Secret（加密变量）** 配置，不放入 `vars`。命令会提示输入值，Bangumi Token 填原始值，不加 `Bearer `。控制台也可在 Worker 的 **Settings → Variables and Secrets → Add → Secret** 中添加同名变量。需要单条目在线更新时，将 `vars.BANGUMI_USER_AGENT` 填成自己的开发者/应用标识，然后部署。Bangumi Token 可选，不配置时使用匿名请求。

`wrangler.jsonc` 已配置 `triggers.crons = ["0 20 * * *"]`，部署后每天 **20:00 UTC（北京时间次日凌晨 04:00）** 导入全周 calendar。`CALENDAR_SYNC_ENABLED="false"` 可停用定时执行，手动接口仍可用。Worker 的实际执行时间由 `triggers.crons` 决定，修改配置后重新部署；它不使用 Node 的 `CALENDAR_SYNC_HOUR_UTC`。

本地 Worker 开发：

```sh
bun run db:migrate:worker
bun run dev:worker
```

如需本地管理接口，在未提交的 `.dev.vars` 中配置 `ADMIN_TOKEN=...`；本地 Worker 单条目同步可同时配置 `BANGUMI_USER_AGENT` 和 `BANGUMI_ACCESS_TOKEN`。Worker 的统计开关在 `wrangler.jsonc` 的 `vars.STATS_ENABLED` 中设置，修改后重新部署；`.env` 主要用于 Node 和 CLI，不是线上 Worker 配置。

Worker 使用 D1 原子批次完成单条目导入。默认控制批次、候选数、SQL 参数数和请求体大小，但免费额度是否够用仍取决于实际数据和流量。初次导入、别名索引维护和开启统计都会消耗 D1 写入额度。外部 CLI 不会绕过这些额度。

## Docker 自部署

```sh
docker compose up --build -d
```

Compose 从本地 `.env` 读取管理令牌等配置，使用持久化命名卷保存数据库。默认只将端口发布到宿主机 `127.0.0.1:3000`，可由反向代理提供 HTTPS。

镜像中同时包含同步 CLI，例如：

```sh
docker compose exec api node dist/node/cli.js sync-subject --id 123
```

使用内置 SQLite 时按单实例部署，数据库目录需要可写。不要把 SQLite 文件放到多个容器共享的网络文件系统上。

## 批量查询

`POST /api/v1/ratings/batch`：

```json
{
  "items": [
    {
      "inputId": "row-1",
      "names": ["示例动画", "Example Anime"],
      "year": 2023,
      "platform": "TV"
    },
    {
      "inputId": "row-2",
      "subjectId": 101
    }
  ]
}
```

- `inputId` 必填且批次内唯一。重复动画可以使用不同 `inputId`，响应不会丢失行。
- `names` 表示同一动画的多个已知名称，每项最多 5 个，每个名称最多 300 字符。
- `subjectId` 存在时优先作为身份，`year`、`platform` 仍参与筛选。
- 支持 `https://bgm.tv/subject/123` 等官方条目链接；纯数字名称（如 `86`）仍按名称匹配。按 ID 查询请显式使用 `subjectId`。
- 多个命中名称的候选有交集时取交集；互相冲突时返回 `ambiguous`，不会静默选第一项。未收录的辅助名称不阻止其他名称匹配。
- 同名候选最多返回 20 个，超出时 `candidatesTruncated=true`。检索候选规模过大则拒绝请求，建议使用 ID。
- 名称归一化不删除季数、标点或“剧场版”等信息。

结果示例：

```json
{
  "results": [
    {
      "inputId": "row-1",
      "status": "matched",
      "subject": {
        "id": 100,
        "name": "Example Anime",
        "nameCn": "示例动画",
        "airDate": "2023-01-01",
        "platform": "TV",
        "url": "https://bgm.tv/subject/100"
      },
      "matchReason": "exact_alias",
      "matchedAliases": [{ "name": "示例动画", "source": "bangumi" }],
      "rating": { "score": 8.1, "votes": 15, "rank": 123, "source": "archive" },
      "ratingStatus": "available",
      "dataAsOf": "2026-01-01T00:00:00.000Z",
      "stale": true
    }
  ]
}
```

逐项匹配状态为 `matched`、`ambiguous`、`not_found`。评分状态独立为 `available`、`unrated`、`unavailable`。无人评分时 `score=null`，不能当作零分。数据库整体故障返回 HTTP 503，不伪装成未收录。

所有接口返回 JSON；错误格式为 `{ "error": { "code": "...", "message": "..." } }`。请求体最多 256 KiB。服务不启用响应缓存，避免缓存绕过访问统计。

## 手动别名

管理请求携带 `Authorization: Bearer <ADMIN_TOKEN>`。

| 方法   | 路径                                 | 说明                                     |
| ------ | ------------------------------------ | ---------------------------------------- |
| GET    | `/api/v1/subjects/:id/aliases`       | 列出所有来源的别名                       |
| POST   | `/api/v1/admin/subjects/:id/aliases` | 添加手动别名，正文 `{"name":"我的别名"}` |
| PATCH  | `/api/v1/admin/aliases/:aliasId`     | 修改手动别名，正文同上                   |
| DELETE | `/api/v1/admin/aliases/:aliasId`     | 删除手动别名                             |

相同条目的同名手动别名重复添加是幂等操作。名称与其他条目冲突时仍允许添加，并返回 `conflictingSubjectIds`。手动别名不会自动压过其他条目的官方名称。同一条目所有来源别名合计上限为 250 条。

Archive/API 导入、calendar 同步、手动添加及修改别名时，会自动补充名称末尾的季数写法。原名、中文名也作为别名参与此规则：

| 写入名称       | 自动补充                                |
| -------------- | --------------------------------------- |
| `作品第2季`    | 同条目的 `作品第二季`                   |
| `作品第十二季` | 同条目的 `作品第12季`                   |
| `作品 第二季`  | 同条目的 `作品 第2季`，保留标题后的空格 |

只转换末尾明确的正整数 `第N季`，支持常用中文位值数字（十、百、千、万、亿、兆）及全角阿拉伯数字；不处理 `Season 2`、罗马数字或 `第二季 特别篇` 等不同后缀。已存在于同一条目的对应名称按现有 NFKC、大小写及空白归一化规则去重，不重复插入。

写入第二季别名时，先查询本库对应的 `第一季` / `第1季` 名称；没有匹配时，再用去掉季数后缀的名称查询。只有唯一匹配到其他条目时，才为该条目补齐两种第一季别名。已有第一季名称存在歧义时，不再回退到无后缀名称；无匹配、多个同名条目或仅匹配第二季自身时都不自动归属。此过程不请求 Bangumi API。

例如库中已有条目 A 的名称 `作品`，为条目 B 添加 `作品第二季` 后，B 会增加 `作品第2季`，A 会增加 `作品第一季` 和 `作品第1季`。第一季晚于第二季导入、第一季刷新上游名称，以及同一批 calendar 中包含两季时也会尝试补全。

同条目互补别名继承写入来源；推断的第一季别名继承被匹配名称的来源。手动来源继续受上游同步保护，`conflictingSubjectIds` 同时检查原名称和转换后的名称。补充别名是独立记录：修改或删除某条手动别名不会联动删除其他已生成的别名。

原名称及自动补充在同一事务中写入；单条导入或手动操作补充后超过 250 条，返回 `400 ALIAS_LIMIT`，全部改动不提交。转换后的名称超过 300 字符返回 `400 ALIAS_TOO_LONG`。calendar 对容量不足的条目跳过本轮新增别名，继续同步其他数据。规则在后续写入时生效，不会部署后全库回填；同时间戳的 Archive 重放仍遵循原有版本保护。备份恢复保持备份原样，不额外推断别名。

上游别名只能通过同步更新，不能通过手动别名接口删除。修改手动别名为该条目已存在的另一个手动别名时返回 409。

CLI 同样可添加：

```sh
bun run cli alias-add --id 100 --name 我的别名
```

## 数据同步

### 单条目更新

配置可识别开发者和应用的 `BANGUMI_USER_AGENT`，例如 `your-id/bangumi-rating-query/0.1.0 (your-project-url)`。

可选配置 `BANGUMI_ACCESS_TOKEN`，填写原始 Token，不含 `Bearer ` 前缀。配置后，Bangumi API 请求及其重试均附带 `Authorization: Bearer <Token>`；未配置或留空时不发送该请求头，`User-Agent` 仍然必填。

该配置与本服务管理接口的 `ADMIN_TOKEN` 独立。**远程单条目同步由目标服务执行**：Worker 读取同名 Secret，Node 服务读取服务端环境变量；本地 CLI 仅需目标服务的 `ADMIN_TOKEN`，不用配置或传递 Bangumi Token。不带 `--api-url` 时由本地 CLI 访问 Bangumi，使用本机 `.env` 或环境变量中的凭证。Docker Compose 已透传此变量。Bangumi Token 只发送给 Bangumi API，不进入备份、查询响应或 GitHub Archive 下载请求。

```sh
bun run cli sync-subject --id 123
```

也可直接调用管理接口 `POST /api/v1/admin/subjects/:id/sync`，携带本服务的管理令牌。该接口使用服务端 Bangumi 配置获取并保存条目，返回 `{"imported":123}`；未配置服务端 `BANGUMI_USER_AGENT` 时返回 `BANGUMI_SYNC_DISABLED`。更新操作不计为用户访问。

Bangumi 返回 429 或临时服务端错误时执行有限重试，遵循 `Retry-After`。要求等待超过一分钟时退出，由后续定时任务重试。公开查询本身不触发上游请求。

如果环境通过 `HTTP_PROXY` / `HTTPS_PROXY` 访问外网，可为 Node CLI 设置 `NODE_USE_ENV_PROXY=1`，让 Node 使用已配置的代理。网络连接失败会使本次同步退出，保留已有数据。

### Archive 初始化与更新

```sh
bun run cli download-archive --out data/subject.jsonlines
bun run cli sync-archive --file data/subject.jsonlines --limit 1000
```

下载命令读取官方 `aux/latest.json`，下载 ZIP 并校验官方 SHA-256，只解压 `subject.jsonlines`，同时写入 `.meta.json` 保存数据时间。完整压缩包可能较大；可自行取得解压后的文件，再显式传入快照时间：

```sh
bun run cli sync-archive --file data/subject.jsonlines --as-of 2026-10-13T21:03:54Z --limit 1000
```

`--as-of` 必须代表快照时间，不能用每次运行的当前时间，否则会把旧数据误当新数据。解析器使用 `@bgm38/wiki` 提取 infobox 别名；上游语法或字段异常会终止并报告行号，不会用空别名覆盖旧数据。

需要跳过损坏的 JSON、字段校验失败或 infobox 解析失败的条目时，添加 `--skip-invalid`：

```sh
bun run build:node
bun run cli sync-archive --file data/subject.jsonlines --skip-invalid --limit 1000
```

若文件没有 `.meta.json`，仍需带上原先使用的 `--as-of`。跳过的是整个条目，其已入库的旧数据保持不变。错误信息追加到输入文件旁的 `subject.jsonlines.errors.jsonl`，包含文件版本标识、原始行号、可识别的条目 ID 和原因，也会输出到标准错误。数据库、文件读取或错误日志写入失败仍会终止；远程 API 不可重试的错误或重试耗尽也会终止，不会被当作无效数据跳过。

结果中 `skipped` 是本次跳过数量，`skippedTotal` 是该检查点累计跳过数量。`complete=true` 仅表示已遍历文件；有跳过记录时 `status=partial`，触及批次上限时为 `in_progress`，全部遍历且无跳过时才为 `complete`。允许跳过的运行正常退出，自动化应检查 `status`，不能只凭退出码认定全部数据已入库。

每次默认最多处理 1000 个有效动画条目，跳过的无效条目不占此额度。再次执行相同命令会从检查点继续，追加 `--skip-invalid` 也会复用已有检查点。检查点以文件 SHA-256 和快照时间标识，默认每 20 行以及正常结束时保存；可通过 `--checkpoint-interval` 设置保存间隔，必须为正整数，本地 SQLite 和远程 API 均支持：

```sh
bun run cli sync-archive --file data/subject.jsonlines --limit 1000 --checkpoint-interval 50
```

间隔按原始文件行号计算：默认在第 20、40、60……行处理完成后保存，非动画及主动跳过的坏项也计入行号；空行直接略过，不触发该行的周期保存。达到 `--limit` 时保存一次并标记 `complete=false`，正常扫描到文件末尾时保存并标记 `complete=true`。启动和进度日志包含实际使用的 `checkpointInterval`。修改间隔不会改变检查点标识，续跑时仍按文件绝对行号触发保存；`--dry-run` 始终不写检查点。

失败时保留上次成功保存的检查点，续跑可能重放之后已导入的条目，导入按来源时间保持幂等；错误日志也可能出现重复记录，可按 `archiveKey` 和 `line` 去重。已完成的文件再次执行不会重新导入。新快照会得到新的检查点。

已越过的错误项不会在续跑时自动重试。可按错误日志中的 ID 使用 `sync-subject --id ...` 单独补导，或修正源文件后重新导入（文件 SHA-256 改变会使用新的检查点）。补导不会自动清零旧检查点中的历史跳过计数。

条目元数据和评分分别比较时间；旧 Archive 不覆盖更新的 API 评分。相同时间视为同一版本，不重复写入。同步只替换 `bangumi` 来源的别名，手动别名、首次入库时间和保留标记不被覆盖。

### 仅解析和统计 Archive

使用 `--dry-run` 可以先检查数据，不进行实际导入：

```sh
bun run cli sync-archive --file data/subject.jsonlines --dry-run --skip-invalid
# 只解析前 1000 个有效动画条目，并显示逐条解析日志
bun run cli sync-archive --file data/subject.jsonlines --dry-run --skip-invalid --limit 1000 --log-level debug
```

该模式从文件首行开始，默认扫描整个文件；显式指定 `--limit` 时，以成功解析的动画条数为上限，无效项和非动画不占额度。无需管理 Token，也可省略 `--as-of`；如果传入快照时间或文件旁存在 `.meta.json`，仍会校验其中的时间格式。

`--dry-run` 不连接本地数据库或远程 API，不读取或更新同步检查点，也不创建或追加 `.errors.jsonl`；即使带有 `--api-url`、`--request-delay-ms` 和 `--request-retries`，也不会发送请求或等待。因此不会推进下一批实际导入的位置。无效项默认终止解析，添加 `--skip-invalid` 后跳过并记录到 stderr 日志。

stdout 输出 JSON 汇总：`dryRun=true`、`parsed`（成功解析的动画条数）、`ignored`（非动画）、`skipped`（无效项）、`emptyLines`（空行）、`line`（当前文件行号）、`complete` 和 `status`。`imported` 始终为 `0`，`errorLog` 为 `null`。统计按行计数，相同条目 ID 的重复行会分别计数；只有完整扫描且没有跳过项时，`status` 才为 `complete`。

### 同步到远程 Worker 或 Node 服务

在运行 CLI 的机器配置与目标服务一致的 `ADMIN_TOKEN`，为命令追加：

```sh
bun run cli sync-archive --file data/subject.jsonlines --limit 100 --api-url https://your-api.example.com
bun run cli sync-subject --id 123 --api-url https://your-api.example.com
```

远程同步通过受保护的管理 JSON API 调用存储适配器，客户端不需要 Cloudflare 数据库令牌。`sync-subject --api-url` 由目标服务使用自己的 Bangumi 凭证获取数据；Archive 仍在 CLI 中解析并上传标准化条目。除本机回环地址外要求 HTTPS。管理令牌从环境读取，不放入命令参数；管理客户端拒绝 HTTP 重定向。

远程请求可通过 `--request-delay-ms` 设置间隔，单位为毫秒，默认 `0`（不进行延迟）。例如每次请求完成后等待 500 毫秒再发送下一次：

```sh
bun run cli sync-archive --file data/subject.jsonlines --api-url https://your-api.example.com --as-of 2026-10-20T08:18:54Z --limit 1000 --request-delay-ms 500
```

首次请求立即发送，之后从上一次响应体处理完毕开始等待；导入、读取和保存检查点等所有远程管理请求都使用相同间隔。其他使用 `--api-url` 的 CLI 命令也支持此选项。本地 SQLite 操作以及服务端访问 Bangumi 的请求不受该选项影响。

`sync-archive` 的远程请求默认失败后最多**额外重试 3 次**，即每个请求最多发送 4 次。使用 `--request-retries` 指定非负整数，设为 `0` 可关闭重试：

```sh
bun run build:node
bun run cli sync-archive --file data/subject.jsonlines --api-url https://your-api.example.com --as-of 2026-10-20T08:18:54Z --limit 1000 --request-delay-ms 200 --request-retries 3 --skip-invalid
```

网络连接异常、超时、响应体读取中断及 HTTP `408`、`429`、`5xx` 可重试；其他 HTTP 错误（如 `400`、`401`、`403`）及响应 JSON 解析错误立即停止。每个导入请求及检查点读写请求独立计算重试次数；重试始终发送相同的请求正文，成功后才继续处理下一条。

重试使用指数退避，依次等待 1、2、4、8 秒，退避上限为 30 秒；实际等待取退避时间、`--request-delay-ms` 和服务端 `Retry-After` 的最大值。`Retry-After` 支持秒数和 HTTP 日期；若服务端要求等待超过一分钟，命令停止并提示稍后续跑，不会提前重试。

默认日志会以 `warn` 输出 `api_request_retry`，包含 `attempt`（当前失败的是第几次请求）、`retry`（即将执行第几次重试）、`requestRetries`（重试上限）、`waitMs`、HTTP 状态及请求关联信息。重试耗尽后以 `error` 输出 `api_request_failed`，命令非零退出；`--skip-invalid` 不会跳过这些请求失败，也不会推进失败条目的检查点。稍后执行相同文件和 `--as-of` 的命令即可续跑。

`--request-retries` 仅支持 `sync-archive` 的远程管理请求，不影响本地 SQLite、`--dry-run` 或服务端访问 Bangumi 的重试策略。其他 CLI 命令保持不自动重试。

Archive 和单条目更新可用系统定时任务、CI 等周期执行以上 CLI；Archive 分批初始化尤其需要按 D1 当日写入余量决定批次，不建议一次无预算地导入全库。calendar 日历更新另有内置定时任务，见下文。

### CLI 运行日志

默认以 `info` 级别向 **stderr** 输出 JSON Lines 日志，包含时间、命令、事件、中文说明和累计耗时。**stdout 保持原有命令结果**，可继续供脚本解析或重定向保存。

- 启动、存储目标就绪、完成及失败均有日志；长任务每 5 秒报告当前阶段。
- Archive 导入会报告文件校验、检查点恢复和保存、当前文件行号、条目 ID、成功数、无效跳过数、非动画忽略数、累计跳过数及导入速度。计数和速度针对本次执行，`checkpointLine` 是最近一次成功保存的检查点行号。
- 备份报告校验、分页导出及恢复进度；下载报告已接收字节数、解压和文件校验阶段；calendar 每轮报告导入和 platform 补全结果。
- 失败会记录当前阶段、进度与错误原因链；远程请求失败还记录 HTTP 状态码（如已收到响应）、耗时、Cloudflare Ray ID 和服务端 `X-Request-ID`（如有）。Archive 远程请求重试另有 `api_request_retry` 日志，调整日志级别不影响重试和续跑规则。

`--log-level` 支持 `debug`、`info`（默认）、`warn`、`error` 和 `silent`。`debug` 额外记录逐条导入、API 请求开始和结束、请求间隔等待；`silent` 关闭 CLI 日志，失败仍返回非零退出码。Node 自身的运行时警告不受此参数控制。

```sh
# 详细查看每条导入和请求状态
bun run cli sync-archive --file data/subject.jsonlines --api-url https://your-api.example.com --as-of 2026-10-20T08:18:54Z --request-delay-ms 1000 --log-level debug

# PowerShell：结果与日志分别保存
bun run cli sync-archive --file data/subject.jsonlines --as-of 2026-10-20T08:18:54Z 1>result.json 2>sync.log

# 只保留命令结果
bun run cli stats --log-level silent
```

日志不记录请求头和请求正文；已配置的 `ADMIN_TOKEN`、`BANGUMI_ACCESS_TOKEN` 和错误文本中的 Bearer 凭证会脱敏。无需在 Cloudflare 配置日志参数，这些选项只影响本机 CLI。

### calendar 日历导入与定时更新

管理接口为 `POST /api/v1/admin/calendar/sync`，使用 `Authorization: Bearer <ADMIN_TOKEN>`，不需要请求正文。服务端访问 `https://api.bgm.tv/calendar` 时沿用 `BANGUMI_USER_AGENT` 和可选的 `BANGUMI_ACCESS_TOKEN`；Worker 从同名 Secret 读取 Token。

也可通过 CLI 调用：

```sh
# 本地 SQLite：使用本机 Bangumi 配置
bun run cli sync-calendar
# 远程 Worker/Node：使用目标服务的 Bangumi 配置，本地只需 ADMIN_TOKEN
bun run cli sync-calendar --api-url https://your-api.example.com
# 连续分批补全当前日历中所有可获取的空作品形式
bun run cli sync-calendar --complete-platforms --api-url https://your-api.example.com
```

返回示例：

```json
{
  "imported": 109,
  "dataAsOf": "2026-10-20T20:00:00.000Z",
  "platformsUpdated": 10,
  "platformsRemaining": 99,
  "platformFailures": [],
  "status": "partial"
}
```

`imported` 表示去重后处理的动画数量，包含新增与已存在条目，不是仅新增数量。每次导入 calendar 返回的全周数据，按 ID 去重并排除非动画。空日历不会删除已有数据。

calendar 没有完整 infobox、作品形式和排名，因此采用专门的合并及补全逻辑：

- 为未收录条目创建名称、中文名和开播日期；已有条目的详细元数据保持原值。
- 补充日历中的名称作为官方来源别名，不删除已有官方或手动别名；仍遵守单条目别名数量上限。
- 更新日历提供的评分和评分人数，保留已有排名；缺少评分字段时保留原评分，无人评分时记录 `score=null`。
- 从详情接口 `/v0/subjects/:id` 获取缺失的作品形式，按真实值区分 TV、WEB、剧场版等，不统一猜测为 TV。
- 只补空 `platform`，已有非空值和其他元数据保持原值；旧版 calendar 导入的空值在重新同步时也会补齐。补全不会阻止后续 Archive 或单条目完整导入。
- `dataAsOf` 是本次评分获取时间；保留的旧排名不会因此变成新的排名数据。

名称与评分的基础合并使用一个数据库事务，并在成功时更新 `sync_state` 中的 `calendar:last_sync`；基础数据校验或写入失败时不会留下半份基础数据。随后独立补全空作品形式，使用单独的批量更新。补全过程失败不会撤销已完成的基础导入。同步不计入用户访问统计。

每次最多补全 `CALENDAR_PLATFORM_BATCH_SIZE` 条（默认 10，允许任意正整数，不设业务上限）。返回 `platformsUpdated`（本次实际回填数量）、`platformsRemaining`（当前日历仍为空的数量）和 `platformFailures`（本次详情获取失败的 ID）。仍有空值时 `status=partial`，再次调用接口或后续定时任务会继续。游标保存在 `calendar:platform_cursor`，失败条目不会一直占据队首。

CLI 追加 `--complete-platforms` 会连续调用多轮，直到当前日历的空值补齐、某轮无进展或达到 100 轮上限。CLI 输出的 `platformsUpdated` 为各轮累计回填数，`rounds` 为执行轮数；上游持续失败时仍会返回 `partial`，可按失败 ID 排查后重试。该参数仅控制 CLI；每次 HTTP 请求和每次定时触发仍遵守单批预算。

已有完整作品形式的条目不重复请求详情。其余数据库写入通过 JSON 参数批量执行；仍会按实际写入行数消耗 D1 额度。

Worker 已内置上述 Cron。Node.js 自部署默认关闭每日调度，设置以下环境变量并重启即可启用：

```dotenv
CALENDAR_SYNC_ENABLED=true
CALENDAR_SYNC_HOUR_UTC=20
```

Node 调度按 UTC 整点每天执行，重启后等待下一个计划时间；如需立即导入，调用接口或 CLI。任务完成后才安排下一次，不在同一调度器中重叠执行。服务停止时取消计时器；实例停机期间不会补跑。两个运行环境的定时任务均记录 `calendar_sync_complete` / `calendar_sync_partial` / `calendar_sync_failed`，不输出认证凭证。Worker 任务失败会向平台报告失败。

## 访问统计与冷数据

`STATS_ENABLED=false` 是默认值。关闭时查询不读写访问统计；旧统计仍保留，管理员可以查看或清理。Node 修改 `.env` 后重启，Worker 修改变量后重新部署。

开启后的规则：

- 每个成功请求内，同一条目最多累计一次；多个别名命中同一条目不会重复计数。
- 不同 HTTP 请求分别计数，包括重试请求。这是请求命中数，不是独立访客数。
- 批量查询及条目详情计数；别名列表、歧义候选、未命中、同步和管理检查不计数。
- 记录最近访问时间、累计次数、每日次数；每日以 UTC 划分，7/30 天窗口包含当天。
- 每次统计对总计和每日记录使用同一事务。失败时不阻断查询，并记录 `usage_write_failed` 事件。
- 不记录查询原文、IP、User-Agent，也不声称近似统计可以直接支撑可靠自动删除。

```sh
bun run stats:summary
bun run retention:preview
bun run cli stats-prune --days 90
```

`stats-prune` 每次最多删除 1000 条历史每日记录，返回 `hasMore`；可定期继续执行。它保留累计次数和最近访问时间，保留天数至少为 30 天。

冷数据预览默认筛选已入库超过 90 天、90 天无访问且未固定保留的条目，最多返回 100 条。统计关闭时不给出冷数据候选。**首版始终返回 `actionable=false`，没有条目删除接口，也不自动删除人工别名。** 启停统计或写入失败都会产生观察空窗，必须结合统计完整性判断。

## 备份与迁移

```sh
bun run cli export --out backup.jsonl
bun run cli export --out cloudflare-backup.jsonl --api-url https://your-worker.example.com
```

JSONL 每行包含 `version:1`、条目、全部来源别名、当前评分、累计及每日统计。导出输出文件 SHA-256；写入完成前使用 `.partial` 文件。同步检查点属于环境运行状态，不包含在业务备份中。

恢复到**空数据库**：修改 `DATABASE_PATH` 指向新的文件后执行：

```sh
bun run cli import --file backup.jsonl
```

恢复到已迁移的空 D1：

```sh
bun run cli import --file backup.jsonl --api-url https://your-worker.example.com
```

恢复前会完整验证文件，随后逐条目原子恢复；如果中途失败，已完成的条目保留，不代表整库恢复成功。请使用新的空目标重新恢复，不要直接覆盖生产数据。

导出是分页逻辑备份，**不提供跨页数据库快照隔离**。正式迁移时先停止同步和管理写入，并关闭访问统计，再导出、恢复、核对查询结果和记录数，最后切换流量。SQLite 原生备份可以另作本地灾备。

## 配置

| 配置                           | 默认值                                  | 说明                                                                          |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------- |
| `HOST`                         | `0.0.0.0`                               | Node 监听地址                                                                 |
| `PORT`                         | `3000`                                  | Node 端口                                                                     |
| `DATABASE_PATH`                | `./data/bangumi.sqlite`                 | Node/本地 CLI 数据库                                                          |
| `ADMIN_TOKEN`                  | 空                                      | 空值关闭管理 API；非空至少 32 字符                                            |
| `STATS_ENABLED`                | `false`                                 | 仅接受 `true` / `false`                                                       |
| `MAX_BATCH_SIZE`               | `20`                                    | 允许 1～20                                                                    |
| `RATING_TTL_HOURS`             | `24`                                    | 评分过期标记阈值，不代表自动刷新间隔                                          |
| `BANGUMI_USER_AGENT`           | 空                                      | 单条目同步所需的应用标识，Worker 配置在 `vars`，Node/本地 CLI 使用环境变量    |
| `BANGUMI_ACCESS_TOKEN`         | 空                                      | 可选的 Bangumi 原始 Token；Worker 必须使用 Secret，Node/本地 CLI 使用环境变量 |
| `CALENDAR_SYNC_ENABLED`        | Node 默认 `false`，Worker 配置为 `true` | 是否启用日历定时任务，仅接受 `true` / `false`，不影响手动导入                 |
| `CALENDAR_SYNC_HOUR_UTC`       | `20`                                    | Node 每日调度的 UTC 小时，允许 0～23；Worker 使用 `triggers.crons`            |
| `CALENDAR_PLATFORM_BATCH_SIZE` | `10`                                    | 单次日历同步最多补全的空作品形式数量，允许任意正整数                          |

## 服务端异常日志

Node 和 Worker 的服务端错误以 JSON Lines 输出到标准错误或 Cloudflare 日志。每个 HTTP 响应包含服务端生成的 `X-Request-ID`，可使用它查找日志中的 `requestId`；不复用客户端提供的同名请求头。CLI 的远程请求日志也会记录该响应 ID，方便关联本地导入失败与服务端错误。

- `request_failed`：未知异常及返回 5xx 的业务错误，记录 HTTP 方法、路由模板、状态码、错误代码和请求 ID；合法的 Cloudflare Ray ID 会记录为 `rayId`。路由模板隐藏路径参数，日志不记录 URL 查询参数、请求正文、请求头或 Cookie。正常的 4xx 输入及认证错误不输出该事件。
- `usage_write_failed`：统计写入失败，包含错误原因和当前请求 ID，但不影响查询成功返回。
- `worker_configuration_error`：Worker 初始化失败，保留配置错误原因和请求 ID。此时路由尚未初始化，日志路径标记为 `[worker-initialization]`。
- `calendar_sync_failed`：Node/Worker 定时任务失败，使用 `trigger=scheduled` 和独立 ID 关联；保留上游或数据库原因，向平台抛出的错误仍使用通用消息。

错误日志中的 `causes` 最多包含 5 层原因链，每层消息最多 2000 字符、堆栈最多 8 帧；不会直接序列化异常附带的 `query`、`params` 等属性。已配置的管理 Token、Bangumi Token（包括编码形式）、Bearer 凭证、URL、引号内文本及标记出的 SQL/参数/正文片段会脱敏。HTTP 错误响应继续使用公开错误消息，不向调用者返回原因链或堆栈。

例如原先只显示 `Error` 的 D1 故障，现在可以在 `causes` 中看到 `D1_ERROR: too many terms in compound SELECT`，并用 `requestId` 对照本地 CLI 日志。修改后需要重启 Node 或重新部署 Worker 才会生效。

## 开发与验证

```sh
bun run format
bun run format:check
bun run typecheck
bun test
bun run test:integration
bun run build
bun run check
```

项目使用 Prettier 统一格式，`bun run check` 包含格式检查、类型检查、单元测试、构建和集成测试；GitHub Actions 使用相同入口。开发和贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

`bun test` 只执行 Bun 单元测试；集成测试由 Node 运行，启动真实 Node HTTP 服务及 Miniflare/workerd 本地 Worker+D1，覆盖统计开关、别名冲突、同步时间保护、统计失败隔离、SQL 参数化、CLI 断点和数据库跨适配器往返。

未将本地 Worker 测试等同于真实 Cloudflare 免费配额测试，也未进行全量 Archive 导入或生产压测。Docker 配置应在有 Docker 的环境中构建验证。

## 许可证

项目代码使用 [MIT License](LICENSE)，允许修改、分发和商业使用，分发时需保留版权及许可声明。Bangumi 数据及第三方依赖遵循各自的使用条款和许可证。

发布到 GitHub 时应包含 `bun.lock`、迁移文件和 `wrangler.jsonc`，以及 `.env.example`。`wrangler.jsonc` 中的数据库 ID 是部署标识，克隆项目后需替换为自己的数据库；真实 Token 通过环境变量或 Cloudflare Secret 配置。忽略规则已排除本机凭证、数据库、Archive、备份、构建产物及日志。

## 参考

- [Bangumi API](https://bangumi.github.io/api/)
- [Bangumi Archive](https://github.com/bangumi/Archive)
- [Bangumi User-Agent 规范](https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md)
- [Bangumi 分类常量](https://github.com/bangumi/common/blob/master/subject_platforms.yml)
- [Cloudflare D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)
