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

## 提交与 Pull Request

- 提交信息遵循 Conventional Commits，描述尽量使用中文，例如 `fix(cli): 修复远程导入检查点日志`。
- PR 说明具体问题、修改后的行为和实际执行的验证；文档尽量使用中文。
- 修改共享业务或 SQL 时，应确认 SQLite、D1、PostgreSQL 三种存储均适用；方言差异集中在存储适配器，PostgreSQL 迁移独立放在 `migrations/postgres`。修复缺陷时添加能复现问题的回归测试。
- 修改 API、配置或 CLI 参数时，同步更新 README；涉及接口契约时也应更新 OpenAPI。
- 不提交真实 Token、`.env`、`.dev.vars`、数据库、Archive 文件、备份或运行日志。使用虚构数据制作最小复现；提交日志前移除凭证和个人信息。

## 许可

项目代码按 [MIT License](LICENSE) 发布。提交贡献即表示同意以该许可证提供贡献。Bangumi 数据及第三方依赖遵循各自的使用条款和许可证。
