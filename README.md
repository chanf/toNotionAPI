# wx2notion-backend

独立后端项目：Node.js (TypeScript) + Cloudflare Workers + D1。

## 独立仓库说明

当前目录就是后端独立仓库根目录（不是单仓中的 `backend/` 子目录）。

如需重新初始化仓库可执行：

```bash
git init
git add .
git status
```

## 项目结构

```text
.
├── src/                 # 业务代码
├── test/                # 单元测试 + Web 手工测试工具
│   └── web-tool/        # 本地网页提交工具（输入 URL -> 提交到 Notion）
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
- `docs/admin-console-design.md`：多用户与管理后台设计文档

## 5 分钟快速开始（线上环境）

1. 安装依赖并登录 Cloudflare：

```bash
npm install
npx wrangler login
```

2. 初始化/迁移 D1：

```bash
# 首次需要先创建数据库
npx wrangler d1 create wx2notion-db
npm run d1:migrate:remote
```

3. 配置关键 Secret（Worker 名称按你的实际项目替换）：

```bash
npx wrangler secret put NOTION_API_TOKEN --name tonotionapi
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY --name tonotionapi
```

如果提示 `Worker "tonotionapi" not found`，说明这是首次部署，请先执行下一步创建 Worker，再回来执行本步骤。

4. 部署 Worker：

```bash
npm run deploy -- --name tonotionapi --keep-vars
```

5. 初始化超级管理员 token（见下文“首次创建超级管理员 Token”），然后访问：

```text
https://tonotion.iiioiii.xin/console
```

6. 在 `/console` 中完成：
- 创建或登录普通用户
- 创建用户 API Token（供客户端/测试工具调用）
- 完成 Notion 授权标记（`/v1/auth/notion/start` + `/v1/auth/notion/callback`）
- 设置用户 Notion 凭证与目标页面
- 提交公众号 URL 验证链路

## 功能范围（当前）

- `GET /healthz`
- `GET /docs`（Swagger UI 在线文档）
- `GET /console`（管理后台 MVP 页面，内置同步测试工具）
- `GET /openapi.yaml`（OpenAPI 规范）
- `POST /v1/ingest`
- `GET /v1/items`
- `GET /v1/items/{itemId}`
- `POST /v1/items/{itemId}/retry`
- `GET /v1/auth/notion/start`
- `GET /v1/auth/notion/callback`
- `PUT /v1/settings/notion-target`
- `GET /v1/me`
- `GET /v1/me/tokens`
- `POST /v1/me/tokens`
- `POST /v1/me/tokens/{tokenId}/revoke`
- `GET /v1/me/notion-credentials`
- `PUT /v1/me/notion-credentials`
- `DELETE /v1/me/notion-credentials`
- `PUT /v1/me/notion-target`
- `POST /v1/admin/users`
- `GET /v1/admin/users`
- `PATCH /v1/admin/users/{userId}`
- `DELETE /v1/admin/users/{userId}`
- `GET /v1/admin/users/{userId}/tokens`
- `POST /v1/admin/users/{userId}/tokens`
- `POST /v1/admin/users/{userId}/tokens/{tokenId}/revoke`
- `POST /v1/admin/tokens`（管理员：创建 token）
- `GET /v1/admin/tokens`（管理员：查询 token）
- `POST /v1/admin/tokens/{tokenId}/revoke`（管理员：吊销 token）
- `GET /v1/admin/audit-logs`（管理员：查询审计日志）

说明：
- 当前主线已接入 D1 持久化（通过 `DB` 绑定）。
- 异步任务仍使用 `waitUntil`，后续建议接入 Queues。
- 已支持真实 Notion 写入（创建 page + 追加 blocks），是否 mock 由 `NOTION_MOCK` 控制。
- 公众号 URL 处理链路：抓取文章 HTML -> 提取正文 -> 转 Markdown -> 转 Notion Blocks -> 写入 Notion。

## 在线 API 文档

运行服务后可直接访问：

- `GET /docs`：Swagger UI（类似 FastAPI `/docs` 体验）
- `GET /openapi.yaml`：OpenAPI 原始规范

本地开发示例：

```bash
http://127.0.0.1:8787/docs
http://127.0.0.1:8787/openapi.yaml
```

OpenAPI 同步命令（避免 `/docs` 与 `docs/openapi.yaml` 漂移）：

```bash
# 将 docs/openapi.yaml 同步到运行时使用的 src/openapi.ts
npm run openapi:sync

# 仅校验是否同步（可用于 CI）
npm run openapi:check
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

### 首次创建超级管理员 Token（用于 `/console` 登录）

如果你还没有任何管理员 token，可按下面步骤初始化一个超管（示例 `user_id=feng`）：

```bash
# 1) 生成一个明文超管 token（可自定义）
SUPER_ADMIN_TOKEN="wx2n_admin_feng_$(date +%Y%m%d_%H%M%S)"
TOKEN_ID="token-superadmin-feng-$(date +%s)"

# 2) 计算哈希
TOKEN_HASH=$(npm run -s token:hash -- "$SUPER_ADMIN_TOKEN")

# 3) 写入远端 D1（scope 使用 *，拥有管理能力）
npx wrangler d1 execute wx2notion-db --remote --command "
INSERT INTO api_access_tokens
  (id, user_id, token_hash, label, scopes, is_active, created_at, updated_at)
VALUES
  ('$TOKEN_ID', 'feng', '$TOKEN_HASH', 'super-admin-bootstrap', '*', 1, datetime('now'), datetime('now'));
"

# 4) 输出明文 token（仅此处可见，请妥善保存）
echo \"SUPER_ADMIN_TOKEN=$SUPER_ADMIN_TOKEN\"
```

验证超管 token 是否生效：

```bash
curl "https://tonotion.iiioiii.xin/v1/me" \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN"
```

返回中出现 `is_admin: true` 即表示可用于 `https://tonotion.iiioiii.xin/console` 登录。

注意：

- 如果调用 `/v1/me` 返回 `INTERNAL_ERROR`，通常是远端 D1 尚未应用 `0003_multi_user_admin_console.sql`。
- 先执行 `npm run d1:migrate:remote`，再重试上述验证命令。

## Token 一览（避免混淆）

- `SUPER_ADMIN_TOKEN`：超级管理员 API Token，用于登录 `/console` 和调用管理员接口（`/v1/admin/*`）。
- `API_TOKEN` / `WEB_TOOL_API_TOKEN`：业务调用 token（本质同一类 Access Token），用于调用 `/v1/ingest`、`/v1/items*` 等接口。
- `NOTION_API_TOKEN`：Notion Integration Token，不是本系统鉴权 token，用于 Worker 调用 Notion API 写入内容。

获取 `API_TOKEN` 的推荐方式：

1. 用 `SUPER_ADMIN_TOKEN` 登录 `https://tonotion.iiioiii.xin/console`。
2. 在“我的 Token”或管理员的“用户 Token 管理”里创建 token。
3. 创建响应里的 `token` 明文只会返回一次，请立即保存。

## Notion 同步配置（MVP）

MVP 现支持两种模式：

- `NOTION_MOCK=true`：模拟 Notion 同步（便于本地调试，不会写入真实 Notion）。
- `NOTION_MOCK=false`：真实调用 Notion API 创建页面。

当前仓库 `wrangler.toml` 示例配置为 `NOTION_MOCK="false"`（即真实写入模式）。

需要的环境变量：

- `NOTION_MOCK`：`true/false`，默认 `false`（未设置时为 `false`，`wrangler.toml` 示例也为 `false`）。
- `NOTION_API_TOKEN`：Notion Integration Token（真实模式下的全局兜底 token，建议用 `wrangler secret`）。
- `NOTION_API_VERSION`：默认 `2022-06-28`。
- `NOTION_API_BASE_URL`：默认 `https://api.notion.com/v1`。
- `CREDENTIALS_ENCRYPTION_KEY`：用于加密存储用户级 `NOTION_API_TOKEN`（启用 `/v1/me/notion-credentials` 必填，建议配置为 secret）。
- `LOG_LEVEL`：日志级别，支持 `debug/info/warn/error`，默认 `info`。

### CREDENTIALS_ENCRYPTION_KEY 如何配置

`CREDENTIALS_ENCRYPTION_KEY` 只要求“非空字符串”，建议使用随机高熵值：

```bash
openssl rand -base64 32
```

将输出值写入 Worker Secret（示例）：

```bash
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY --name tonotionapi
```

说明：

- 已保存的用户凭证会使用这个 key 进行加密/解密。
- 变更该 key 后，历史凭证将无法解密，需要用户重新保存 Notion 凭证。

### 首次授权（设置 notion_connected=true）

当前实现会在同步前校验 `notion_connected`，如果未授权会返回 `NOTION_NOT_CONNECTED`。  
MVP 阶段可用以下方式完成授权标记：

1. 获取 OAuth state（保存返回的 `state`）：

```bash
curl "https://tonotion.iiioiii.xin/v1/auth/notion/start" \
  -H "Authorization: Bearer <API_TOKEN>"
```

2. 回调标记授权成功（将 `<STATE_FROM_START>` 替换为上一步返回的 state）：

```bash
curl "https://tonotion.iiioiii.xin/v1/auth/notion/callback?code=demo&state=<STATE_FROM_START>"
```

说明：

- 该回调是当前 MVP 简化实现，仅用于设置授权状态。
- 后续若切换完整 OAuth，会改为真实 token 交换流程。

本地真实联调示例：

```bash
npx wrangler secret put NOTION_API_TOKEN
# 根据调试目标在 wrangler.toml 或 Dashboard 中设置 NOTION_MOCK:
# - true: 仅模拟，不写入 Notion
# - false: 真实写入 Notion
npm run dev
```

注意：

- `/v1/auth/notion/callback` 目前仍是 MVP 简化实现（仅标记 `notion_connected=true`），不含完整 OAuth token 交换/刷新。
- 同步时优先使用用户级凭证（`/v1/me/notion-credentials`），若未配置则回退到全局 `NOTION_API_TOKEN`。
- 真实写入依赖 `NOTION_API_TOKEN` 具备目标页面写入权限，并且该页面已共享给 integration。
- 当前仅支持“Page 目标”模式（不再使用 database 目标模式）。
- 推荐使用 `PUT /v1/me/notion-target` 设置 `page_id`；`PUT /v1/settings/notion-target` 为兼容保留接口。

示例（推荐）：

```bash
curl -X PUT "https://tonotion.iiioiii.xin/v1/settings/notion-target" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "page_id": "<NOTION_PARENT_PAGE_ID>",
    "page_title": "公众号文章收集"
  }'
```

### 公众号正文解析与格式转换（当前实现）

1. Worker 获取 `mp.weixin.qq.com` 页面 HTML。
2. 从 `id="js_content"` 提取正文区域。
3. 将正文 HTML 转为 Markdown（支持段落、标题、列表、引用、代码块）。
4. 将 Markdown 转成 Notion Blocks 并写入页面。

说明：

- 若请求里提供 `raw_text` 且它不是 URL，会作为本地兜底正文（便于离线测试）。
- 当前为了优先保障链路稳定，图片会被忽略，不写入 Notion。
- Notion 单次 append children 有 100 条限制，服务端会自动分批追加。
- Notion `rich_text.text.content` 有长度限制，服务端会自动分段截断，避免超限报错。

常见同步错误码：

- `NOTION_NOT_CONNECTED`：当前用户尚未完成 Notion 授权标记。
- `NOTION_TOKEN_MISSING`：关闭 mock 但未配置 `NOTION_API_TOKEN`。
- `NOTION_TARGET_MISSING`：未设置 Notion 目标页面 ID（`page_id`）。
- `NOTION_AUTH_FAILED`：token 无效或无权限（401/403）。
- `NOTION_TARGET_NOT_FOUND`：目标页面不存在或未共享（404）。
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

示例：查询某个用户的 token
```bash
curl "http://127.0.0.1:8787/v1/admin/users/<USER_ID>/tokens?active=true" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

示例：为某个用户签发 token
```bash
curl -X POST "http://127.0.0.1:8787/v1/admin/users/<USER_ID>/tokens" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "user-device-01",
    "scopes": ["items:read", "items:write"],
    "expires_at": null
  }'
```

示例：吊销某个用户的 token
```bash
curl -X POST "http://127.0.0.1:8787/v1/admin/users/<USER_ID>/tokens/<TOKEN_ID>/revoke" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

示例：查看审计日志
```bash
curl "http://127.0.0.1:8787/v1/admin/audit-logs?limit=50" \
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

### Web 手工测试工具（test 目录）

如果你想在浏览器里手工输入公众号 URL 并直接触发同步，可使用：

```bash
WEB_TOOL_API_TOKEN="<API_TOKEN>" \
WEB_TOOL_API_BASE_URL="https://tonotion.iiioiii.xin" \
npm run test:web-tool
```

然后打开：

```bash
http://127.0.0.1:4173
```

说明：

- `/console` 已内置“同步测试工具”（提交 URL + 自动轮询），优先推荐在后台直接测试。
- 该工具在 `test/web-tool` 下，是独立的本地页面与本地代理服务。
- 页面只需要输入公众号 URL，点击提交后会调用 `/v1/ingest` 并轮询到最终状态。
- 默认端口为 `4173`，可通过 `WEB_TOOL_PORT` 覆盖。
- 若未设置 `WEB_TOOL_API_BASE_URL`，默认使用 `https://tonotion.iiioiii.xin`。
- `WEB_TOOL_API_TOKEN` 就是普通的 `API_TOKEN`，可在 `/console` 的“我的 Token”中创建。

## 管理后台（/console）

服务内置了一个最小管理后台页面，便于手工管理用户、Token、Notion 凭证与目标页。

- 访问地址：`/console`（例如 `https://tonotion.iiioiii.xin/console`）
- 登录方式：输入任意有效 API Token（`Authorization: Bearer <token>`）
- 普通用户能力：
  - 查看 `/v1/me` 资料
  - 管理自己的 `/v1/me/tokens*`
  - 管理自己的 `/v1/me/notion-credentials` 与 `/v1/me/notion-target`
  - 使用“同步测试工具”提交公众号 URL，并轮询 `/v1/items/{itemId}` 查看最终状态
- 超管额外能力：
  - 管理 `/v1/admin/users*`（创建/查询/更新/删除用户）
  - 管理指定用户的 `/v1/admin/users/{userId}/tokens*`
  - 查看 `/v1/admin/audit-logs`（审计日志）

注意：

- 若要保存“用户级 Notion 凭证”，必须配置 `CREDENTIALS_ENCRYPTION_KEY`，否则接口会返回 `CONFIG_MISSING`。
- `/console` 仅为 MVP 管理入口，生产环境建议结合 Access / Zero Trust 做额外访问控制。

### CLI 线上链路测试（可选）

如果你想直接在终端验证线上链路，可使用：

```bash
API_TOKEN="<API_TOKEN>" \
API_BASE_URL="https://tonotion.iiioiii.xin" \
npm run ingest:online -- --source-url "https://mp.weixin.qq.com/s/BR7smBzxDaLcH8j8M6oJ9A"
```

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
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY
```

如果这里提示 Worker 不存在，请先执行一次 `npm run deploy -- --name tonotionapi`，再回到本步骤配置 secret。

### 5) 部署 Worker

```bash
npm run deploy
```

### 6) 部署后验证

1. 健康检查：`GET /healthz`
2. 使用管理员 token 调用 `POST /v1/admin/tokens` 创建业务 token
3. 使用业务 token 调用 `POST /v1/ingest` 验证入库与异步状态流转

### 7) 服务端日志与排障

本项目已内置结构化日志（JSON 行日志），覆盖：

- 请求入口：`request.received` / `request.completed` / `request.failed`
- 同步流水线：`pipeline.started` / `pipeline.parse.*` / `pipeline.sync.*`
- 异步任务兜底：`pipeline.unhandled`

线上查看日志：

```bash
npx wrangler tail tonotionapi
```

按级别过滤日志可通过 `LOG_LEVEL` 控制（`debug/info/warn/error`）。

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

### Q3：为什么 `wrangler secret list --name tonotionapi` 报 Worker 不存在，但 `npx wrangler secret list --name tonotionapi` 正常？

常见原因：

- 全局 `wrangler` 与项目内 `wrangler` 版本或登录态不一致。
- 当前 shell 下全局 `wrangler` 登录了不同 Cloudflare 账号。

建议做法：

1. 优先使用项目内命令：`npx wrangler ...`。
2. 执行 `npx wrangler whoami` 确认账号。
3. 使用 `npx wrangler versions list --name tonotionapi` 验证 Worker 是否存在。

### Q4：`/v1/ingest` 已成功，D1 也有记录，但 Notion 看不到文章怎么办？

按顺序检查：

1. 查询条目最终状态：`GET /v1/items/{itemId}`。
2. 若 `status=SYNC_FAILED`，优先看 `error.code`（如 `NOTION_TOKEN_MISSING`、`NOTION_TARGET_MISSING`、`NOTION_AUTH_FAILED`、`NOTION_TARGET_NOT_FOUND`）。
3. 确认目标父页面已共享给对应 Notion integration。
4. 若用用户级凭证，确认已配置 `CREDENTIALS_ENCRYPTION_KEY` 且该用户执行过 `PUT /v1/me/notion-credentials`。
5. 查看实时日志进一步定位：
   ```bash
   npx wrangler tail tonotionapi
   ```

## 部署策略

当前仓库默认不依赖 GitHub Actions 发布 Worker（以 Cloudflare 平台侧部署为主）。

统一采用 Cloudflare Worker 原生部署方式：

1. 本地执行部署：
   ```bash
   npm run deploy -- --name tonotionapi --keep-vars
   ```
2. 在 Cloudflare Dashboard 查看最新 Deployment 是否更新。
3. 验证线上接口：
   - `https://tonotion.iiioiii.xin/healthz`
   - `https://tonotion.iiioiii.xin/docs`
   - `https://tonotion.iiioiii.xin/openapi.yaml`
