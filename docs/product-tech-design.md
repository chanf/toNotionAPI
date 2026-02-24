# WX2Notion 产品设计与技术设计（MVP）

更新日期：2026-02-20

## 1. 背景与目标

目标是做一个 Android App，让用户在微信内把公众号内容分享给该 App，App 可查看内容，并自动同步到 Notion。

核心价值：
- 降低“看到好文 -> 保存整理”的操作成本
- 统一沉淀到 Notion，便于检索与二次加工
- 在 App 内提供“收件箱式”状态可视化（待同步/成功/失败）

## 2. 范围定义

### 2.1 MVP 范围
- Android 端支持接收系统分享（优先 `text/plain` 链接）
- 识别微信公众号文章链接（`mp.weixin.qq.com`）
- App 内展示条目列表与详情（标题、摘要、封面、链接、同步状态）
- 同步到 Notion（在目标父页面下创建文章子页面 + 可选写入正文块）
- 失败可重试，支持幂等去重（同一 URL 不重复写入）

### 2.2 非 MVP（后续）
- iOS 客户端
- 视频号/小程序复杂内容解析
- 富文本 100% 样式还原
- 多 Notion 工作区复杂路由规则
- 团队协作与多用户权限系统

## 3. 产品设计

### 3.1 目标用户
- 重度微信阅读 + Notion 笔记用户
- 需要把公众号内容沉淀为可检索知识库的个人用户

### 3.2 用户旅程（MVP）
1. 用户首次打开 App，完成 Notion 授权并选择目标父页面  
2. 用户在微信文章页点击“分享”，选择 WX2Notion  
3. App 接收分享内容，创建“收件箱条目”  
4. 后台解析文章并同步到 Notion  
5. 用户在 App 内查看同步状态与结果，可点开 Notion 页面

### 3.3 信息架构
- `收件箱`：全部、同步中、成功、失败
- `详情页`：文章元信息、正文预览、同步日志、重试按钮
- `设置`：Notion 账号、目标页面、同步策略（仅链接 / 链接+正文）

### 3.4 关键功能清单
- 分享接收：支持 `ACTION_SEND` + `text/plain`
- 内容识别：URL 提取与域名校验
- 本地存储：离线可见、状态持久化
- 同步引擎：队列化处理、退避重试、幂等
- 可观测性：状态机 + 错误码 + 日志追踪

### 3.5 状态机（条目）
- `RECEIVED`：已接收，待处理
- `PARSING`：解析中
- `PARSE_FAILED`：解析失败
- `SYNCING`：同步中
- `SYNC_FAILED`：同步失败
- `SYNCED`：同步成功

## 4. 技术设计

### 4.1 总体架构

推荐“端轻云重”：
- Android 客户端：接收分享、展示状态、触发任务
- 后端 API：文章抓取解析、Notion 写入、重试与审计
- 数据库：任务与条目持久化
- 队列/Worker：异步处理同步任务

原因：
- 降低端上复杂度（解析、重试、限流）
- 避免在端上暴露 Notion 长期凭证
- 便于后续扩展多来源、多同步目标

### 4.2 Android 端设计

#### 4.2.1 分享接入
- 在 `AndroidManifest.xml` 声明分享入口 Activity：
  - `android.intent.action.SEND`
  - `android.intent.category.DEFAULT`
  - `mimeType=text/plain`
- 使用 `Intent.EXTRA_TEXT` 获取分享文本并提取 URL
- `launchMode` 推荐 `singleTop`，在 `onNewIntent` 处理二次分享进入

#### 4.2.2 客户端模块
- `share-entry`：解析分享 Intent
- `inbox`：列表/详情 UI
- `sync`：与后端通信、轮询/推送状态
- `data`：Room 本地库 + Repository
- `auth`：Notion OAuth 会话管理

#### 4.2.3 本地数据（Room）
- `article_items`
  - `id`（UUID）
  - `source_url`（唯一索引）
  - `source_type`（wechat_mp / generic_web）
  - `title` / `summary` / `cover_url`
  - `content_plaintext`（可空）
  - `status`
  - `notion_page_id`（可空）
  - `error_code` / `error_message`（可空）
  - `created_at` / `updated_at`

### 4.3 后端设计

#### 4.3.1 服务边界
- `ingest-service`：接收客户端提交链接，做去重与任务入队
- `parser-worker`：拉取 URL，解析正文与元数据
- `notion-worker`：写入 Notion 页面与页面块
- `status-service`：查询任务状态与同步结果

#### 4.3.2 任务流
1. `POST /v1/ingest`（url, client_item_id）  
2. 写库并创建 `sync_job`（状态 `PENDING`）  
3. Worker 解析 -> 更新元数据  
4. Worker 调 Notion API 创建/更新页面  
5. 回写 `notion_page_id` 与状态  
6. 客户端轮询 `GET /v1/items/{id}` 或订阅推送

#### 4.3.3 幂等与去重
- 去重键：`normalized_url`（去 tracking 参数）
- Notion 写入幂等键：`external_id = sha256(normalized_url)`
- 重试策略：指数退避（例如 1m/5m/30m，上限 N 次）

### 4.4 Notion 集成设计

#### 4.4.1 授权
- 推荐 Public Integration + OAuth
- 服务端持有 `client_secret`，移动端仅拿 session token
- 存储 `access_token` / `refresh_token`（加密）

#### 4.4.2 页面结构映射（Notion Page）
- 页面标题：文章标题
- 首段：原文链接
- 正文：Markdown 转 Notion Blocks（分段写入）
- 元信息（可选）：摘要、抓取时间等内容写入正文区

#### 4.4.3 写入策略
- 先 `POST /v1/pages` 创建页（写属性）
- 正文模式开启时，再 append block children 分批写入
- 超长内容按 Notion 限制切块，避免单请求超限

### 4.5 接口草案

#### 4.5.1 客户端 -> 后端
- `POST /v1/ingest`
  - req: `{ client_item_id, source_url, raw_text }`
  - resp: `{ item_id, status }`
- `GET /v1/items/{item_id}`
  - resp: `{ status, metadata, notion_page_url, error }`
- `POST /v1/items/{item_id}/retry`

#### 4.5.2 OAuth
- `GET /v1/auth/notion/start`
- `GET /v1/auth/notion/callback`
- `POST /v1/auth/notion/refresh`（通常服务端内部自动执行）

### 4.6 安全与隐私
- 不在客户端保存 Notion `client_secret`
- token、refresh token 服务端加密存储（KMS/等价方案）
- 日志脱敏（URL query、token、cookie）
- 全链路 HTTPS + 鉴权（JWT/session）

### 4.7 可观测性
- 指标：
  - 接收成功率
  - 解析成功率
  - Notion 同步成功率
  - 平均端到端延迟
- 日志：
  - 每条任务 `trace_id`
  - 失败错误码分布（429/400/403/解析失败）
- 告警：
  - 连续失败阈值
  - Notion API 429 激增

## 5. 微信侧关键约束与产品策略

约束说明：
- Android 可通过系统分享 `ACTION_SEND` 接收外部文本链接，但“微信内是否始终展示分享到第三方 App 入口”受微信版本、页面类型、系统 ROM 策略影响，存在不确定性。

产品策略：
- 主流程：用户在微信中通过系统分享发送到 WX2Notion
- 兜底流程：
  - 复制链接后“从剪贴板导入”
  - App 内“粘贴链接保存”
- 在首启引导页明确说明“不同微信版本入口可能不同”

## 6. 里程碑与排期（建议）

### M1（1 周）：设计与验证
- 完成 PRD + 技术方案
- 做分享接收 PoC（至少在 2 台 Android 机型验证）
- 打通 Notion OAuth 与最小写入

### M2（1-2 周）：MVP 开发
- 实现收件箱、详情、状态机
- 后端 ingest/parser/notion worker
- 基础错误重试 + 去重

### M3（1 周）：稳定性与发布准备
- 指标/日志/告警
- 异常路径补齐（429、网络断连、授权过期）
- 灰度与验收

## 7. 验收标准（MVP）

- 可从微信分享进入 App 并生成条目
- 条目在 60 秒内完成同步（P95，不含 Notion 故障）
- 同一链接重复分享不生成重复 Notion 页面
- 同步失败可一键重试并成功恢复（常见网络错误场景）
- 用户可在 App 内查看 Notion 页面跳转链接

## 8. 主要风险与缓解

- 微信入口不稳定  
  - 缓解：提供剪贴板导入兜底；首启引导说明
- 公众号反爬或内容加载策略变化  
  - 缓解：解析器可插拔 + 失败降级为“仅保存链接”
- Notion 限流（平均 3 req/s/integration）  
  - 缓解：队列节流 + `Retry-After` + 指数退避
- OAuth/token 过期  
  - 缓解：自动刷新 + 失效回退重新授权

## 9. 技术依据（官方文档）

- Android Intents & Intent Filters（分享接收）  
  https://developer.android.com/guide/components/intents-filters
- Android Tasks and Back Stack（`onNewIntent`/`singleTop`）  
  https://developer.android.com/guide/components/activities/tasks-and-back-stack
- Notion API Create Page  
  https://developers.notion.com/reference/post-page
- Notion API Append Block Children  
  https://developers.notion.com/reference/patch-block-children
- Notion API Request Limits（速率与载荷限制）  
  https://developers.notion.com/reference/request-limits
- Notion OAuth Token  
  https://developers.notion.com/reference/create-a-token
