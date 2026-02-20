# wx2notion-backend

独立后端项目：Node.js (TypeScript) + Cloudflare Workers + D1。

## 独立仓库说明

`backend/` 目录已按独立项目组织，可直接拆分为单独仓库开发。

若当前目录已经是独立代码目录，初始化仓库：

```bash
git init
git add .
git status
```

## 项目结构

```text
.
├── src/                 # 业务代码
├── test/                # 单元测试
├── migrations/          # D1 migrations
├── scripts/             # 工具脚本（如 token hash）
├── docs/                # 后端文档（API/Schema/设计）
├── wrangler.toml
├── package.json
└── README.md
```

## 文档入口

- `docs/openapi.yaml`：后端 API 草案
- `docs/db_schema.sql`：D1 表结构草案
- `docs/product-tech-design.md`：MVP 产品/技术设计（含上下文）

## 功能范围（当前）

- `GET /healthz`
- `GET /docs`（Swagger UI 在线文档）
- `GET /openapi.yaml`（OpenAPI 规范）
- `POST /v1/ingest`
- `GET /v1/items`
- `GET /v1/items/{itemId}`
- `POST /v1/items/{itemId}/retry`
- `GET /v1/auth/notion/start`
- `GET /v1/auth/notion/callback`
- `PUT /v1/settings/notion-target`
- `POST /v1/admin/tokens`（管理员：创建 token）
- `GET /v1/admin/tokens`（管理员：查询 token）
- `POST /v1/admin/tokens/{tokenId}/revoke`（管理员：吊销 token）

说明：
- 当前主线已接入 D1 持久化（通过 `DB` 绑定）。
- 异步任务仍使用 `waitUntil`，后续建议接入 Queues。
- 已支持真实 Notion 写入（`POST /v1/pages`），默认本地使用 mock 模式。

## 在线 API 文档

运行服务后可直接访问：

- `GET /docs`：Swagger UI（类似 FastAPI `/docs` 体验）
- `GET /openapi.yaml`：OpenAPI 原始规范

本地开发示例：

```bash
http://127.0.0.1:8787/docs
http://127.0.0.1:8787/openapi.yaml
```

## D1 初始化

1. 创建 D1 数据库（首次）：
```bash
npx wrangler d1 create wx2notion-db
```

2. 把返回的 `database_id` 填入 `wrangler.toml` 的 `[[d1_databases]]`：
- `database_id`
- `preview_database_id`

3. 应用本地 migration：
```bash
npm run d1:migrate:local
```

4. 应用远端 migration：
```bash
npm run d1:migrate:remote
```

## API 访问 Token 初始化

后端会校验 `Authorization: Bearer <token>`，并在 D1 表 `api_access_tokens` 中验证哈希值。

1. 准备一个明文 token（示例：`wx2n_prod_xxx`）。
2. 生成 SHA-256 哈希：
```bash
npm run token:hash -- "wx2n_prod_xxx"
```
3. 把上一步输出的哈希写入 D1（本地示例）：
```bash
npx wrangler d1 execute wx2notion-db --local --command "
INSERT INTO api_access_tokens
  (id, user_id, token_hash, label, scopes, is_active, created_at, updated_at)
VALUES
  ('token-001', 'demo-user', '<TOKEN_HASH>', 'android-client', '*', 1, datetime('now'), datetime('now'));
"
```

远端同理，把 `--local` 改成 `--remote`。

## Notion 同步配置（MVP）

MVP 现支持两种模式：

- `NOTION_MOCK=true`：模拟 Notion 同步（本地默认，便于开发测试）。
- `NOTION_MOCK=false`：真实调用 Notion API 创建页面。

需要的环境变量：

- `NOTION_MOCK`：`true/false`，默认 `true`（见 `wrangler.toml`）。
- `NOTION_API_TOKEN`：Notion Integration Token（真实模式必填，建议用 `wrangler secret`）。
- `NOTION_API_VERSION`：默认 `2022-06-28`。
- `NOTION_API_BASE_URL`：默认 `https://api.notion.com/v1`。

本地真实联调示例：

```bash
npx wrangler secret put NOTION_API_TOKEN
# wrangler.toml 或 Dashboard 中设置 NOTION_MOCK="false"
npm run dev
```

注意：

- `/v1/auth/notion/callback` 目前仍是 MVP 简化实现（仅标记 `notion_connected=true`），不含完整 OAuth token 交换/刷新。
- 真实写入依赖 `NOTION_API_TOKEN` 有目标数据库写入权限，并且数据库已共享给该 integration。

常见同步错误码：

- `NOTION_TOKEN_MISSING`：关闭 mock 但未配置 `NOTION_API_TOKEN`。
- `NOTION_TARGET_MISSING`：未设置 `target_database_id`。
- `NOTION_AUTH_FAILED`：token 无效或无权限（401/403）。
- `NOTION_TARGET_NOT_FOUND`：目标库不存在或未共享（404）。
- `NOTION_RATE_LIMITED`：Notion 限流（429，可重试）。

## Token 管理 API（管理员）

管理员权限规则：
- token `scopes` 包含 `*` 或 `admin:tokens` 即可管理 token。

示例：创建 token
```bash
curl -X POST "http://127.0.0.1:8787/v1/admin/tokens" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "android-user-001",
    "label": "android-client",
    "scopes": ["items:read", "items:write"],
    "expires_at": null
  }'
```

示例：查询 token 列表
```bash
curl "http://127.0.0.1:8787/v1/admin/tokens?active=true" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

示例：吊销 token
```bash
curl -X POST "http://127.0.0.1:8787/v1/admin/tokens/<TOKEN_ID>/revoke" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## 本地开发

```bash
npm install
npm run d1:migrate:local
npm run dev
```

默认开发 token：`dev-token`（可在 `wrangler.toml` 的 `[vars]` 中调整）。
说明：仅当未绑定 D1 时使用该回退逻辑；绑定 D1 后将以 `api_access_tokens` 为准。

## 测试与类型检查

```bash
npm run typecheck
npm test
```

注：测试默认注入 InMemoryStore，避免依赖真实 D1 资源。

## Cloudflare 部署（Workers + D1）

### 1) 前置条件

- 已安装 Node.js 18+ 与 npm
- 已有 Cloudflare 账号并开通 Workers / D1
- 已安装依赖：

```bash
npm install
```

### 2) 登录 Cloudflare

```bash
npx wrangler login
```

### 3) 准备 D1 数据库

首次创建（若已创建可跳过）：

```bash
npx wrangler d1 create wx2notion-db
```

将输出中的 `database_id`、`preview_database_id` 写回 `wrangler.toml` 的 `[[d1_databases]]` 配置。

然后执行远端 migration：

```bash
npm run d1:migrate:remote
```

### 4) 配置运行时变量与 Secret

`wrangler.toml` 中已有默认 `[vars]`，按环境调整：

- `NOTION_MOCK`：生产建议设为 `"false"`
- `NOTION_API_VERSION`：默认 `2022-06-28`
- `NOTION_API_BASE_URL`：默认 `https://api.notion.com/v1`

真实写入 Notion 时，配置 Secret：

```bash
npx wrangler secret put NOTION_API_TOKEN
```

### 5) 部署 Worker

```bash
npm run deploy
```

### 6) 部署后验证

1. 健康检查：`GET /healthz`
2. 使用管理员 token 调用 `POST /v1/admin/tokens` 创建业务 token
3. 使用业务 token 调用 `POST /v1/ingest` 验证入库与异步状态流转

## FAQ（部署排障）

### Q1：`https://tonotion.iiioiii.xin/docs` 无法访问（404），但 `workers.dev` 可以访问，为什么？

常见原因：

- 自定义域仍被 Cloudflare Pages 项目占用（即使 DNS 已改，Pages 的 Custom Domain 绑定还在）。
- Worker 虽已部署成功，但请求并没有命中 Worker，而是落到 Pages/默认 404。

解决方案：

1. 在 `Pages -> tonotionapi -> Custom domains` 中移除 `tonotion.iiioiii.xin`。
2. 在 `DNS` 中删除旧的 `tonotion` 记录（如 A/CNAME）。
3. 在 `Workers & Pages -> tonotionapi (Worker) -> Domains` 重新添加 `tonotion.iiioiii.xin`。
4. 等待 1-5 分钟后重新验证：
   - `https://tonotion.iiioiii.xin/healthz`
   - `https://tonotion.iiioiii.xin/docs`
   - `https://tonotion.iiioiii.xin/openapi.yaml`

### Q2：部署时报错 `10021`（`binding DB of type d1 must have a database that already exists`）怎么办？

原因：

- `wrangler.toml` 中的 D1 `database_id` 还是占位值，或当前账号下没有对应 D1 数据库。

解决方案：

1. 创建 D1：
   ```bash
   npx wrangler d1 create wx2notion-db
   ```
2. 将返回的 `database_id`（和 `preview_database_id`）写入 `wrangler.toml`。
3. 执行迁移：
   ```bash
   npm run d1:migrate:remote
   ```
4. 重新部署：
   ```bash
   npm run deploy
   ```

## GitHub Actions 自动发布 Worker

仓库已提供工作流：`.github/workflows/deploy-worker.yml`

触发条件：

- push 到 `main`
- 或手动触发 `workflow_dispatch`

发布流程：

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run deploy -- --name tonotionapi --keep-vars`

请在 GitHub 仓库中配置以下 Actions Secrets（否则自动发布会失败）：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

说明：

- `--keep-vars` 用于保留 Cloudflare Dashboard 中已配置的运行时变量，避免每次发布被清空。
