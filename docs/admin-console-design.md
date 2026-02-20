# 管理后台与多用户 Notion 配置设计（草案）

更新日期：2026-02-21  
适用范围：`toNotionAPI`（Cloudflare Worker + D1）

## 1. 背景与目标

当前系统已具备：
- 基于 `api_access_tokens` 的 Bearer Token 鉴权
- 管理员创建/查询/吊销 token 能力
- 用户级 `user_settings`（Notion 目标页面配置）

当前痛点：
- 管理员与普通用户 token 管理依赖命令行/curl，操作成本高
- `NOTION_API_TOKEN` 仍是全局环境变量，不支持每个用户独立 Notion 凭证
- 缺少用户生命周期管理（创建、禁用、删除）

本设计目标：
1. 提供简易管理后台（Web）
2. 明确角色：`SUPER_ADMIN` 与 `USER`
3. 普通用户可自行配置自己的 `NOTION_API_TOKEN`
4. 超管可管理用户（创建、禁用、删除）与审计关键操作

## 2. 范围定义

### 2.1 MVP 范围
- 管理后台登录（基于 token 登录后签发会话）
- 超管用户管理：
  - 创建用户
  - 禁用/启用用户
  - 删除用户（默认逻辑删除）
- 普通用户自助能力：
  - 管理自己的 API Token（创建/查看元信息/吊销）
  - 配置自己的 Notion 凭证（`NOTION_API_TOKEN`）
  - 配置自己的 Notion 目标页面（`page_id`）
- 同步链路改为“按 user_id 读取用户 Notion 凭证”

### 2.2 非 MVP（后续）
- 密码登录/第三方 OAuth 登录
- 复杂组织架构（团队、租户、分组权限）
- 后台操作审批流

## 3. 术语与凭证说明

- `ADMIN_TOKEN`：具备管理 scope 的 API token（建议仅超管持有）
- `WEB_TOOL_API_TOKEN`：本质也是 API token，通常是普通用户 token
- `NOTION_API_TOKEN`：
  - 现状：全局环境变量（系统级）
  - 目标：用户级凭证（每个用户独立保存）

结论：`ADMIN_TOKEN` / `WEB_TOOL_API_TOKEN` 都属于统一的 `api_access_tokens` 体系，只是 scope 不同。

## 4. 角色与权限模型

## 4.1 角色
- `SUPER_ADMIN`
- `USER`

## 4.2 建议 scope
- `admin:users`：用户管理
- `admin:tokens`：所有用户 token 管理
- `items:read` / `items:write`：业务数据读写
- `self:tokens`：仅管理自己的 token
- `self:notion`：仅管理自己的 Notion 配置
- `*`：超级权限（仅保留给系统应急）

## 4.3 权限规则
- 超管：可访问所有后台管理接口
- 普通用户：只能访问 `/v1/me/*` 自助接口
- 被禁用/删除用户：鉴权直接拒绝（401/403）

## 5. 总体架构

推荐最小改造方案：
- 同一个 Worker 内提供两类接口：
  - 后台管理接口：`/v1/admin/*`、`/v1/console/*`
  - 用户自助接口：`/v1/me/*`
- 后台页面可先做静态页面（同 Worker 路由 `/console`）：
  - 登录后获得短时会话 Cookie（HttpOnly + SameSite=Lax）
  - 页面通过会话调用管理接口

这样无需额外服务，部署与运维成本最低。

## 6. 数据模型设计（D1）

> 说明：当前业务数据大量使用 `user_id TEXT`。MVP 不强制迁移为 UUID，优先兼容现状。

### 6.1 新增：用户表

`app_users`
- `id TEXT PRIMARY KEY`（如 `feng`）
- `display_name TEXT`
- `role TEXT CHECK(role IN ('SUPER_ADMIN','USER')) NOT NULL`
- `status TEXT CHECK(status IN ('ACTIVE','DISABLED','DELETED')) NOT NULL DEFAULT 'ACTIVE'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `deleted_at TEXT NULL`

### 6.2 新增：用户级 Notion 凭证

`user_notion_credentials`
- `user_id TEXT PRIMARY KEY REFERENCES app_users(id)`
- `token_ciphertext TEXT NOT NULL`
- `token_iv TEXT NOT NULL`
- `token_tag TEXT NOT NULL`
- `token_hint TEXT`（仅显示后 4~6 位）
- `api_version TEXT NOT NULL DEFAULT '2022-06-28'`
- `api_base_url TEXT NOT NULL DEFAULT 'https://api.notion.com/v1'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 6.3 新增：审计日志

`audit_logs`
- `id TEXT PRIMARY KEY`
- `actor_user_id TEXT`
- `actor_role TEXT`
- `action TEXT`（如 `USER_CREATE`、`TOKEN_REVOKE`、`NOTION_TOKEN_UPDATE`）
- `target_type TEXT`
- `target_id TEXT`
- `metadata_json TEXT`
- `created_at TEXT NOT NULL`

### 6.4 兼容策略

- 保留现有 `api_access_tokens` 表
- 保留现有 `user_settings` 表（当前底层列名仍是 `target_database_*`，语义已是 page）
- 后续可在独立迁移中重命名列为 `target_page_*`

## 7. 接口设计（草案）

## 7.1 超管接口

- `POST /v1/admin/users`
  - 创建普通用户
- `GET /v1/admin/users`
  - 用户列表（支持 `status` 过滤）
- `PATCH /v1/admin/users/{userId}`
  - 更新用户状态（ACTIVE/DISABLED）
- `DELETE /v1/admin/users/{userId}`
  - 删除用户（默认逻辑删除）
- `GET /v1/admin/users/{userId}/tokens`
  - 查看该用户 token 元信息
- `POST /v1/admin/users/{userId}/tokens`
  - 为该用户签发 token（首个登录 token）
- `POST /v1/admin/users/{userId}/tokens/{tokenId}/revoke`
  - 吊销指定 token

## 7.2 普通用户自助接口

- `GET /v1/me`
  - 当前用户信息
- `GET /v1/me/tokens`
  - 我的 token 列表（不返回明文）
- `POST /v1/me/tokens`
  - 创建我的 token（返回一次性明文）
- `POST /v1/me/tokens/{tokenId}/revoke`
  - 吊销我的 token
- `PUT /v1/me/notion-credentials`
  - 设置/更新我的 Notion token（服务端加密）
- `GET /v1/me/notion-credentials`
  - 查询我的 Notion 凭证状态（掩码）
- `DELETE /v1/me/notion-credentials`
  - 删除我的 Notion 凭证
- `PUT /v1/me/notion-target`
  - 设置我的 `page_id/page_title`

## 7.3 后台会话接口（可选）

- `POST /v1/console/login`
  - 使用 API token 换取后台短期会话 cookie
- `POST /v1/console/logout`
  - 注销会话

## 8. 同步链路改造

## 8.1 运行时 Notion 凭证来源优先级
1. 用户级 `user_notion_credentials`（首选）
2. 全局环境变量 `NOTION_API_TOKEN`（迁移期兜底）
3. 若都不存在，返回 `NOTION_TOKEN_MISSING`

## 8.2 处理逻辑
- `processItem` 中按 `item.user_id` 读取：
  - 用户 Notion 凭证
  - 用户 `page_id` 设置
- 每个用户写入各自 Notion 空间，互不影响

## 9. 后台页面设计（MVP）

### 9.1 超管端
- 用户列表页：搜索、状态筛选、创建用户
- 用户详情页：状态变更、删除用户、查看/签发/吊销 token
- 审计日志页：关键操作追踪

### 9.2 普通用户端
- 我的 API Token 页：创建、复制、吊销
- 我的 Notion 设置页：
  - `NOTION_API_TOKEN` 配置（掩码展示）
  - `page_id/page_title` 配置
  - 连通性测试按钮（可选）

## 10. 安全设计

1. `NOTION_API_TOKEN` 禁止明文落库：
   - 使用 AES-GCM 加密后入库
   - 加密主密钥从环境变量读取（例如 `CREDENTIALS_ENCRYPTION_KEY`）
2. 明文 token 仅创建时返回一次
3. 后台会话使用 HttpOnly Cookie，设置 `Secure` 与 `SameSite`
4. 所有管理操作写入审计日志
5. 删除用户默认逻辑删除，防止误删不可恢复

## 11. 迁移与上线计划

### 阶段 A：数据与接口准备（不切流）
- 增加 `app_users`、`user_notion_credentials`、`audit_logs`
- 增加 `/v1/me/*` 与 `/v1/admin/users*` 接口
- 保持现有 `/v1/admin/tokens` 可用

### 阶段 B：后台 MVP
- 上线 `/console` 基础页面
- 超管可完成用户管理
- 普通用户可自助配置 Notion 与 token

### 阶段 C：链路切换
- 同步链路优先读取用户级 Notion 凭证
- 全局 `NOTION_API_TOKEN` 仅保留兜底
- 观察期后评估是否移除兜底

## 12. 验收标准（MVP）

1. 超管可在后台创建、禁用、删除用户
2. 普通用户可登录后台并完成：
   - 创建自己的 API token
   - 设置自己的 Notion token 与目标页面
3. 两个不同用户提交公众号 URL 时，可分别写入各自 Notion 目标
4. 关键操作均可在审计日志中追踪

## 13. 风险与应对

- 风险：用户级凭证泄露
  - 应对：强制加密存储 + 最小权限 + 审计
- 风险：历史数据无用户主档
  - 应对：迁移脚本自动补齐 `app_users`（按现存 `user_id`）
- 风险：误删用户导致数据不可恢复
  - 应对：逻辑删除 + 延迟物理删除策略

## 14. 与现状差距清单（实施前）

1. 当前无 `app_users` 主档，需补
2. 当前无用户级 Notion 凭证存储，需新增
3. 当前仅有 token 管理接口，无用户管理接口
4. 当前无管理后台页面
5. 当前缺少审计日志

---

本设计文档为第一版草案。下一步建议：基于该文档拆分任务清单（Migration / API / Console UI / 测试）并按阶段实施。
