# 公众号文章图片处理技术设计（草案）

更新日期：2026-02-22  
适用范围：`toNotionAPI`（Cloudflare Worker + D1）

实现状态（截至 2026-02-22）：
- P0 已实现：图片集中追加 + Notion file_upload（失败隔离）。
- 代码入口：`src/image-pipeline.ts`（提取/下载/上传/生成 blocks），`src/pipeline.ts`（在 page 创建后追加图片分区）。

## 1. 背景与目标

当前主链路已实现“公众号文章 -> Markdown/Blocks -> Notion Page”，但图片被显式忽略：
- `src/article-parser.ts`：HTML -> Markdown 阶段直接移除 `<img>`。
- `src/notion-blocks.ts`：Markdown -> Notion Blocks 阶段跳过 `![]()` 图片语法。

这导致最终 Notion 内容对“图文类文章”不完整，也无法满足“离线回看/长期保存”的预期。

本设计目标：
1. 在 Notion 页面中写入文章图片（至少保证可见和稳定）。
2. 图片来源策略以“下载图片”作为前提，避免依赖微信外链长期可用性。
3. 失败隔离：单张图片处理失败不应导致整篇同步失败（默认降级为跳过该图或保留外链）。
4. 兼容现有多用户模式：图片处理使用请求级 `notion_api_token`（与当前 ingest/retry 一致）。

## 2. 范围定义

### 2.1 计划内（分阶段交付）

P0（先打通图片链路，低风险）：
- 从文章 HTML 中提取图片列表并下载处理。
- 将图片以“集中追加”的方式写入 Notion（例如放在正文末尾的“图片”分区），不保证与原文位置完全一致。

P1（体验完善，保持顺序/位置）：
- 在 HTML -> Markdown 阶段将 `<img>` 转成 Markdown image 语法（或抽象出 image tokens），并在 Blocks 生成阶段按原顺序插入图片 blocks。

### 2.2 非目标（暂不做）
- 100% 还原公众号排版（对齐、居中、宽度、复杂图文混排）。
- 图片压缩/裁剪/格式转换（webp -> png/jpg 等）。
- 私有鉴权图片（Notion 拉取外部资源时无法携带自定义鉴权头）。

## 3. 约束与事实依据

### 3.1 Notion API 能力与限制（权威约束）

1. 图片/文件类 Block 支持 `external.url` 引用外部可公开访问的 HTTPS 资源。
2. Notion 支持“小文件上传”流程：
   - `POST /v1/file_uploads` 创建 `file_upload`（返回 `id` 与 `upload_url`）
   - `POST /v1/file_uploads/{file_upload_id}/send` 以 `multipart/form-data` 上传文件
   - 创建/追加图片 block 时使用 `image.type="file_upload"`，并传入 `file_upload.id`
3. `send` 接口存在 20MB 上限；不支持/超限时需降级。

### 3.2 Cloudflare Worker 运行约束
- 无本地磁盘：无法“下载到服务器文件系统”，只能下载到内存，再写入外部存储（Notion file upload / R2 / 其他）。
- 单次执行时长与资源有限：图片数量多、体积大时需要并发/总量控制，必要时依赖队列异步消费（当前已支持 Queue consumer）。

### 3.3 微信图片特点与风险
- 图片常见为 `<img data-src="...">`（lazy-load），`src` 可能是占位。
- 可能存在反盗链：下载时需携带 `Referer`（文章 URL 或 `https://mp.weixin.qq.com/`）与合理 `User-Agent`。
- SSRF 风险：若允许用户提交任意 `raw_text` 或非微信 URL，图片下载可能被滥用访问内网地址，需要 URL 安全校验。

## 4. 方案概览与推荐

图片落地核心是“资产管线（Asset Pipeline）”，把原始图片 URL 转成可插入 Notion 的 image block。

### 4.1 方案 A：Notion File Upload（推荐默认）

流程：下载微信图片 -> 上传到 Notion（file_upload）-> 创建 image block 引用 `file_upload.id`。

优点：
- 图片进入 Notion 体系（不依赖外部 CDN/域名长期可用）。
- 不需要额外基础设施（R2、公开域名、清理策略）。

缺点：
- 每张图片增加 Notion API 调用次数（创建 upload + send + 追加 block），更容易触发 Notion 限流（429）。
- 受 20MB 限制，且对 content-type 有限制。

适用：
- 大多数公众号图片（通常远小于 20MB）。
- 希望“所有资产都在 Notion 内闭环”的用户。

### 4.2 方案 B：R2 托管 + Worker 资产路由（可选兜底/替代）

流程：下载微信图片 -> 写入 R2 -> 通过 Worker 提供公网 URL -> 以 `external.url` 写入 image block。

优点：
- 不增加 Notion API 调用次数（仍只做创建 page + append children）。
- 可缓存、可去重、可承载 >20MB（取决于策略）。

缺点：
- 需要 R2 资源与公开访问路由；需要额外的安全/风控与生命周期管理。

适用：
- 不希望把图片上传到 Notion，或需要处理超出 20MB 的图片。
- 需要更强的可控性（缓存、替换、回收）。

### 4.3 推荐策略：可插拔 + 兜底降级

建议实现“策略可配置”：
- 默认 `notion_upload`（方案 A）。
- 当 Notion 上传失败/超限/被禁用时，切换到 `r2`（方案 B）或 `skip/external_passthrough`（最弱兜底）。

对用户体验的原则：
- 正文永远优先同步成功。
- 图片失败不阻塞整篇（记录日志与资产状态即可）。

## 5. 处理流程设计

### 5.1 图片提取（从 HTML）

输入：`ParsedArticle.contentHtml`（`#js_content` 内部 HTML）与 `sourceUrl`。

输出：按原文顺序的图片列表：
- `index`：图片在文中的序号（用于稳定排序）
- `source_url`：原始图片 URL（优先 `data-src`，其次 `src`）
- `alt`：可选（从 `alt` 或周边文字推断，MVP 可先为空）

注意：提取阶段不做下载，只做轻量解析与 URL 规范化（相对路径转绝对路径）。

### 5.2 图片下载（通用）

输入：`source_url`、文章 URL。

行为约束：
- 仅允许 `https:`（可选允许 `http:`，但默认拒绝）。
- SSRF 防护：拒绝 `localhost`、私网 IP、`file:`、`ftp:` 等协议；可选“微信图片域白名单”（例如 `mmbiz.qpic.cn` 等）。
- 增加超时与大小上限：
  - `MAX_IMAGE_BYTES`：默认 20MB（与 Notion upload 上限一致）
  - `MAX_IMAGE_COUNT`：默认 20~40（防止单篇文章极端图片拖垮任务）
- 下载请求头：
  - `Referer: <article_url>`（或 `https://mp.weixin.qq.com/`）
  - `User-Agent`：沿用当前抓取 HTML 的移动端 UA

输出：
- `bytes`（或 stream）
- `content_type`
- `content_length`
- `sha256`（可选，用于去重与缓存）

失败策略：
- 单张失败仅记录，不中断正文同步。
- 若下载失败率过高，可在日志中提示“建议开启 R2 或降低图片数量”。

### 5.3 Notion file_upload 路径（方案 A）

对每张图片：
1. `POST /v1/file_uploads` 创建 upload（带 `filename`、`content_type`）
2. `POST /v1/file_uploads/{id}/send` 以 `multipart/form-data` 上传 `file`
3. 生成 Notion image block：

示例结构（概念，具体字段以 Notion 参考文档为准）：
- `type: "image"`
- `image.type: "file_upload"`
- `image.file_upload.id: <file_upload_id>`
- `image.caption`: 可写入原图 URL/alt（可选）

降级：
- 若返回 `400 Content length greater than 20MB limit`：切换到 R2 或跳过。
- 若返回 `429`：交由队列重试（或对单图做有限重试）。

### 5.4 R2 托管路径（方案 B）

对每张图片：
1. 下载图片（可 stream）
2. 写入 R2：key 建议使用内容哈希或 URL 哈希，避免重复存储
3. 通过 Worker 路由提供公网访问：
   - `GET /v1/assets/{assetId}`（不需要鉴权，Notion 才能拉取）
   - 返回正确 `content-type`，并设置长期缓存（immutable）
4. 生成 Notion image block：
   - `image.type: "external"`
   - `image.external.url: https://your-worker.example.com/v1/assets/{assetId}`

安全建议：
- 可选签名 URL（但注意 Notion 可能延迟拉取；签名有效期应足够长）。
- 对 assets 路由做简单限流/缓存，避免被扫描滥用。

## 6. 代码插入点与改造策略（与现状最小冲突）

现状关键插入点：
- `src/article-parser.ts`：`convertHtmlToMarkdown` 当前移除 `<img>`（line ~325）。
- `src/notion-blocks.ts`：`markdownToNotionBlocks` 当前跳过图片语法（line ~150）。
- `src/pipeline.ts`：`syncToNotion` 使用 `buildNotionChildrenBlocks` 生成 children（同步函数）。

建议的最小改造路径：

### 6.1 P0：图片集中追加（最快落地）
- 在 `processItem`/`syncToNotion` 中，基于 `contentHtml` 提取图片列表并异步生成 image blocks。
- 将 image blocks 在 `buildNotionChildrenBlocks` 的结果后追加（例如加一个 heading “图片” + N 张 image blocks）。
- 这样不需要改变 Markdown 转换的结构（但需要新增一个 async 的 children builder）。

### 6.2 P1：按原位置插入（体验更好）
- 将 `convertHtmlToMarkdown` 的 `<img>` 替换逻辑由“删除”改为输出 Markdown 图片语法 `![](url)`。
- 将 `markdownToNotionBlocks` 扩展为 token 化解析：遇到图片 token 交给 Asset Pipeline 解析为 image block。
- `buildNotionChildrenBlocks` 演进为 async，生成的 blocks 保持原顺序。

## 7. 数据模型（可选：提升幂等与可观测性）

为避免 retry 时重复下载/重复上传，建议新增 D1 表（后续迭代实现）：

`item_assets`（建议）：
- `id`（UUID）
- `user_id`
- `item_id`
- `kind`（`image`）
- `index`（图片序号）
- `source_url`
- `sha256`（可空）
- `content_type` / `content_length`
- `backend`（`notion_upload` / `r2` / `external_passthrough`）
- `status`（`pending` / `succeeded` / `failed`）
- `result_ref`（例如 `file_upload_id` 或 `r2_key` 或 `public_url`，按 backend 决定）
- `error_code` / `error_message`
- `created_at` / `updated_at`

## 8. 配置建议

新增（建议）配置项：
- `IMAGE_PIPELINE_MODE`：`notion_upload`（默认）/ `r2` / `external_passthrough` / `skip`
- `MAX_IMAGE_COUNT`：单篇最多处理图片数（默认 20~40）
- `MAX_IMAGE_BYTES`：单图最大字节数（默认 20MB）

若启用 R2：
- `ASSETS_BUCKET`（R2 binding）
- `ASSETS_PUBLIC_BASE_URL`（可选，用于生成 external url；或直接使用当前 Worker 域名）

## 9. 日志与排障

建议新增结构化日志事件（字段包含 `trace_id/user_id/item_id/image_index/source_url`）：
- `image.extract.succeeded`（count）
- `image.download.started/succeeded/failed`
- `image.upload.notion_create/sent/succeeded/failed`
- `image.store.r2_put/succeeded/failed`
- `image.block.appended`（block_id 可选）

## 10. 测试计划

单测：
- HTML 图片提取：覆盖 `data-src`、`src`、相对 URL、无效 URL。
- 下载器：mock fetch，覆盖超时/超限/content-type 非图片。
- Notion file_upload：mock `/file_uploads` 与 `/send`，验证 multipart 组装与错误降级。

集成测试（本仓库风格：vitest + mock fetch）：
- 处理包含多图的文章，验证最终 children blocks 包含 `image` 类型，且正文不被阻塞。

## 11. 里程碑与交付物

1. P0：图片集中追加 + Notion file_upload（含降级策略）  
2. P1：按原位置插入图片（HTML/Markdown/token 化改造）  
3. P2：D1 资产缓存与幂等复用（减少重复下载/上传，提升 retry 体验）
