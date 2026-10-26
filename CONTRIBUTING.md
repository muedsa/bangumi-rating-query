# 参与开发

本项目是基于 Bun + TypeScript 的 JSON 后端，提供 Cloudflare Worker + D1 和 Node.js + SQLite/PostgreSQL 两种运行方式。

## 准备环境

安装 Bun 1.4.3 或更高版本，以及 Node.js 24.12 或更高版本，然后执行：

```sh
bun install --frozen-lockfile
bun run check
```

需要本地管理功能时，将 `.env.example` 复制为 `.env`，填写自己的配置。测试使用独立数据库和本地 Worker，不需要生产凭证或 Cloudflare 账号。

## 格式与验证

`.editorconfig` 和 `.gitattributes` 统一使用 UTF-8、LF 换行及两空格缩进。TypeScript、JSON、JSONC、YAML 和 Markdown 使用 Prettier：

```sh
# 自动格式化
bun run format
# 只检查格式
bun run format:check
# 完整验证：格式、类型、单元测试、构建与 Node/Worker 集成测试
bun run check
```

请随依赖变更提交 `package.json` 和 `bun.lock`，不要手动修改锁文件。GitHub Actions 会运行同一套检查。

## 数据库迁移

迁移目录和框架保留。发布前历史步骤已合并到 `migrations/0001_initial.sql` 和 `migrations/postgres/0001_initial.sql`，两者直接创建当前第 4 版完整结构；版本标识及文件名保留以兼容现有完整数据库和 D1 迁移记录。

正式发布后新增变更应追加 SQL，不改写已发布文件：

1. 在两个目录分别添加同名迁移文件，例如下一版 `0005_example.sql`。
2. 在 `src/adapters/storage/schema.ts` 的 `MIGRATIONS` 中按版本升序追加 `{ version: 5, file: '0005_example.sql' }`，并更新 `SCHEMA_VERSION`。
3. 每份迁移末尾将 `schema_version` 从前一版本更新为目标版本；不要按迁移数组下标推算数据库版本，初始基线已合并了多个历史版本。
4. 为新增迁移补充已有数据升级、重复执行和失败回滚测试；验证 SQLite、D1、PostgreSQL 均保留业务数据。

当前 `tests/migrations.ts` 验证合并后的空库初始化、约束与默认值、重复启动不改写数据、失败回滚以及发布前旧结构拒绝升级；未来追加的升级用例继续放在此文件。PostgreSQL 的事务锁和 SQLite 的写锁仍保护并发启动，D1 继续通过 Wrangler 应用迁移。

## 提交与 Pull Request

- 提交信息遵循 Conventional Commits，描述尽量使用中文，例如 `fix(cli): 修复远程导入检查点日志`。
- PR 说明具体问题、修改后的行为和实际执行的验证；文档尽量使用中文。
- 修改共享业务或 SQL 时，应确认 SQLite、D1、PostgreSQL 三种存储均适用；方言差异集中在存储适配器，PostgreSQL 迁移独立放在 `migrations/postgres`。修复缺陷时添加能复现问题的回归测试。
- 修改 API、配置或 CLI 参数时，同步更新 README；涉及接口契约时还需更新 [HTTP API 文档](docs/api.md) 和 OpenAPI。
- 不提交真实 Token、`.env`、`.dev.vars`、数据库、Archive 文件、备份或运行日志。使用虚构数据制作最小复现；提交日志前移除凭证和个人信息。

## API 契约维护

请求字段优先复用 `src/core` 的业务模型或 `src/http/contracts.ts`，路由和 OpenAPI 共用校验约束。响应结构集中在 `contracts.ts`；上游搜索、日历和备份使用相应核心模型。不要以任意对象替代已知返回字段。

`src/http/openapi.ts` 声明路由、参数、鉴权、operationId 及响应。请求模型用 Zod 的 `io: 'input'` 导出，响应用 `io: 'output'`，避免带默认值的请求字段被误标为必填。Zod refinement 不一定能导出：能用 JSON Schema 表达的约束应显式补充，其他跨字段规则应在操作说明和文档中写清楚，并保留服务端校验测试。

错误目录位于 `src/http/openapi-errors.ts`，虚构示例位于 `src/http/openapi-examples.ts`。每个操作只列出其实际可能返回的业务错误，公共中间件错误统一维护。新增接口应补充参数、默认值、可空语义、时间单位、成功和失败结构，以及重试后的副作用；不要将 200 的 `not_found`、`ambiguous`、`partial` 当作 HTTP 错误。

`tests/unit/openapi.test.ts` 检查路由覆盖、模型引用、示例、默认值及动态批量上限；`tests/openapi.ts` 使用内存 SQLite 和模拟上游，验证全部操作的真实请求/响应以及关键错误分支。后者已包含在 `bun run test:integration` 中。定向运行：

```sh
bun test tests/unit/openapi.test.ts
bun build tests/openapi.ts --target=node --packages=external --outfile=.cache/openapi.mjs
node --test .cache/openapi.mjs
```

完成定向检查后运行 `bun run check`，同时验证 Node、Worker 与 PostgreSQL 适配器；测试不得依赖生产 Token 或实际 Bangumi 请求。

## 许可

项目代码按 [MIT License](LICENSE) 发布。提交贡献即表示同意以该许可证提供贡献。Bangumi 数据及第三方依赖遵循各自的使用条款和许可证。
