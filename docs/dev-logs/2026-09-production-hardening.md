# AgentEvo 生产化加固开发日志

- **开始日期**：2026-09-01
- **范围**：第一阶段上线底线（安全、租户隔离、请求上下文、上下文接入、错误韧性、CI）
- **基线提交**：`cea4e0b`
- **基线依据**：项目路线图记录 568/568 历史测试通过；本轮以当前工作树重新执行测试为准。

## 目标与非目标

### 目标

1. 防止跨用户访问会话、消息、图片、知识库和 Trace 等资源。
2. 阻断任意 MCP command/cwd/env 带来的本机进程执行风险。
3. 强化认证 secret、CORS、输入大小和请求限流边界。
4. 消除 memory tool 的模块级用户上下文竞态。
5. 让 Graph 节点实际消费 token 感知的优化上下文，同时保留兼容 fallback。
6. 统一可重试错误与 SSE 错误契约，并加入可重复执行的 CI 门禁。

### 非目标

- 本轮不引入 Redis、持久化向量数据库、任务队列、OAuth 或代码执行沙箱。
- 不改变 `/chat` endpoint、既有 SSE `type` 字段、FSM、Plan 模式和旧 AgentExecutor 入口。
- 不在日志中记录 token、API key、完整用户内容或个人数据。

## 基线发现与威胁模型

- RAG 的 vector store、长文件和图片 store 是进程内全局状态。
- Memory tool 从模块级可变变量读取用户/会话，且原 payload 可覆盖身份。
- MCP 管理 API 原先接受任意 command、args、cwd 和 env。
- JWT 有默认 secret，CORS 全开放，`/upload` 内存上传缺少独立文件大小上限。
- Trace detail、OTel import、反馈和部分评估查询需要 owner 校验。
- ContextBuilder 曾将 `optimizedContext` 写入 Graph State，但节点主要使用原始 `chatHistory`。
- 根 `.gitignore` 原先忽略整个 `docs`，因此本日志显式加入例外规则。

## 实施记录

### W0：文档与 CI 基线

- 放行 `docs/dev-logs/**`，保留其他本地 docs 忽略规则。
- backend 增加 syntax/coverage 脚本；frontend 增加 syntax/check 脚本。
- 新增 `.github/workflows/ci.yml`，执行 clean install、语法检查、测试和前端构建。

### W1：安全与租户隔离（已实现首批）

- 新增 `backend/src/security/config.js`：生产 secret/CORS/MCP 基础策略。
- 新增 `backend/src/mcp/security.js`：MCP command、args、cwd、env 引用白名单与长度校验，并在 client/API 入口复用。
- `auth.js` 增加生产 secret 强校验、issuer/audience/jti、签名恒时比较；`app.js` 使用 CORS origin allowlist。
- 普通文档上传增加 8MB 限制，分片增加 4MB 限制；hash、chunkIndex、totalChunks 进行边界校验，并按 userId 隔离临时路径。
- 图片保存/读取增加 owner 校验；RAG 内存 store 和长文件状态改为按 userId 分区。
- 新增 `requestContext.js`（AsyncLocalStorage），认证请求注入不可变 user/session/request identity；memory tool 忽略模型传入的身份字段，问题回答校验 owner；生产禁用 `/test-db`。
- Trace detail/OTel export 使用 user owner 查询；OTel import 校验 session owner，并修复 `createSession()` 返回数字的兼容性；反馈写入校验消息 owner。

### W2：上下文与韧性（已实现基础）

- `chatGraph.js` 的各类节点通过 `buildContextMessages()` 优先消费优化上下文，并以非可信上下文边界注入，避免与原始 history 双发；`CONTEXT_BUILDER_ENABLED=false` 可回退旧路径。
- 新增 `resilience.js`：统一 AppError、错误分类、Abort 感知、指数退避和错误 envelope；MCP 工具失败改为结构化错误 JSON。
- `chat.js` 与 `chatUtils.js` 的 SSE fatal/direct error 事件增加 `type=error` 和 retryable 信息；前端 SSE 解析将其转为可见工具错误。
- 增加认证限流、管理员保护（`ADMIN_USER_IDS`/`ADMIN_USERNAMES`）和统一末端 JSON 错误 envelope；评估、Agent Config、MCP 管理接口已置于管理员边界。
- 追加回归修复：兼容旧 RAG 导出调用和 `activeLargeFile` 快照；前端无 WebCrypto 的分片 hash 保持服务端格式；普通上传超限返回 413；MCP 启动传递 cwd 并区分声明式/已解析 env；MCP 禁止路径型可执行文件；大型文件段缓存加入 userId；Graph fatal SSE 保持 `type=error`，前端调用 `onError`；pending question 按用户/会话取消和回答。
- 仍待补：将 `withRetry` 全量接入所有 LLM/工具调用、SSE event seq/replay、聚合上传配额、持久化 RAG/队列/OTLP exporter 等 P1/P2 能力。

### W3.3-R1：确定性回归修复与 P0 增量（2026-09-02，部分实现，未验收）

本轮在不重置既有工作树的前提下继续收口 P0，但没有宣称 W3.2/W3.3 完成：

- 修复 MCP 创建路由中未定义 `ownedConfig/scope`、Graph 工具执行中未定义 `requestContext`，并补齐 Eval `/runs`、feedback、observability trace 查询的显式 scope。
- 增加 additive `chat_idempotency` 表及 reserve/start/complete/fail 查询 API；`/chat` 已在验证、保存消息和 SSE 建连前读取 `X-Idempotency-Key`，前端 `/chat` 禁止通用 POST 重试并支持传递 key。成功/失败终态、同 key 安全重放、store 端 key 复用和并发 HTTP 验收仍未完成。
- 增加 `toPublicError()`，Graph/旧 Agent 路径的 fatal/direct 错误和前端 malformed SSE 已开始使用稳定错误码/请求 ID/重试标志；其他 JSON/SSE 错误路径仍有 raw message，SSE 仍没有 `seq/event_id/replay`。
- 增加分片总数上限、上传 quota 的内存态 reservation、最终 hash 校验、merge 失败清理、响应去除 `mergedFilePath`，并为大文件段/RAG tenant store 增加部分内存边界；持久化配额、全生命周期释放/结算、真正无 `readFile` 的流式 RAG 输入和完整 TTL/磁盘治理仍未完成。
- `withRetry()` 仅在 direct LLM stream 入口做了基础接入，Router/Planner/Graph/Synthesizer/普通工具/RAG/MCP 尚未全量接入。

本节是开发记录，不是验收结论；上述部分实现需要在下一轮补齐测试后再决定是否勾选路线图项目。

### W3.1-S1：评估与配置 owner scope（本轮已实现）

- `users` 增加服务端生成的 `tenant_id`（当前为 personal tenant `user:<id>`）；认证 request context/`req.user` 传递该身份，客户端不能覆盖。
- 新增 `eval_runs`、`agent_config_overrides`、`mcp_server_configs`，并为评估分数、Trace、反馈、生成用例、配置版本和优化日志增加 owner/tenant 列及索引；旧数据由关系可确定地回填，无法明确归属的数据不进入 scoped 查询。
- Eval scores/trends/run list/report/compare、generated case CRUD/审核、优化闭环和配置版本查询均要求当前 scope；越权 run/case/version/log 不返回。
- Agent Config 读取优先级改为 scope override → global default → 代码默认值，缓存键包含 tenant/user/key；版本快照、回滚、标签和删除绑定当前 scope。
- EvalRunner/在线评估不再固定写入用户 1，评估 session、run、score 和异步评估显式携带 scope；MCP ToolRegistry 按 scope 隔离 user-owned wrapper，system seed 只读且不回显解析后的 env。
- CORS 增加 `PUT`，MCP 用户配置不再由请求修改 `servers.json`；新增 resource-scope 单元测试。
- 本轮不宣称完成完整组织租户、W3.2/W3.3、W4-W8；MCP 远程能力、持久化 RAG 和多实例共享状态仍是遗留风险。

### W3.3-R2：幂等、上传 reservation 与 HTTP contract 增量（2026-09-03）

- `chat_idempotency` 增加 additive `attempt_token`/lease 字段；complete/fail 通过 attempt token 和 `status='started'` 条件更新，旧回调不会覆盖当前 attempt；失败重试复用已绑定 user message，普通聊天路径统一跳过二次 user 保存。
- direct LLM 失败不再转成成功占位文本；失败会进入显式 failure 路径，避免错误 assistant 被记录为 completed/replay。
- 上传 quota 增加 chunk delta（重复/替换大小可正确结算）、rollback、settle、release、同 user/hash 操作锁和过期 reservation 清理；chunk 写入失败回滚，merge 成功按实际字节结算，失败清理临时目录并释放 reservation；普通上传也纳入 reservation 生命周期。
- merge 改为 `streamAndVerifyFile()` 增量 SHA-256/大小校验，并通过 `processAndStoreDocumentFile()` 读取文件路径；移除 handler 对 merged 文件的整文件 `readFile`。当前 RAG 仍会为既有 splitter/长文状态保留文本和内存态，不能称为完全流式或多实例就绪。
- 增加 `uploadQuota.test.js`、`db/idempotency.test.js` 和基础 `http.contract.test.js`，统一部分 upload/auth 错误 envelope，覆盖 requestId、attempt fencing、quota 生命周期和未认证 HTTP contract。

### 本轮验收补充

- 两用户资源隔离冒烟：user 1 创建的 `eval_runs`、Agent Config override/version、MCP config 对 user 2 均返回空/不可见；user 1 可正常读取自身资源。
- `git diff --check` 通过（仅报告 Windows 工作树的 LF/CRLF 转换提示）。
- 当前工作树含有本轮开始前的既有修改；本轮未覆盖或重置这些修改。

### W3.3-B + W3.2-B：HTTP、SSE 与 quota contract closure（2026-09-04，进行中）

基于上一轮 W3.3-A/W3.2-A 的审计，本轮先修正会导致真实请求错误的边界，不进入 W4 全量重试或 W5 持久化 RAG。

- 修复 `chatGraph` direct 分支的 SSE emitter TDZ/catch 作用域问题；`chat.js`、`chatGraph.js`、`chatUtils.js` 的 direct/tool/text/thought/error/done 主要路径统一使用 writer，保留旧 `type/text/tool_*` 与 `[DONE]`。
- 前端 stream parser 增加 `id` 去重、`seq` 顺序校验，并把缺少 `[DONE]` 的截断 EOF 标记为 `INCOMPLETE_SSE_STREAM`，避免把半开连接当作成功。
- durable quota 的 reservation 保存 `usage_day`；跨 UTC 日 settle/release/rollback/expiry 按 reservation 所属日期更新 usage；merge 无有效 reservation 时拒绝；chunk replacement 使用临时文件 + rename。
- 限流配置改为运行时读取 trusted proxy gate，保留未认证 IP-only、认证 tenant/user/IP 组合和 bucket 上限；关键 chat/upload 路由持续受限。

**仍未闭环**：当前 `createApp()` 是兼容包装而非完整 route registrar，durable adapter 的跨进程 lock/生产写入和真实 HTTP 双用户矩阵尚未验收；SSE metadata 全链路及所有 raw JSON error 出口仍需继续清理。未知 orphan 默认只报告，不自动删除。



本节在上一轮请求可靠性修复基础上，明确下一阶段只做可回滚的 HTTP/上传资源治理切片，不把 personal owner scope 误称为组织 tenant/RBAC。

- **身份边界**：owner/tenant 只能来自认证后的服务端 request context；请求 body、模型输出和未经显式配置的 `X-Forwarded-For` 均不可信。认证前限流只使用 socket/IP，认证后再组合 tenant/user/IP。
- **协议边界**：保留 `/chat` 请求体、SSE `type/text/tool_*`、`data: [DONE]`、前端 FSM 和旧 AgentExecutor；`SSE_METADATA_ENABLED`、`DURABLE_UPLOAD_QUOTA` 作为回滚开关。本波次不实现 Last-Event-ID、持久事件日志或 resume。
- **资源边界**：持久 upload quota 仅记录 reservation/usage，不等于持久 RAG；未知 orphan 默认只报告/quarantine，不自动删除。迁移不在请求路径自动备份或改写生产数据。
- **HTTP/生命周期目标**：建立最小 `createApp({ dependencies })` seam，统一 4xx/429/500 public error envelope，接入已存在的 SSE writer，并为 cleanup、MCP/DB 关闭提供可测试 lifecycle handle。
- **迁移顺序**：SQLite/WAL 备份 → `PRAGMA integrity_check`、schema/index 与 orphan audit → additive quota tables → 重复执行迁移 → 再次 integrity/schema/orphan 检查。旧 memory adapter 始终可通过 flag 保留。

**本波次拟交付**：`upload_quota_usage`、`upload_reservations`、`upload_reservation_chunks` 及 SQLite adapter/TTL cleanup；IP+account/tenant 限流和 bucket 淘汰；SSE metadata/terminal/error contract；native HTTP 双用户及并发测试。组织 tenant/RBAC、持久 RAG、W4 全量 retries、Redis/OTLP/Prometheus、queue/checkpoint/replay、A/B、Skills、代码沙箱、remote MCP/OAuth 和生产 Reflection 明确延期。

## 验证记录

| 时间 | 命令/验证 | 结果 |
|---|---|---|
| 2026-09-01 | `node --check`（backend 关键文件） | 通过 |
| 2026-09-01 | `backend npm test` | 18 files / 446 tests 通过 |
| 2026-09-01 | `frontend npm test` | 9 files / 155 tests 通过 |
| 2026-09-01 | `frontend npm run build` | 通过；Browserslist 与 dynamic import 为 warning |
| 2026-09-01 | `git diff --check` | 通过；存在 LF/CRLF 提示 |
| 2026-09-02 | `backend node --check`（本轮修改文件） | 通过 |
| 2026-09-02 | `backend npm test -- --reporter=dot` | 21 files / 454 tests 通过 |
| 2026-09-02 | SQLite `PRAGMA integrity_check` + 新表检查 | `ok`；`eval_runs`、`agent_config_overrides`、`mcp_server_configs` 已创建 |
| 2026-09-02 | `frontend npm test -- --reporter=dot` | 9 files / 155 tests 通过；存在既有 storage warning |
| 2026-09-02 | `frontend npm run build` | 通过；Browserslist、dynamic import 为 warning |
| 2026-09-02 | CI 文件与 dev-log | 已新增；尚未在远程 runner 执行 |
| 2026-09-02 | 本轮增量 `node --check` + `backend npm test` | 语法检查通过；21 files / 455 tests 通过（本轮修改后的结果） |
| 2026-09-02 | 前端本轮最终验证 | 尚未重新执行；此前 `check:syntax` 对 `.jsx` 的 Node 直接检查会因扩展名失败，需改用项目既有构建/测试方式验证 |
| 2026-09-02 | 本轮 HTTP/并发/上传/双用户矩阵 | 尚未执行；因此 W3.2/W3.3-R1 仍不可标记为验收完成 |
| 2026-09-03 | `node --check`（app/db/rag/chat/chatGraph/chatUtils/sse/uploadQuota） | 通过 |
| 2026-09-03 | backend `npm test -- --reporter=dot` | 25 files / 468 tests 通过 |
| 2026-09-03 | frontend `npm test -- --reporter=dot` | 9 files / 155 tests 通过；存在既有 storage warning |
| 2026-09-03 | frontend `npm run build` | 通过；Browserslist、dynamic import、plugin timing 为 warning |
| 2026-09-03 | SQLite `PRAGMA integrity_check` | `ok` |
| 2026-09-03 | `git diff --check` | 通过；存在 Windows LF/CRLF 转换提示 |
| 2026-09-03 | backend `npm run build` | 未执行；backend 无 build script |
| 2026-09-03 | HTTP/双用户真实隔离矩阵与远程 CI | 尚未完成，不能据此宣称 W3.3/W3.2 验收完成 |
| 2026-09-04 | W3.3-R3/W4 增量语法与回归 | backend `node --check` 8 个关键模块通过；backend 25 files / 469 tests 通过；frontend 9 files / 155 tests 通过；frontend Vite build 通过（既有 warning） |
| 2026-09-04 | 幂等/上传/上下文/前端契约修复 | 补齐 `getChatIdempotency` 导入；过期 lease 原子接管与 token fencing；merge/普通上传按 user/hash 加锁；chat session ALS wrapper；HTTP typed error、SSE terminal guard、UI 幂等 key；尚缺完整 HTTP 并发矩阵 |
| 2026-09-04 | CI 与文档追踪 | frontend CI 移除无效 `node --check` JSX 门禁并保留 Vite build；backend syntax gate 扩展；`docs/dev-logs/**` 已从 blanket ignore 放行；远程 CI 尚未验证 |
| 2026-09-04 | W3.3-A/W3.2-A 设计记录 | 已补充身份/代理、SSE、quota、迁移 backup/integrity/orphan audit 顺序与 rollback 约束；代码实施和 HTTP 矩阵仍进行中 |
| 2026-09-04 | W3.2-A quota/schema 增量 | 新增 upload quota 三张 additive SQLite 表、可选 `DURABLE_UPLOAD_QUOTA=true` adapter、TTL cleanup timer、只读 `backend/scripts/audit-db.mjs`；默认仍可回退 memory adapter，未执行生产数据写入验收 |
| 2026-09-04 | W3.3-A 限流/SSE/lifecycle 增量 | 关键 chat/upload 路由接入限流；429 增加 requestId/errorCode；bucket 有界清理；app SSE helper 与 replay 使用 writer；MCP close-all、DB health/close 和 server shutdown cleanup 已补齐；完整 factory/HTTP matrix/SSE 全链路接入仍未完成 |
| 2026-09-04 | W3.2-A/W3.3-A 最终本地验证 | `node --check`（app/db/server/sse/uploadQuota/uploadQuotaStore/audit）通过；backend 25 files / 469 tests 通过；frontend 9 files / 155 tests 与 Vite build 通过；只读 audit 报告 integrity_check=ok、21 tables、0 active reservations、0 orphan candidates；durable 写入 smoke 因生产数据库变更权限未执行 |
| 2026-09-04 | W3.3-A/W3.2-A 后续闭环验证 | SSE writer 已接入 chat/chatGraph 全部直接写入点并新增 3 个 writer contract tests；quota adapter 新增 memory/durable facade 与 restart-safe SQLite schema；限流加入 trusted proxy gate、认证 identity key、bucket cap，关键 chat/upload 路由已覆盖；backend 27 files / 474 tests 通过；完整 createApp 注入、HTTP 双用户矩阵和 durable 生产写入仍未验收 |
| 2026-09-04 | W3.3-B/W3.2-B correctness 修复 | 修复 Graph SSE emitter TDZ、chat/chatGraph direct/abort 成功落库风险、Graph 工具错误脱敏与失败占位文本、前端截断 EOF/sequence/id 处理；quota 增加 reservation usage_day、内存 adapter 跨日按 reservation day 记账、无 reservation merge 拒绝、chunk 临时文件 rename；后端 27 files / 476 tests 通过；完整 HTTP 矩阵、跨进程 lock 与 production DB 写入仍未验收 |
| 2026-09-04 | W3.3-B/W4 增量收口 | `eval`/MCP/memory/feedback 等新增 raw error 出口改用 public envelope；trusted proxy 增加严格 hop/IP/CIDR 解析与生产校验 gate；Graph Router/Planner/Agent/Synthesizer/MCP wrapper 接入受预算的基础 `withRetry`，工具失败结果统一为可解析的 `{ok,data,errorCode,message,retryable}`；RAG 禁止无 owner 时默认回退 user 1，chunk hash 收紧为 SHA-256；后端 syntax 与全套测试通过 |
| 2026-09-04 | 全量本地验证（本轮） | `backend npm run check:syntax` 通过；`backend npm test -- --reporter=dot`：27 files / 476 tests 通过；`frontend npm run check`：9 files / 155 tests 通过，test build 与 production build 均通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换提示）；只读 `backend/scripts/audit-db.mjs`：integrity_check=ok、21 tables、0 active reservations、destructiveActions=false；构建仅有既有 Browserslist、dynamic import、plugin timing warnings |

### W3.3-C：factory 依赖注入基础与 registrar 增量（2026-09-05，进行中）

- `createApp({ dependencies })` 增加按 Express 实例保存依赖的基础，避免 factory 实例之间通过共享临时变量互相覆盖。
- 已验证 `auth.getUserById`、`db.getSessions`、`db.createSession`、`db.getHistoryMessages` 等请求路径可以读取 factory 依赖包；新增 native HTTP factory smoke test，当前只覆盖基础注入，不代表所有路由已完成 registrar 化。
- 下一步以 core/auth/session 为第一刀，逐步提取路由；保持 legacy singleton、旧 API/SSE/FSM 和 `startServer()` listen 分离。
- 当前仍未完成：全量依赖注入、原生双用户隔离/并发矩阵、durable quota restart/lock/生产写入和迁移 runbook；组织 tenant/RBAC、持久化 RAG 与 W5-W8/P2 继续延期。

### W3.3-C：core/auth/session/auth registrar 增量（2026-09-05）

- 新增 `backend/src/routes/coreRoutes.js`，将 `/ping`、`/auth/me`、session 基础 CRUD 和 history 作为 per-factory registrar 挂载；legacy singleton 继续承载尚未迁移的 register/login 等路由。
- `createApp({ dependencies })` 使用 instance-local dependency bag；factory native HTTP smoke test 验证 fake auth/session DB 的实际调用。
- 本轮继续新增 `sessionExtensionRoutes.js`，factory 侧接管 `context-usage`、`compact`、message pair 和 branch；旧 singleton 对应实现改为 `/legacy-sessions/...` fallback 路径，避免 factory 重复匹配。新增 fake DB native HTTP contract，验证 history/pair/branch 的 owner 参数和调用链；定向测试 4 个通过。
- 本切片保持旧 API response shape、认证/ALS context、SSE/FSM、`startServer()` listen 分离不变。
- 本轮新增 `sessionExtensionRoutes.js`，factory 侧接管 `context-usage`、`compact`、message pair 和 branch；旧 singleton 对应实现改为 `/legacy-sessions/...` fallback，新增 fake DB native HTTP contract 验证 owner 参数和调用链；定向测试 4 个通过、全量后端测试 27 files / 478 tests 通过。
- 本轮进一步新增 `authRoutes.js`，factory 侧接管 `/auth/register` 与 `/auth/login`；原 singleton 实现保留为 `/legacy-auth/register`、`/legacy-auth/login` fallback。新增 fake user DB 的 native HTTP contract，验证 lookup/create/password hash/token 流程使用 factory 依赖。
- 本轮进一步新增 `authRoutes.js`，factory 侧接管 `/auth/register` 与 `/auth/login`；原 singleton 实现保留为 `/legacy-auth/register`、`/legacy-auth/login` fallback。新增 fake user DB 的 native HTTP contract，验证 lookup/create/password hash/token 流程使用 factory 依赖；全量后端测试达到 27 files / 479 tests 通过。
- 本轮新增 `feedbackRoutes.js`，factory 侧接管 `POST /chat/feedback` 的保存、同评分 toggle-off 和显式删除；singleton 实现保留为 `/legacy-chat/feedback` fallback。native HTTP contract 使用 fake DB 验证 feedback lookup/save/delete 的 owner 参数与调用链；定向测试 6 个通过。
- 当前仍未完成全量 route registrar、observability/config/MCP/memory/upload/chat/eval 等业务路由迁移、完整双用户资源/并发矩阵、durable quota restart/lock/生产写入、migration runbook 与组织 tenant/RBAC。

### W3.3-C：修复生产挂载 + 迁移 observability/config/memory registrar（2026-09-05）

- 修复生产回归：`registerAllRoutes` 之前只挂在 factory 实例上，singleton `app`（`startServer` 真实启动路径）丢失了 `/ping` 与 `/auth/*`。现在在 singleton 与 factory 上都调用 `registerAllRoutes`，native smoke test 验证 `/ping`=200 且所有 auth 路由到达处理逻辑。
- 新增 `backend/src/routes/deps.js`：`dependencyBag`（bag → app.locals → 空）、`requireDep`/`dbFn`/`svcFn` 统一错误（缺依赖时 503 `DEPENDENCY_UNAVAILABLE`）、`sendError` 统一 JSON 错误封套。`requireDep` 检查 `value === undefined || null`（而非 `typeof function`），因 services 包内多为对象实例。
- `defaultDependencies` 新增 `services` 命名空间：`{ agentConfig, metricsAggregator, TraceCollector, otelToInternalTrace, createMemoryService: (userId) => new MemoryService(userId) }`；`createApp` merge 同步合并 services。
- 新增三个 registrar：`observabilityRoutes.js`（/observability/recent、/metrics、/traces、/traces/:traceId、/traces/:traceId/otel、POST /otel/import）、`configRoutes.js`（/agent-config 全端点 + 版本管理，admin 守卫）、`memoryRoutes.js`（/memory CRUD + stats + consolidate，per-user scope）。
- 新增 `registrarIsolation.test.js`（7 个 native HTTP contract）：metrics aggregator 走调用者 scope、trace owner 隔离（user1 见 trace A / user2 404）、otel TraceCollector、otel/import 的 scope+跨 owner session 拒绝、agent-config scope 路由、memory 双用户隔离（user2 删不了 user1 的 memory）、admin 403 强制。修复测试中 `headers()` 把 object 当 userId 传入导致 `sub=NaN` → 全部 401 的问题。
- 内联 handlers 有意保留为 shadowed fallback（未删除，避免大批量删除风险），供后续波次再清理。
- 验证：新增测试 7/7 通过；全量后端测试 28 files / 487 tests 通过；`node --check` 通过新 route 文件；`git diff --check` exit=0（仅预期内 LF/CRLF 警告）。

### W3.3-F：upload/chat/MCP 路由层 bag 注入 + eval 挂载统一（2026-09-05）

- 背景：upload/chat/eval/MCP 的 handler 直接调用模块级单例 db/服务（chatWithStream、rag、toolRegistry 内部仍读真实 db），无法像 observability/config/memory 那样做到 per-factory 真隔离。本轮选定「路由层 bag 注入」深度：不动服务内部，只把 handler 访问的入口全部下沉到 dependency bag。
- `defaultDependencies.db` 补：`saveMessageMetric`、`getMessageById`、幂等函数（reserve/mark/complete/fail/get/setUserMessage ChatIdempotency）与 MCP config CRUD（list/insert/get/delete/updateStatus）5 个；`defaultDependencies.services` 补：rag（processAndStoreDocument/File、getLatestUploadedSource、getActiveLargeFile、retrieveKnowledgeEvidence）、images（saveUploadedImage、getUploadedImageDataUrl）与 `resolveUserQuestion`。
- 机制：每个 handler 顶部用与模块默认同名的 shadow destructure（`const { db: {...}, quota: {...} } = getDependencies(req)`）从请求 bag 解析；handler 不搬移、生产 singleton 解析同一模块默认 → 零行为变化，而 factory 请求经 createApp 的 `req.locals` 命中实例 bag → fake db/quota 可真正拦截路由层调用。
- 覆盖：`/upload`、`/upload/chunk`、`/upload/merge`、`/upload-image` 走 quota+services bag；`/upload/check` 无 db/service 调用未改；`/chat`（db/chat/services union）与 `/chat/answer`（resolveUserQuestion）走 bag；MCP 六 handler（servers 增删查/connect/disconnect/tools）走 db config + `mcp` bag 的 toolRegistry。
- eval 挂载统一进 `registerAllRoutes`（requireAuth + rate limit + requireAdmin），inline 保留为 shadowed fallback；evalRoutes 内部 DB 访问仍走模块单例（明确标注为残余项）。
- 新增 `registrarBagIsolation.test.js`（5 个 native HTTP contract）：chat db-count 快路径双用户越权（user2→404、不落库）/走实例 bag、两个 factory 并发各自独立 bag、`/upload` quota+rag 记录调用者 userId、`/upload-image` image store 走 bag、`/mcp/servers` 走实例 db + admin 403。
- 验证：定向 12/12（新 5 + registrarIsolation 7）通过；全量后端测试 29 files / 492 tests 通过；`node --check` 通过；`git diff --check` exit=0。

### W3.3-G：chat 深链路服务层注入 + 双用户并发矩阵（2026-09-05）

- 背景：W3.3-F 只覆盖了 `/chat` handler 层的 db 调用；`chatWithStream` 内部仍直接 import 模块单例（`saveMessage`/`getHistoryMessages`/`getAgentExecutor`/`streamDirectChat`/`TraceCollector`/`OnlineEvaluator`/`agentTools`），factory 无法把真实聊天链路打到自己的 fake store。
- `chat.js`：`chatWithStreamImpl` 顶部新增 deps 解析块 —— 每个单例改为 `deps?.db?.saveMessage || saveMessage` 形式的「实例 bag 优先、模块默认回落」。共替换 7 类调用点：用户/assistant `persistMessage`、历史 `fetchHistory`、两处 `buildExecutor`（websearch/普通）、直接流 `directStream`、`makeTrace`、`makeEval`、web_search 强制工具 `availableTools`。生产 singleton 的 bag 不含这些覆盖键 → 全部回落模块默认，零行为变化。
- `app.js` `/chat`：捕获 `const instanceDeps = getDependencies(req)`，并把 `chatImpl`（langgraph feature flag 选择的执行器）包成 wrapper，统一向所有调用点注入 `{ ...opts, deps: instanceDeps }`。四个分支（large-file/langgraph-knowledge/rag/通用）一次改齐，handler 层原 destructure 不变。
- 注入仅对 legacy `chatWithStream` 生效；LangGraph 路径（chatGraph）逐节点内联构造 ChatOpenAI，本轮明确不改。
- 新增 `registrarServiceIsolation.test.js`（3 个 native HTTP contract，走真实 HTTP + 真实 chatWithStream）：
  1. 通用对话全链路命中 bag —— fake db 落 user+assistant、fake `getHistoryMessages` 被读取、确定性 fake executor（只吐一个 `on_chat_model_stream` chunk，不构造 ChatOpenAI/不碰网络）产出 assistant 文本、fake trace/eval 工厂被调用、metric 落 fake；
  2. 越权 user2 → 404，bag 零写入；
  3. 双 factory 并发矩阵 —— app A(user1/session10) 与 app B(user2/session20) `Promise.all` 并发真实聊天，各自 saves/history/evals 只含自己的 tag，永不串库。
- 关键发现：本机环境 `USE_LANGGRAPH=true`（dotenv 注入），不走注入路径会命中真实 LangGraph 图并尝试真实 LLM；测试统一 `useLegacyChat()` 强制 `process.env.USE_LANGGRAPH="false"` 并在 afterEach 还原。
- 验证：定向 3/3 通过；全量后端测试 30 files / 495 tests 通过；`node --check` 通过 chat.js/app.js/新测试；`git diff --check` exit=0。
- 残留：chatGraph 各节点内联 ChatOpenAI 仍未注入（深链路仅覆盖 legacy chatWithStream）；agent 内部工具（`searchKnowledgeBaseTool`/`getDbMessageCountTool`）仍以模块单例 + request-context userId 解析，属用户级 scoped 而非 per-factory；evalRoutes 内部 DB 仍模块单例。

### W3.3-H：chatGraph 节点 LLM 注入缝 + 迁移 runbook（2026-09-05）

- 基线收口：全量加固 W0→W3.3-G 综合提交 `24958d7` 并推 origin/main（61 files / +6375 / −1169）；此前 `cea4e0b` 亦随附推送。backend 30/495、frontend 9/155 与双端 build 本地验证通过后提交。远程 CI 首次触发尚待人工确认（本地无 gh）。
- chatGraph makeLlm 注入：app.js:1840 的 chatImpl wrapper 早已给 langgraph 与 legacy 两路都注入 `deps: instanceDeps`，但 `chatWithGraphImpl` 从未消费 `options.deps`，且 8 个节点直接 `new ChatOpenAI(...)`。本轮：
  - 新增 `defaultMakeLlm(opts)`（`new ChatOpenAI({ ...opts, ...buildChatOpenAIConfig() })`）与 `resolveMakeLlm(config)`（取 `config.configurable.makeLlm`，缺省回落默认）；
  - 8 处构造站点（router/planner/general/search/summary/knowledge/code/synthesizer）统一改 `resolveMakeLlm(config)({ modelName, temperature, ... })`，`buildChatOpenAIConfig()` 下沉进默认工厂 → 逐站行为不变；
  - `chatWithGraphImpl` 从 `options?.deps?.services?.makeLlm || options?.deps?.makeLlm || defaultMakeLlm` 解析，并写入 graph `config.configurable.makeLlm`（与 sse/abortSignal 同缝）；生产 singleton bag 无该键 → 回落默认，零行为变化。
  - 提交 `91beca4`；新增 `chatGraphMakeLlm.test.js`（解析语义 + 默认复刻 + 源码不变量：`new ChatOpenAI(` 全库仅 1 处、8 站点全走 seam、config 已携带 makeLlm）4 个通过；backend 31 files / 499 tests。
- 迁移 runbook（B7）：新增 `backend/scripts/migrate-db.mjs`（dry-run 只读审计；`--apply` = checkpoint → 自动备份 → 复用 db `initDB()` 幂等 additive 路径 → `security_migration_audit` 记 `migrate-db:apply:<ts>` → 复检；WAL busy 拒写、无库无 `--force` 拒绝、orphan 只报告）。runbook 见 `2026-09-db-migration-runbook.md`；工具测试 `src/db/migrateDb.test.js` 4 个（隔离临时库）。
- A1 决策：evalRoutes 的 DB 单例 gap 在下游 4 模块（模块顶 import 真实 DB + optimize 模块加载即 new ChatOpenAI），路由层仅能半隔离；eval 为 admin-only + 离线，W3.1-S1 已加 owner scope + admin 门禁 → **深度注入（D2）延后**，作为已知残余记录，本轮不做 D1 半隔离切片。

### W3.3-I：远程 CI 首次验证 + 红灯修复（idempotency 测试自治）（2026-09-05）

- 远程 CI 首次验证：`24958d7` / `91beca4` / `8481c4f` 三条 commit 触发 `.github/workflows/ci.yml`。frontend job 三条全绿；backend job 三条全挂**同一测试** `src/db/idempotency.test.js`（`isolates the same key across owners`），错误 `SqliteError: FOREIGN KEY constraint failed`（code `SQLITE_CONSTRAINT_FOREIGNKEY`），run 秒级失败 —— 说明挂在测试阶段而非构建。
- 根因（本地 `DB_PATH=<空库>` 定向复现，与 CI 完全一致）：
  - 本项目 better-sqlite3 **默认 `PRAGMA foreign_keys = ON`**（最小实验确认：`:memory:` 建 users/child 后插 missing-parent 即抛 FK），且仓库代码从未显式关 FK；
  - `chat_idempotency.owner_user_id` 建表带 `FOREIGN KEY → users(id)`；
  - 原测试硬编码 scope `userId: 1 / 2`、不自建父行 → 本地绿只因 dev `agent_data.db` 里恰好有真人账号 id 1/2；
  - CI 干净库只被 `initDB()` 自举出 demo 用户（AUTOINCREMENT 恰为 **id=1**）→ 前两个用例命中 demo 通过，跨 owner 用例的 `userId:2` 无父行 → FK 崩。
  - 结论：测试不自治（依赖共享库历史残留），本地全量绿也无法暴露 —— 远程 CI 首战即抓到真实测试卫生缺陷。
- 修复（`8d8c0f3`）：`idempotency.test.js` 改为自治 —— `beforeAll` 动态插入两个专属用户（真实 AUTOINCREMENT id + 唯一 username），`afterAll` 按 FK 顺序**先删 `chat_idempotency` 子行再删父用户**，不碰 demo 与其数据；根因写入文件头注释防复发。验证：`DB_PATH=<空库>` 全量 **32 files / 503 tests 绿**（最接近 CI 形态），dev 库 32/503 亦绿。
- 远程复跑：`8d8c0f3` → backend + frontend 双 job **success**，CI 自此可作回归防线。
- 遗留债务（系统性，见 roadmap §16 候选）：所有 db 单测共享同一真实形态 DB 文件，靠 FK ON + 恰好存在的父行续命，`idempotency` 只是首个撞枪者；根治 = 每 vitest worker/fork 独立临时库（setup 为每个 worker 设独立 `DB_PATH`），已列 roadmap 后续波次候选。

### W3.3-J：db 测试逐 worker 隔离（W3.3-I 事故的系统性根治）（2026-09-05）

- 动机：W3.3-I 只修了 `idempotency` 单个测试；根本问题是**整套测试共享真实 dev 库** `backend/agent_data.db`（`db/index.js` 模块导入时读一次 `process.env.DB_PATH`，无人设置它），任何新表/新 FK 都可能重现"本地绿、CI 红"。另审计发现 `memory.test.js` × `memory.tool.test.js` 共享 `USER_ID=1`，在共享库上并行互删对方行，属潜在 flaky。
- 改动（生产代码零改动；新增 1 文件 + 1 行配置）：
  - 新增 `backend/vitest.setup.js`：vitest 默认 `pool=forks + isolate=true`（每测试文件一个独立子进程），setup 在每个 worker 内、文件模块导入前执行 → `mkdtempSync` 一个独立临时空库并设 `process.env.DB_PATH`；不 import db（避免破坏对其 `vi.mock` 的 collector/metrics/chatGraph/generator 测试）；`exit` 尽力删除 + 对命名空间 `agentevo-vitest/` 下 >1h 旧目录做 sweep（Windows 无法删打开中的 SQLite，残目录由下次 sweep 收敛）。
  - `vitest.config.js` 加 `setupFiles: ['./vitest.setup.js']`；`check:syntax` 纳入 `vitest.setup.js`。
  - 零测试文件改动：审计 32 文件，唯一真实写库的 3 个测试（idempotency/memory/memory.tool）均自带 `initDB()`，空库上成立（demo 用户空库自举 id=1，memory 的 `USER_ID=1` 仍有效）。
- 验证：
  1. 全量 `npm test` 32 files / 503 tests 绿；
  2. **dev 库不再被碰**：跑前/跑后 `agent_data.db`/`-wal`/`-shm` 的 sha256 + mtime + size 逐字节一致（改造前 memory 测试会写 dev 库，此检查改造前必红）；
  3. `memory.test.js` + `memory.tool.test.js` 连跑 5× 全绿（旧共享库会互删 user1 行）；
  4. 运行中 `os.tmpdir()/agentevo-vitest/<rand>/agent_data.db` 确认存在（Windows 下 exit 删除失败 → 32 个残目录由下次 >1h sweep 收敛，已手工清理一次）；
  5. 远程 CI 双 job success。
- 收益：任何测试**结构性不可能**依赖 dev 库残留；每次 `npm test` 等价于在干净 CI 形态下运行；roadmap DoD 的 "temporary SQLite" 从特例成为强制约定。

## 回滚与遗留风险

- 所有新增行为使用环境变量或兼容 fallback；必要时可关闭新开关并保留旧数据。
- 在 P1 完成前，RAG 仍不适合多实例部署；MCP 仍只支持 Stdio。
- 在身份迁移完成前，旧数据库中的 NULL/默认用户数据需要人工审计。
- 本日志后续按实现批次补充具体文件、测试输出、手工隔离矩阵和未解决风险。
- 后续完整任务清单与明日恢复入口见 [2026-09-production-hardening-roadmap.md](2026-09-production-hardening-roadmap.md)。
