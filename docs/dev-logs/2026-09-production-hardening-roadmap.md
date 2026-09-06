# AgentEvo 生产化加固后续开发路线

> 本文是下一次开发的恢复入口。继续开发前先阅读本文和 `2026-09-production-hardening.md`，不要跳过验收条件直接扩展功能。
>
> 记录日期：2026-09-01
> 当前状态：P0 加固 + W3.x 隔离/registrar 矩阵 + W4-R1…R5 重试/SSE 收口已全量落地；最新一波 W4-R5（三文档未完成项对账 + durable 同 key 跨进程锁 + W3.2 残余）见 §24，残余总账以 §24 为准。W5-W8、组织 RBAC、P2 岗位项仍未开始。

## 1. 当前基线

### 已完成并验证

- Backend：20 个测试文件，451 个测试通过。
- Frontend：9 个测试文件，155 个测试通过。
- Frontend production build 通过。
- 关键后端文件 `node --check` 通过。
- 已有 CI：`.github/workflows/ci.yml`，但尚未在远程 runner 验证。
- 已有开发日志：`2026-09-production-hardening.md`。

### 当前实现边界

- RAG、长文件和部分图片数据仍是单进程内存态，尚不适合多实例生产部署。
- MCP 当前主要是 Stdio transport；虽然 command/args/cwd/env 有基础 allowlist，但仍需更完整的租户策略、审计和子进程生命周期治理。
- `withRetry()` 已提供基础实现，但尚未全量接入 LLM、普通工具和 MCP 调用。
- ContextBuilder 已接入 Graph 节点，但仍需 golden test 证明每个节点真实消费优化上下文，并检查不可信内容边界。
- 评估/配置查询仍存在全局表和全局聚合接口，管理员保护不等于完整 tenant scope。
- 尚无真正的 A/B 分桶、Redis、持久化 RAG、任务队列、durable checkpoint、OTLP exporter 和告警平台。
- 产品内 Skills Runtime、代码执行沙箱、MCP OAuth/远程 Transport 和聊天主链路 Reflection 尚未落地。

## 2. 下一次开发优先顺序

### W3：P0 安全闭环（下一次优先）

#### W3.1 评估、配置和 MCP 资源权限

> W3.1-S1（2026-09-02）已完成 personal owner scope 闭环：评估 run/score/report、generated cases、配置 override/version、optimization log 和 user-owned MCP wrapper 已按服务端 user/tenant 隔离。2026-09-02 的 W3.3-R1 又修复了若干 scope 调用回归，但完整 W3.1/W3.2/W3.3 仍未完成；以下清单按真实验收状态保留未完成项，尤其是组织 tenant/RBAC、迁移审计自动化和全面 HTTP 隔离矩阵。

- [x] W3.1-S1：users tenant_id、eval_runs、scoped config/MCP 表和关键查询已增量落地。
- [ ] 为 `eval_traces`、`eval_scores`、`eval_feedback`、generated cases、optimization log 增加 owner/tenant policy。
- [x] 个人 owner scope：`getScoresByRun`、趋势、run 列表和 report 查询增加 user/tenant 条件；禁止通过 runId 枚举其他用户数据（组织级 tenant/RBAC 与完整 HTTP 矩阵仍未完成）。
- [x] 个人 owner scope：Agent Config 使用 scope override → global default → 代码默认值，配置版本、回滚和优化日志同步归属；组织 tenant/RBAC 仍未完成。
- [ ] `/eval` 运行、生成、编辑、审核、删除、compare、optimize 全部增加配额和授权边界；昂贵 LLM 操作只允许 admin 或明确租户角色。
- [x] 个人 owner scope：MCP Server 配置按 user/tenant 管理，普通用户不能查看或改变其他用户配置；内置 Server 与 user-owned 外部 Server 已分离。组织 RBAC、生命周期治理和远程能力仍未完成。
- [x] 个人 owner scope：OTel import 校验目标 session owner，trace detail/export、feedback message、config version/log ID 做 owner 检查；组织级 scope 和完整 HTTP 矩阵仍未完成。

#### W3.2 上传总量与资源治理

- [ ] 增加单用户并发上传数、单文件总大小、每日/累计磁盘配额。
- [x] 合并时禁止无限 `readFile`；采用流式大小校验，失败时清理临时目录（RAG 兼容入口仍可能保留文本内存态）。
- [x] hash、user namespace、旧版本未完成上传兼容迁移策略已覆盖基础校验/用户目录和单测；迁移 runbook + 工具已交付（见 §15），ledger 复用 `security_migration_audit`；durable quota **restart 持久化 / 跨进程记账 / 生产写入 smoke** 已在 A1+A2 验收（见 §18）。**同 key 跨进程锁已由 W4-R5-S1 SQLite 租约表闭合（`upload_key_locks`，见 §24），不再需要外部锁服务。**
- [x] 已增加进程内 RAG tenant store 数量上限与大文件 segment cache 的数量/TTL 淘汰；重启丢失告警与字节级磁盘治理报告已在 W4-R5 T5 补齐（startServer 启动告警 + audit-db `quotaGovernance`/`diskStaging`）。多实例共享 RAG 仍未完成（W5/W6）。
- [~] `/upload`、`/upload/chunk`、`/upload/merge` 已统一主要错误 code/status 并隐藏内部路径；全量 HTTP contract 矩阵仍待完成。

#### W3.3 限流、统一错误和应用测试

- [ ] 限流不信任未验证的 `X-Forwarded-For`；增加 IP + 账号维度，配置可信代理链。
- [~] 提供兼容 `createApp({ dependencies })` 入口并保持 listen 分离；当前只暴露依赖 seam，路由尚未全部切换为注入实现，临时 DB/fake LLM/fake MCP 矩阵仍待完成。
- [ ] 添加全局 error middleware 的 JSON contract；SSE 错误包括 `type`、`requestId`、`errorCode`、`retryable`，且不泄露 provider 原始错误/secret。
- [~] `/chat` 已增加 `X-Idempotency-Key`、attempt token fencing、失败/成功终态和完整响应 replay；SSE 开始后不重放副作用，但全量并发 HTTP 验收仍待完成。
- [~] 已新增基础 HTTP error contract；完整两用户交叉访问矩阵（session/message/memory/RAG/chunk/image/trace/feedback/eval/config/MCP/OTel）仍待完成。

### W4：统一重试和 SSE 可靠性

- [ ] 将 `withRetry()` 接入 Router、Planner、Agent 节点、Synthesizer、RAG embedding/search、MCP call；仅对 timeout/429/5xx/明确网络错误重试。
- [ ] 所有重试带 AbortSignal、预算、指数退避+jitter；4xx、鉴权失败、校验错误不可重试。
- [ ] 工具结果统一为 `{ ok, data, errorCode, message, retryable }`，Synthesizer 只接收成功数据或明确 blocked/error 结果。
- [ ] SSE 事件增加可选 `event_id/seq/request_id`，保留现有 `type/text/tool_*` 字段；前端 malformed event 进入可见错误，不静默丢失。
- [~] 已明确本轮仅支持完成响应的幂等 replay；未接入持久事件日志、Last-Event-ID 或断点恢复，长任务 replay/resume 延后 W7。
- [ ] 测试：半开连接、客户端 Abort、上游超时、429、重复建连、工具失败、重试耗尽和 B 用户不受 A 取消影响。

### W5：持久化 RAG

- [ ] 新增 `knowledge_documents` 与 `knowledge_chunks` 元数据：user/tenant、文件 hash、原名、安全名、大小、状态、版本、created/updated。
- [ ] 抽象 `VectorStoreAdapter`：开发环境可用内存 adapter，生产使用按 tenant 持久化 FAISS 或外部向量服务。
- [ ] 启动恢复、上传幂等、删除、重建、版本切换和失败状态可观测。
- [ ] 先双写/双读比对，再通过 `DURABLE_RAG_READ` canary 切换；保留旧内存 fallback 和离线 rebuild 脚本。
- [ ] 检索强制 owner/tenant filter；补引用、groundedness、命中率、no-match 指标。

### W6：共享运行时和线上观测

- [ ] Cache interface：本地 Map adapter + Redis adapter；key 必须含 tenant、工具版本、查询 freshness；TTL、负缓存、防击穿和失效策略。
- [ ] Trace exporter：`trace/exporter.js` 从格式转换升级为异步 exporter/outbox，支持 OTLP HTTP、batch、retry、超时和脱敏，不阻塞 SSE。
- [ ] 增加 Prometheus-compatible metrics：吞吐、并发、P50/P90/P99、错误率、重试耗尽、token、成本、RAG miss、队列延迟、export backlog。
- [ ] 健康检查拆分 liveness/readiness；增加告警阈值、抑制、通知和 runbook；不能只依赖 `/ping`。

### W7：长任务与可靠恢复

- [ ] Queue abstraction：先 inline adapter 保持旧 `/eval/run` 行为，再接 Redis/BullMQ worker；新接口返回 jobId，支持 `wait=true` 兼容等待。
- [ ] Durable checkpoint 表按 tenant/user/session/run 保存可序列化 Graph state；不保存 SSE emitter、AbortController、LLM 实例。
- [ ] 稳定 thread/run ID、Graph 版本、取消、过期、幂等和失败重试；工具副作用必须有 idempotency key。
- [ ] 事件日志 + replay/resume endpoint；前端恢复后不重复渲染或重复执行工具。
- [ ] 验证：worker 重启恢复、重复投递、checkpoint 版本不兼容、用户取消、租户隔离和恢复成功率。

### W8：A/B 实验

- [ ] 新增 experiment、assignment、exposure、outcome 或 append-only event 数据模型。
- [ ] 基于 tenant/user/session 稳定 hash 分桶，不允许请求 body 指定实验组。
- [ ] 将 `USE_LANGGRAPH` 包装为可审计实验开关，记录 config version、traceId、组别和曝光。
- [ ] 指标按实验组聚合：完成率、延迟、token/cost、工具错误、用户反馈、评估分数；提供最小样本和显著性提示。
- [ ] 退化阈值触发告警/停止实验/回滚，不自动修改生产配置。

## 3. 岗位相关的 P2（暂不优先）

### 产品 Skills Runtime

- [ ] 独立于 `.claude/skills` 开发辅助目录；定义 manifest、版本、输入输出 schema、权限、注册、加载、审计和生命周期。
- [ ] Skill 只提供流程/规则/知识，Tool 提供执行能力；二者通过显式权限策略组合。

### 代码执行沙箱

- [ ] 独立 worker/container；网络、文件、系统调用 allowlist；CPU/内存/时间/输出限制。
- [ ] 人工确认、结果校验、审计、kill 和回滚；在完成前 `codeAgentNode` 只能表述为代码生成。

### MCP 远程能力

- [ ] Streamable HTTP/远程 Transport、OAuth/token vault、Server trust、SSRF 防护、租户权限和健康检查。
- [ ] 不把 secret 写入日志、Trace、配置回显或 prompt。

### 生产 Reflection

- [ ] Critic → Refiner → bounded retry → evaluator，限定成本/轮数。
- [ ] 评估结果只能生成建议或进入审批，不允许模型自动修改生产配置。

## 4. 每个波次的 Definition of Done

- [ ] 先写设计/威胁模型和非目标，再写代码。
- [ ] 数据库只做 additive migration；变更前完成 SQLite/WAL 备份、完整性检查和 orphan audit。
- [ ] 新路径有 feature flag、metrics/canary 和明确 rollback；旧 API/SSE/FSM 保持兼容。
- [ ] 有单元测试、HTTP contract 测试、两用户隔离测试和并发测试。
- [ ] 失败不泄露 secret、token、PII、完整用户内容或内部路径。
- [ ] 记录实际命令、测试数量、失败输出、手工验证和剩余风险。
- [ ] 更新 `docs/dev-logs/`，不要只更新路线图；开发日志不能写入密钥和用户数据。

## 5. 明天继续开发的入口

1. 阅读本文件和 `2026-09-production-hardening.md`，以主日志最新验证记录为准。
2. 执行 `git status --short`，确认当前修改不被覆盖；本轮所有代码仍为未提交工作树变更。
3. durable quota 生产写入验收 + migrate `--apply` 真实落地（**A1+A2**，§18）、完整 HTTP 双用户/并发隔离矩阵（**A3**，§19，真实 DB 版）、**W4-R1 统一重试接入**（§20，分类修复 + graph 工具/流裸点接线 + toolExecutor bug）与 **W4-R2 graph 可靠性矩阵**（§21，fake makeLlm 驱动真实节点 + HTTP 半开 abort，纯测试零生产改动）均已完成。下一候选（按价值×耦合度）：**W4-SSE 错误字段审计**（独立小波，工作量小），LangChain `maxRetries:0` 与 withRetry 预算协调，rag/eval/mcp/bocha 余下接线，真实工具侧 flaky 集成缝，或 durable **同 key 跨进程锁**（需分布式锁服务）；软点→404 涉及 FE 兼容评估，优先级低。
4. 为 durable quota 做 additive migration 前，先备份 SQLite/WAL、执行 integrity/orphan audit；默认只报告未知 orphan，不自动删除。
5. 补 native HTTP contract、双用户隔离和并发测试，再运行 backend/frontend 完整测试与 build；不能用 unit test 代替矩阵验收。
6. 当前 personal `tenant_id=user:<id>` 不代表组织 tenant/RBAC；不要先做 Skills Runtime、代码沙箱或 remote MCP。
7. 每完成一个小波次，先跑隔离/并发/回归测试，再同步更新本文件和主开发日志；远程 CI 已是回归防线（§16）；db 测试已逐文件隔离（§17）——本地 `npm test` 即干净形态，dev `agent_data.db` 不会被测试触碰。

## 6. W3.3-B + W3.2-B（2026-09-04，进行中）

本轮优先关闭上一轮审计发现的 correctness blocker：Graph SSE writer TDZ、direct stream raw write、durable quota 跨 UTC 日统计漂移、丢失 reservation 绕过配额、chunk replacement 非原子，以及截断 SSE 被前端当作成功。W3.3-A/W3.2-A 的初版记录保留在下方。

- [x] Graph/chat 的 SSE writer 作用域与主要 direct/tool/text/error/done 写入路径已统一，新增 sequence/terminal contract tests。
- [x] durable quota reservation 增加 `usage_day`，settle/release/rollback/expiry 按 reservation 所属日期更新；merge 无 reservation 时拒绝继续。
- [x] chunk replacement 使用临时文件 + rename，失败时回滚 reservation 并清理不完整文件。
- [x] 前端 SSE 校验 event id/sequence，截断 EOF 进入错误而非 `onDone`。
- [x] Graph direct/abort、工具错误脱敏、失败不再伪造成功文本；内存 quota 跨 UTC 日按 reservation day 结算；RAG 无 owner 不再默认 user 1；chunk hash 收紧为真实 SHA-256。
- [x] `eval`/MCP/memory/feedback 主要 raw error 出口统一为 public envelope；Graph 节点、MCP wrapper 接入基础 bounded retry 与结构化失败结果。
- [~] `createApp` 已可包装兼容 singleton 并挂载 dependencies metadata，但业务 registrar 仍未完全改为依赖注入；完整 HTTP 双用户矩阵待完成。
- [~] trusted proxy 已增加严格 hop/IP/CIDR 解析与生产校验 gate，但完整真实代理链部署验证仍待完成。

### W3.3-B/W3.2-B 验收门槛

- touched backend syntax、backend/frontend tests/build、`git diff --check` 全部通过；
- fake response SSE 测试覆盖 TDZ、metadata 单调、error/done/close/truncated EOF；
- temporary SQLite 测试覆盖跨日、restart、duplicate/replacement、lost reservation 和 actual-byte settle；
- native HTTP 双用户/并发矩阵、durable SQLite restart/cross-process lock、生产写入 smoke 通过后才能勾选完整 W3.3/W3.2；本轮仍不宣称组织 RBAC、多实例 RAG 或全量 W4-W8。

## 7. W3.3-C：factory registrar 增量（2026-09-05，进行中）

- [x] `createApp({ dependencies })` 的 instance-local dependency bag 基础与 auth/session 读取、创建路径 smoke 验证。
- [x] core/auth/session 基础 CRUD、history 及 context-usage/compact/pair/branch 已增量 registrar 化，并让 factory 路径的 DB operation 使用当前依赖。
- [ ] 双 factory 实例 native HTTP 隔离与并发 contract 通过。
- [ ] 仍不宣称全量 factory、完整 W3.3、durable quota 验收或组织 tenant/RBAC。

本轮已继续提取 `context-usage`、`compact`、message pair 和 branch；不修改 chat、upload、eval、MCP、memory、SSE 协议、数据库迁移或 startServer 生命周期。定向 HTTP contract 已通过；全量回归待本轮结束执行。

## 8. W3.3-C：core/auth/session registrar 第一刀（2026-09-05）

- [x] 新增 `backend/src/routes/coreRoutes.js`，per-factory 挂载 `/ping`、`/auth/me`、session 基础 CRUD 与 history；未迁移路由保留 legacy fallback。
- [x] factory dependency bag 按 Express 实例隔离，native HTTP smoke test 验证 fake auth/session DB 依赖实际被调用。
- [x] session 扩展 `context-usage`、`compact`、message pair、branch 已增量迁移到 factory registrar；对应 legacy 路径保留为 `/legacy-sessions/...` fallback，定向 contract 与全量后端回归通过。
- [x] auth register/login 已迁移到 factory `authRoutes.js`，legacy 路径保留为 `/legacy-auth/...` fallback；native HTTP contract 验证 factory DB lookup/create 与 token 流程；全量后端测试 27 files / 479 tests 通过。
- [x] auth register/login 已迁移到 factory `authRoutes.js`，legacy 路径保留为 `/legacy-auth/...` fallback；native HTTP contract 验证 factory DB lookup/create 与 token 流程；全量后端测试 27 files / 479 tests 通过。
- [ ] 继续迁移 feedback、observability、config、MCP、memory、upload、chat、eval 业务路由；在全量 registrar 前不勾选 W3.3 factory 完成。
- [ ] 双用户隔离/并发矩阵、durable quota restart/lock/生产写入、migration ledger/runbook 仍未完成。

## 10. W3.3-D：feedback registrar（2026-09-05）

- [x] feedback 已迁移到 factory `feedbackRoutes.js`，legacy 路径保留为 `/legacy-chat/feedback` fallback；native HTTP contract 覆盖 save/toggle-off/delete，定向测试 6 个通过。
- [ ] observability/config/MCP/memory/upload/chat/eval 仍待逐组 registrar 化；双用户隔离/并发矩阵与 durable quota 验收仍未完成。

## 11. W3.3-A + W3.2-A（2026-09-04，历史设计记录）

### 范围与威胁模型

- 请求 body、模型输出和未经显式配置的 `X-Forwarded-For` 不得提供 owner/tenant 身份；认证后 scope 只来自服务端 request context。
- 保持 `/chat` body、SSE `type/text/tool_*`、`[DONE]`、前端 FSM 和旧 AgentExecutor 兼容；`SSE_METADATA_ENABLED` 与 `DURABLE_UPLOAD_QUOTA` 提供 rollback。
- 持久 upload quota 只解决 reservation/usage accounting，不等于持久 RAG；W5 仍未开始。
- 迁移前必须 SQLite/WAL backup、`PRAGMA integrity_check`、schema/index 检查和 orphan report；默认 report/quarantine，不破坏性清理未知目录。

### Planned deliverables

- `createApp({ dependencies })` 兼容 factory 的最小 HTTP seam，`startServer/listen` 生命周期保持向后兼容。
- [x] IP-only（未认证）与 tenant/user/IP（认证后）限流、基础 bucket eviction 和标准 429 envelope（W3.3-A 初版；trusted proxy hop/allowlist 仍待完成）。
- [~] 复用现有 `services/sse.js` writer，app helper/replay 已接入基础 metadata/terminal contract；chat/Graph 全链路及错误回归测试仍待完成；本波次不实现 Last-Event-ID、event log 或 resume。
- [x] `upload_quota_usage`、`upload_reservations`、`upload_reservation_chunks` additive tables；memory adapter fallback、SQLite adapter、TTL cleanup hook 和只读 audit（W3.2-A 初版；仍需完整 restart/HTTP/multi-instance 验收）。

### Acceptance gates

- backend/frontend tests and build, touched-module syntax checks and `git diff --check` pass。
- SQLite backup/integrity/schema/orphan checks run before and after an idempotent migration。
- HTTP contract covers request ID, 4xx/429/500 envelope, two-user scope and same-user concurrency for chat/upload/SSE; quota tests cover restart, duplicate/replacement, expiry and actual-byte settle。
- No acceptance claim for organization RBAC, persistent RAG, all-route W4 retries, Redis/OTLP/Prometheus, queue/checkpoint/replay or P2.

## 12. W3.3-E：修复生产挂载 + observability/config/memory registrar（2026-09-05）

- [x] 修复生产回归：`registerAllRoutes` 现同时挂在 singleton `app`（`startServer` 路径）与 factory 实例上，恢复 `/ping`、`/auth/*` 与已迁移路由。
- [x] 新增 `backend/src/routes/deps.js`（dependencyBag/requireDep/dbFn/svcFn/sendError，缺依赖返回 503 envelope）；`defaultDependencies` 增加 `services` 命名空间（agentConfig/metricsAggregator/TraceCollector/otelToInternalTrace/createMemoryService）。
- [x] observability、agent-config（admin 守卫）、memory 三组已 registrar 化并双端（singleton+factory）挂载；新增 `registrarIsolation.test.js` native HTTP contract（metrics scope、trace owner 隔离、otel/import 跨 owner 拒绝、agent-config scope、memory 双用户隔离、admin 403）7 个全部通过。
- [x] 回归：全量后端测试 28 files / 487 tests 通过；新 route 文件 `node --check` 通过；`git diff --check` exit=0（仅预期 LF/CRLF 警告）。
- [x] upload/chat/MCP 已做路由层 bag 注入、eval 挂载统一，见 §13（handler 内 shadow 注入，非结构性搬移，故 inline handlers 保留）。
- [ ] 完整双用户隔离/并发矩阵、durable quota restart/lock/生产写入、migration ledger/runbook 仍未完成；组织 RBAC、持久 RAG、W4-W8/P2 继续延期。

## 13. W3.3-F：upload/chat/MCP 路由层 bag 注入 + eval 挂载统一（2026-09-05）

- [x] `defaultDependencies.db` 补 saveMessageMetric/getMessageById/幂等×6/MCP config×5；`services` 补 rag×4/images×2/resolveUserQuestion。
- [x] upload（/upload、/chunk、/merge、/upload-image）handler 顶部同名 shadow destructure 走 `getDependencies(req)` 解析 quota/services；`/upload/check` 无 db/service 调用未改。
- [x] `/chat`（db/chat/services union）与 `/chat/answer`（resolveUserQuestion）经 bag 解析；生产 singleton 解析同一模块默认 → 行为不变。
- [x] MCP 六 handler 经 bag 解析 db config CRUD + `mcp` bag 的 toolRegistry。
- [x] eval 挂载统一进 `registerAllRoutes`（requireAuth+rate limit+requireAdmin），inline 保留为 shadowed fallback。
- [x] 新增 `registrarBagIsolation.test.js`（5 个 contract）：chat db-count 双用户越权/走 bag、双 factory 并发各自 bag、upload quota+rag 记录 userId、upload-image store、mcp scope+admin 403。
- [x] 回归：定向 12/12、全量后端测试 29 files / 492 tests 通过；syntax OK；`git diff --check` exit=0。
- [ ] 下一刀（残余）：evalRoutes 内部 DB 仍模块单例；chat/upload 服务层（chatWithStream/rag 内部 db）注入后才能真正全栈双库；结构性 registrar 搬移与移除 shadowed inline handlers 仍未做。
- [ ] 完整双用户/并发矩阵、durable quota restart/lock/生产写入、migration ledger/runbook 仍未完成；组织 RBAC、持久 RAG、W4-W8/P2 继续延期。

## 14. W3.3-G：chat 深链路服务层注入 + 双 factory 并发矩阵（2026-09-05）

- [x] `chat.js` `chatWithStreamImpl` 顶部新增 deps 解析块：`persistMessage/fetchHistory/buildExecutor/directStream/makeTrace/makeEval/availableTools` 七个单例读取全部「实例 bag 优先、模块默认回落」。生产 singleton bag 无覆盖键 → 零行为变化。
- [x] `app.js` `/chat` 捕获 `instanceDeps`，`chatImpl` wrapper 统一注入 `{ ...opts, deps: instanceDeps }`，四个分支一次改齐。
- [x] 新增 `registrarServiceIsolation.test.js`（3 个 contract）：真实 HTTP + 真实 chatWithStream 全链路命中 fake db/executor/trace/eval；越权 user2→404 零写入；双 factory 并发（A:user1/s10 vs B:user2/s20）各自 tag 零串库。
- [x] 注入只覆盖 legacy `chatWithStream`；测试统一 `USE_LANGGRAPH=false`（本机 dotenv 默认开图），afterEach 还原。
- [x] 回归：定向 3/3；全量后端测试 30 files / 495 tests 通过；syntax OK；`git diff --check` exit=0。
- [ ] 残余：chatGraph 各节点内联 ChatOpenAI 未注入（深链路仅 legacy）；agent 内部工具（search_knowledge_base/get_db_message_count）为 request-context userId scoped 而非 per-factory；evalRoutes 内部 DB 仍模块单例；结构性搬移 + 移除 shadowed inline handlers 未做。
- [ ] durable quota restart/lock/生产写入 仍未验收；组织 RBAC、持久 RAG、W4-W8/P2 继续延期。

## 15. W3.3-H：chatGraph makeLlm 注入 + W3.2-B 迁移 runbook（2026-09-05）

- [x] 基线提交并推远程：全部加固 W0→W3.3-G 作为单 commit `24958d7`（61 files / +6375）已推 origin/main，远程 CI 首次触发待验证（本地无 gh，需人工或装 gh 确认 Actions run）。
- [x] A2：chatGraph 8 个节点内联 ChatOpenAI 统一改为经 `config.configurable.makeLlm` 构造；`chatWithGraphImpl` 从 `options.deps` 解析 makeLlm（app.js:1840 早已给 langgraph 路径注入 deps，此前 impl 未消费）；默认回落 `defaultMakeLlm`（真实 ChatOpenAI + buildChatOpenAIConfig），生产零行为变化。提交 `91beca4`。离线 seam 单测（解析语义 + 默认复刻 + 源码不变量：仅 defaultMakeLlm 内 new ChatOpenAI）4 个；backend 31 files / 499 tests 全绿。
- [x] B7：新增 `backend/scripts/migrate-db.mjs`（默认只读审计 dry-run；`--apply` = WAL checkpoint → 自动备份 → 复用 db `initDB()` 幂等 additive 迁移 → `security_migration_audit` 记 `migrate-db:apply:<ts>` → 只读复检）；WAL busy 拒绝、无库无 --force 拒绝、orphan 只报告。runbook 文档 `docs/dev-logs/2026-09-db-migration-runbook.md`。工具测试 `backend/src/db/migrateDb.test.js` 4 个（隔离临时库）。audit-db.mjs 保留。
- [~] A1：侦察确认 evalRoutes 真正的"DB 单例"gap 在下游 metrics/runner/generator/optimize 模块顶 import 真实 DB（+ optimize 模块加载即 new ChatOpenAI），路由层 bag 只能半隔离（6 个纯 db 端点）；eval 为 admin-only + 离线工具，W3.1-S1 已加 owner scope + admin 门禁。**决策：延后 eval 深度注入（D2）**，不勾选"evalRoutes 内部 DB 已隔离"，作为已知残余保留；其唯一价值是 fake-db 测试可达性，ROI 低。
- [ ] 残余未变：durable quota restart/cross-process lock/生产写入验收、完整 HTTP 双用户/并发矩阵（eval 维度待 deep injection 后补）、组织 RBAC、W4 全量 retries、W5-W8/P2。远程 CI 已验证：24958d7/91beca4/8481c4f 三条 frontend 全绿、backend 全挂同一 `idempotency.test.js`（干净库缺 users 父行 + FK 默认 ON），修复 `8d8c0f3` 后 backend+frontend 双 job success（详见 §16）。

## 16. W3.3-I：远程 CI 首次验证 + 红灯修复（2026-09-05）

- [x] 远程 CI 首验：三条已推 commit（24958d7/91beca4/8481c4f）frontend job 全绿、backend job 全红于同一 `src/db/idempotency.test.js`（`SQLITE_CONSTRAINT_FOREIGNKEY`，run 秒级失败，非构建问题）。
- [x] 根因闭环：本仓库 better-sqlite3 默认 `PRAGMA foreign_keys=ON`；`chat_idempotency.owner_user_id`→`users(id)`；测试硬编码 scope userId 1/2 且不自建父行 → 本地绿仅因 dev 库恰有 id 1/2，CI 干净库仅 initDB 自举的 demo(id=1) → 跨 owner 用例 userId:2 FK 崩。本地空库定向复现与 CI 一致。
- [x] 修复 `8d8c0f3`：`idempotency.test.js` 自治化 —— beforeAll 动态建两专属用户、afterAll 先删 idempotency 子行再删父行；`DB_PATH=<空库>` 全量 32 files / 503 tests 绿 + dev 库 32/503 绿；远程 backend+frontend 双 job success。事故/修复/债务完整记录见主日志 `2026-09-production-hardening.md` W3.3-I。
- [x] **db 单测 per-worker/per-file 临时库隔离 —— 已在 W3.3-J 落地（见 §17）**：vitest.setup.js 为每个 fork/worker 设独立临时空库，任何测试结构性不可能依赖 dev 库残留；DoD §4 的 "temporary SQLite" 由特例晋升为 db 测试强制约定。原"并入 W4 测试矩阵波"的捆绑建议不再需要 —— W4 现在可直接建立在已隔离的库上。

## 17. W3.3-J：db 测试逐 worker 隔离（2026-09-05）

- [x] 动机：W3.3-I 只修单个测试；根本问题是整套测试共享 dev 库（db/index.js 导入时读一次 DB_PATH），且 memory×memory.tool 在共享库上互删 user1 行。
- [x] 实现：新增 `backend/vitest.setup.js`（pool=forks+isolate 下每文件一进程；setupFiles 于文件导入前设 DB_PATH 到独立临时空库；不 import db 以免破坏 vi.mock；exit 尽力删除 + >1h 陈旧 sweep）；`vitest.config.js` 加 `setupFiles`；`check:syntax` 纳入 setup 文件。**零测试文件、零生产代码改动**。
- [x] 验证：全量 32 files / 503 tests 绿；dev `agent_data.db` sha/mtime 逐字节不变（此前 memory 测试会写它）；memory+memory.tool 连跑 5× 绿；远程 CI 双 job success。完整记录见主日志 `2026-09-production-hardening.md` W3.3-J。

## 18. A1+A2：durable quota 生产写入验收 + migrate runbook 真实落地（2026-09-05）

关闭了 §15/§17（及更早波次）反复出现的 "durable quota restart/cross-process lock/生产写入仍未验收"。完整记录见主日志 `2026-09-production-hardening.md` A1+A2 段与 runbook §7。

- [x] **durable reserve PK 复用修复**：`upload_key` = 内容 sha256，settle/release/expiry 后行保留为 tombstone → 同内容重传/同事务 inline-expiry 重试的裸 INSERT 撞 PK。修复：`uploadQuotaStore.js` `reserveUploadChunk` INSERT → UPSERT（复活 active、reserved_bytes=0、usage_day=今日）。修复前崩溃路径均有回归断言。
- [x] 新增 `src/services/uploadQuotaDurable.test.js` 8 个（durable adapter on per-worker 临时库）+ `scripts/quota-worker.mjs` 子进程 harness：restart 持久化、跨进程记账、PK 复用×2、usage_day 跨 UTC 日、expiry cleanup、settle/release 记账。全量 backend **33 files / 511 tests 绿**；`check:syntax` 纳入被改生产文件与两个新 scripts。
- [x] **HTTP durable 生产写入 smoke** `scripts/durable-upload-smoke.mjs`（真实 `/upload`、隔离临时库、`DURABLE_UPLOAD_QUOTA=true`、内置 embedding stub）：http 200 / committedBytes=194 / 0 active 残留，exit 0。
- [x] **真实 dev 库 `migrate-db.mjs --apply` 首次落地**：备份 `backend/backups/agent_data-2026-09-05T15-56-52-057Z.db`、WAL 折叠、ledger +1（`migrate-db:apply:2026-09-05T15-56-52-073Z`）、integrity 复检 ok、quota 表仍 0 active reservations、`destructiveActions:false`。runbook §6 全勾并新增 §7 执行记录。`backups/*.db` 已被 gitignore，不污染工作树。
- [ ] **残余（本轮不宣称解决）**：durable **同 key 跨进程锁** 需分布式锁服务（SQLite 只串行化记账事务；in-process `withUploadLock` 是唯一同 key 锁，adapter 注释已声明）。其余未变：eval 深度注入（D2，low ROI）、组织 RBAC、多实例 RAG、W4-W8/P2。

## 19. A3：完整 HTTP 双用户/并发隔离矩阵（真实 DB 版）（2026-09-06）

关闭历波反复出现的 "完整 HTTP 双用户/并发矩阵 仍未完成"（eval 深度维度除外）。完整记录见主日志 `2026-09-production-hardening.md` A3 段。

- [x] 3 路只读侦察：全部 owner-scoped 端点 owner 检查位置与跨 owner 返回码；既有 10 组测试的端点×双用户断言缺口表；运行时路由归属（factory 先于 inline）。静态审计：**无裸读/改/删他人数据端点**。
- [x] 软点清单（"缺 404 的静默成功"、零内容泄露）：messages/context-usage 跨 owner 200 空、compact 200 noop、feedback 200 不落库、eval generated 非本人 200 ok:false、observability/recent trace 补查无 user 过滤（低危）。
- [x] 新增 `src/httpIsolationMatrix.test.js`（真实 DB + `createApp()` 模块默认 + 原生 HTTP + 真实 JWT，A=admin/B=normal，fixtures 走 db API）：sessions CRUD 跨 owner 404 + 读路径 200 空零泄露、extension pair/branch/compact 无副作用、memory 隔离、feedback 跨 owner 不落库 vs 本人落库、obs trace 跨 owner 404 + admin 门禁 403/200、并发混合操作互斥。定向 6/6。
- [x] 全量 backend **34 files / 517 tests 绿**；**零生产代码改动**（矩阵锁定既有语义，无真越权可修）。
- [ ] **残余/候选**：eval 深矩阵（admin-only 树，现只到 admin 门禁层；补全待 D2）、durable 同 key 跨进程锁（需分布式锁）、软点改 404 属 FE 兼容评估（低优先）、组织 RBAC、多实例 RAG、W4-W8/P2。

## 20. W4-R1：统一重试接入 — 分类修复 + graph 工具/流裸点接线 + toolExecutor bug（2026-09-06）

关闭历波反复的 "W4 全量 retries 未做" 的首段（基础 + 接线 + bug）；W4-R 全貌（含可靠性矩阵）拆 2 小波，R1 = 本段，R2 = 下段。完整记录见主日志 `2026-09-production-hardening.md` W4-R1 段。

- [x] 侦察（2 路只读 + 本人核验锚点）：`resilience.withRetry`/`classifyError` 工具能力已完整，**缺口是接线**；并发现现存 bug —— `toolExecutorNode` 引用未声明 `signal`（工具路径必 ReferenceError → 吞成 TOOL_FAILED）。`requestContext` 身份对象无 `signal`（设计正确，abort 走 `config`）。
- [x] `services/resilience.js` `classifyError`：有 HTTP status 时 status 优先（4xx 保持不可重试）；无 status 时兜底 = 顶层网络码 / SDK Timeout name / `cause` 链（≤5 层）找网络码。向后兼容。
- [x] `services/chatGraph.js`：toolExecutorNode 补 `signal = config?.configurable?.abortSignal`（bug 修复）+ catch abort rethrow；`executeToolCalls` 加 signal 参并由 knowledgeAgentNode 传 config 真实 signal；三处裸点（generalChat 工具循环 / searchAgent webSearch / knowledge solo 流）包 `withRetry`（工具 retries:1、流 retries:2）+ abort rethrow。SSE/FSM/HTTP 契约零改动。
- [x] 测试：`services/resilience.test.js` +7 纯语义单测（classify SDK Timeout / cause 链单层与嵌套 / 400 隐藏网络 cause 仍不可重试 / 429+retryAfter 咨询 / 5xx 耗尽 rethrow / deadline → `RETRY_DEADLINE_EXCEEDED`）。定向 **11/11**；全量 backend **34 files / 524 tests 绿**（原 34/517，+7）；`node --check` ×3 OK。
- [x] **R2（本段 §20 已完成）**：graph 可靠性矩阵 —— fake makeLlm（实现 invoke/stream/bindTools，按次抛 flaky/exhaust，经 `createApp({dependencies:{services:{makeLlm}}})` + `USE_LANGGRAPH=true` 驱动真实节点）+ HTTP `reader.cancel` 半开 abort；4 用例全绿（重试→成功 / 耗尽→公开错误 / 退避中 abort 唤醒 attempt==1 / B 不受 A 取消）。详见 §21。纯测试波，零生产改动。
- [ ] **仍延后**：LangChain `maxRetries` 与 withRetry 叠加的预算协调（共享 `buildChatOpenAIConfig`，牵 legacy 路径，并入接线时统一置 0）；rag 全链路 / eval judge·generator·reflection / mcp connect·listTools / bocha fetch 接线；SSE 错误字段审计（独立 W4-SSE 波）。真实工具 `invoke` 侧无法经 makeLlm seam 注入 flaky（工具退避 abort 只在纯语义单测覆盖）。W4 §2 清单以 §20+§21 为准逐步勾选。

## 21. W4-R2：graph 可靠性矩阵（2026-09-06）

关闭 §20 的 R2：此前无任何测试真正跑过 LangGraph 节点，R1 接线（withRetry + config.abortSignal）缺全图集成验收。完整记录见主日志 `2026-09-production-hardening.md` W4-R2 段。

- [x] 侦察（2 路 Explore + 本人读码核验注入缝/SSE/abort 链/generalChat ReAct/router JSON 契约）：注入缝 `options?.deps?.services?.makeLlm`；`_useLangGraph` 请求时读 env；graph SSE = services/sse.js writer（error=toPublicError envelope、done=[DONE]）；abort = res close→controller.abort→静默收尾；withRetry 包 `stream()` 调用而非 for-await 迭代。
- [x] 新建 `backend/src/services/chatGraphReliability.test.js`（real DB + `createApp({services:{makeLlm}})` + `USE_LANGGRAPH=true` + native HTTP）：fake makeLlm 按 `opts.streaming` 分流 router/generalChat；streaming fake 闭包 attempt、按末条消息 marker 分流 scenario（AB 并发同服无共享可变态）。4 用例：flaky→成功(attempt==2)、耗尽→公开错误 envelope(attempt>=3、无 secret、无 [DONE])、退避中 `reader.cancel`→abort 唤醒(attempt==1、无假 assistant)、A 取消不影响 B(单服务器双用户并发)。
- [x] 验证：定向 **4/4**（一次通过）；全量 backend **35 files / 528 tests 全绿**（原 34/524，+1/+4）；`node --check` + `git diff --check` OK；dev 库不被触碰。零生产代码改动。
- [ ] **残余/候选**：真实工具侧 flaky 集成缝（工具退避 abort 无独立集成测试）；LangChain `maxRetries:0` 与 withRetry 协调；rag/eval/mcp/bocha 余下接线；**W4-SSE 错误字段审计**（独立小波）；durable 同 key 跨进程锁（需分布式锁）、软点→404、组织 RBAC、多实例 RAG、W5-W8/P2 继续延后。

## 22. W4-R3：一次收口 — 预算统一 + 余下接线 + SSE 错误终态 + bocha 瞬态真重试（2026-09-06）

收口 W4 §2 余下项（R1 graph 主链 + R2 集成验收之后）；用户 3 决策：bocha transient 抛错 / legacy error 后无 [DONE] 对齐 graph / SSE 只修 #1+#3。完整记录见主日志 `2026-09-production-hardening.md` W4-R3 段。

- [x] **C1 预算统一**：`buildChatOpenAIConfig` 默认 `maxRetries:0`（withRetry = 唯一重试预算层）；legacy `getAgentExecutor` 显式 `{maxRetries:2}`（整 executor withRetry 会重放工具副作用 → 保留模型层单层，注释注明）。`app.js` compaction ×2、`eval` generator/judge/optimize.suggest 的 raw `llm.invoke` 包 withRetry(retries:2)，耗尽可能回落的 `error/rationale/summary` 用 `toPublicError` 消息（provider secret 不写 DB）。
- [x] **C1 MCP connect 有界超时（计划偏差）**：不用 withRetry 包 connect（Stdio 重 spawn 泄漏孤儿子进程）→ `Promise.race` 15s 握手超时 + transport.close。
- [x] **C2 SSE #1**：`chat.js` catch 删无条件 `sseWriter.done()`，error 帧后 `res.end()`（对齐 graph；FE 不再把 [DONE] 当成功）。
- [x] **C2 SSE #3**：`app.js` `chatImpl` async guarded —— `!headersSent` → JSON 500（显式改回 application/json content-type）；`headersSent` → `writeSseError`+`onFailure`+`end`。四个调用点一次改齐；pre-try 逃逸不再挂死。
- [x] **C3 bocha 真重试**：`fetchBocha` 不再吞错 —— 429/408/5xx throw 带 status、10s abort → `UPSTREAM_TIMEOUT`、网络上抛走 cause 链、4xx 保持空结果；web_search 外层 catch `retryable → throw classified` 否则 public 字符串；chat.js 强制联网步 `withRetry(retries:1, signal)` + toPublicError 脱敏喂模型。graph searchAgent withRetry+fallback 由惰性转真重试。
- [x] 测试 +4 文件 / +15 用例（budgetRetryWiring 5 / chatSseContract 2 / webSearchRetry 6 / chatForcedSearchRetry 2）。
- [x] 全量 backend **39 files / 543 tests 全绿**（原 35/528，+4/+15）；frontend 9 files / 155 tests 保险复跑全绿；`node --check` + `git diff --check` OK；dev 库不被触碰。
- [ ] **残余/延后**：SSE #2（streamEvents error 分支，延后专门 legacy 波）；真实工具 flaky 集成缝；durable 同 key 跨进程锁（需分布式锁）、软点→404、组织 RBAC、多实例 RAG、W5-W8/P2 继续延后。

## 23. W4-R4：重试/SSE 收口扫尾 — SSE #2 + 真实工具 flaky 矩阵 + registry 契约 + 死角护栏（2026-09-06）

关闭 §22 残余的 SSE #2、真实工具 flaky 集成缝，并把 C1 死角（config-default 无 withRetry）账清到零 + 源级护栏锁死。用户 4 决策选本波（"接下来还有什么可做的？一次三四个" → W4-R4）。完整记录见主日志 `2026-09-production-hardening.md` W4-R4 段。

- [x] **T1（SSE #2，生产改动）** `services/chat.js`：legacy 两条 `AgentExecutor.streamEvents` for-await 顶部各加 error 族事件升级（`on_chain_error`/`on_chat_model_error`/`on_llm_error` → throw sanitized Error `{code:"UPSTREAM_UNAVAILABLE", retryable:true, cause}`，raw 只进 console+cause，收敛到既有 catch error envelope + res.end() **无 [DONE]**）；成功终态 `persistMessage` 前加空输出守卫（`!fullText` → `EMPTY_OUTPUT` 失败终态，不落空 assistant、不发假 [DONE]）。
- [x] **T1 测试** `routes/chatStreamEventsError.test.js`（deep-chat fake bag + scripted fake executor，`USE_LANGGRAPH=false`）3 用例：迭代中途抛 503（先部分 text）→ 保留 text + `UPSTREAM_UNAVAILABLE` envelope、无 [DONE]、零 assistant 落库、无 secret；`on_chain_error` 事件后正常收尾 → 升级 error envelope（改造前假 [DONE]）；零 text 正常收尾 → `EMPTY_OUTPUT` 失败终态。
- [x] **T2（零生产改动）** `services/chatGraphToolReliability.test.js`：patch 真实 `bochaSearchTool.func`（tools.js 模块级对象即 registry 同一实例）驱动真实 searchAgentNode × DynamicTool.invoke × withRetry 端到端。fake makeLlm 按 `opts.streaming` 分流（router 非流式 → search JSON `intents:["search"]` solo；search summarizer 流式 → 可 concat AIMessageChunk）。3 用例：flaky 一次 → 真重试（calls==2）+ tool_end + 结果注入 + [DONE]；恒 503 耗尽 → calls==2、SSE `tool_error`（固定通用文案，不泄细节）+ `{ok:false,"联网检索暂时不可用"}` 进 search LLM input 降级、solo 仍出回答；退避中 `reader.cancel` → abort 唤醒 calls==1、无假 assistant、无 [DONE]。
- [x] **T3（零生产改动）** `mcp/registryInvokeRetry.test.js`：fresh ToolRegistry + flaky DynamicTool，走真实 `invokeTool → withRetry(retries:1)` 全链 4 用例：fail-once resolve（calls==2）；恒 503 耗尽 rethrow `classifyError`（retryable + `UPSTREAM_UNAVAILABLE`、calls==2）；退避中 abort → `ABORTED`/499、calls==1；缺工具同步 reject。
- [x] **T4（生产改动 + 护栏）** `eval/reflection.js` reflectionLlm.invoke、`services/memory.js` llmMemoryConsolidation 的 llm.invoke 各包 `withRetry(retries:2)`（DEAD CODE 注释标注 maxRetries:0 理由）。新建 `services/retryInvariant.test.js` 源级护栏 4 用例：allowlist 含 `new ChatOpenAI(` 必含 `withRetry(` 调用；reflection/memory 各自唯一裸 invoke 在 withRetry 包裹区间内；src 全量扫描（除 learning/）ChatOpenAI 构造模块皆在 allowlist。
- [x] 全量 backend **43 files / 557 tests 全绿**（原 39/543，+4/+14）；frontend 9 files / 155 tests 保险复跑全绿；`git diff --check` OK；dev 库不被触碰。
- [ ] **残余/延后**：durable 同 key 跨进程锁（需分布式锁）、软点→404、组织 RBAC、多实例 RAG、W5-W8/P2 继续延后。W4 全部明确残余已清零。

## 24. W4-R5：收口全垒打 — 三文档未完成项全量对账（2026-09-06）

用户决策（本次会话）：阅读 runbook / roadmap / 主日志后要求"今天把未完成部分全部弄完"，AskUserQuestion 选 **A+B 收口全垒打**。**runbook §6 DoD 已全勾、§7 已含真实 `--apply` 执行记录 → 本次 0 待办**。主日志为时间线记录、无独立任务；roadmap 残余分三类：**文档漂移勾选**（已完成未勾，刷新）、**本波可闭合的有界项**（W4 真残余 + durable 同 key 跨进程锁 + W3.2 小残余）、**外依赖/大程序**（如实延后）。完整实施记录见主日志 W4-R5 段；本节是恢复入口与残余总账。

- [x] **T1 — RAG embedding/search withRetry 接线（roadmap §2 W4 首项 + §20 延后项）**：`rag/index.js` embeddings `maxRetries:0`（C1 预算统一）+ `fromTexts`/`addDocuments`/`similaritySearchWithScore` 三条网络裸点包 `withRetry({retries:2})`；新 `rag/retry.test.js` 4 用例（vi.mock faiss 可控缝，零网络）。
- [x] **T2 — 工具结果统一 + Synthesizer 只收成功/blocked 守卫（roadmap §2 W4 "工具结果统一为 {ok,...}"项）**：`chatGraph.js` 内联文本前缀分类器提升为导出 `isErrorResultText` + 结构化失败标记；成功但空（no_match/空库）不误伤；新 `chatGraphErrorResult.test.js` 4 用例 + 源级不变量。按 W4-R1 注释口径**不把遗留字符串工具 objectify**（记录为明确非目标）。
- [x] **T3 — /chat reconnect/replay 无副作用 + 429 终端（roadmap §2 W4 测试项）**：真实 HTTP + 注入计数 executor 断言同 key 二 POST 走 `writeReplaySSE` 回放不重执行（`chatIdempotentReplay.test.js` 2）；`chatGraphToolReliability.test.js` 增恒 429 真实节点耗尽降级（现 4 用例）。
- [x] **T4 — durable 同 key 跨进程锁闭合（roadmap §18/§19/§22/§23 历波残留的"需分布式锁服务"项）**：**零外部依赖** —— SQLite `upload_key_locks` 租约表（additive DDL + ledger `W4-R5-S1`），durable adapter `withUploadLock` 由 in-process 内存锁升级为 DB 租约（INSERT OR IGNORE acquire / 过期原子回收 / 持有续约 / holder_token 释放 / busy 到期 429）。新 harness `scripts/quota-lock-worker.mjs` + 子进程验收 `uploadQuotaLockDurable.test.js` 4 用例：双 OS 进程互斥、SIGKILL 崩溃持有者租约回收、活租约不偷、过期原子回收。
- [x] **T5 — W3.2 小残余（roadmap §2 W3.2 `[~]` 项）**：`startServer` 启动期 `warnVolatileRuntimeState()`（DURABLE_UPLOAD_QUOTA 内存模式 / RAG 向量无落盘 / 图片内存态三条重启丢失告警）；`audit-db.mjs` 只读扩展 `quotaGovernance`（per-owner committed/reserved 字节 + lockLeases）+ `diskStaging` 字节级磁盘治理报告；`startupVolatility.test.js` 4 源级护栏。
- [x] **验证**：全量 backend **48 files / 576 tests 全绿**（原 43/557，+5/+19）；frontend 9 files / 155 tests 保险复跑全绿；`node --check` + `git diff --check` exit=0；dev 库不被触碰（audit 只读跑 scratch 副本）。
- [x] **文档勾选对账（本次刷新）**：§2 W3.2 "同 key 跨进程锁需分布式锁服务" → 已闭合（见本段 T4）；§2 W3.2 "[~] 重启丢失告警、字节级磁盘治理…未完成" → 已完成（T5，多实例共享 RAG 仍延后）；主日志新增 W4-R5 段。§18/§19/§22/§23 历史残余行中 "durable 同 key 跨进程锁（需分布式锁）" **该项被本段取代关闭**，其余（软点→404、RBAC、多实例 RAG、W5-W8/P2）维持原状不变。
- [ ] **残余总账（如实，非今日可闭合）**：软点→404（API 行为变更，FE 兼容评估，低优先）；eval 深矩阵补全待 D2（admin-only 树，低 ROI）；组织 tenant/RBAC（§2 W3.1）；多实例/持久化 RAG（W5/W6）；Redis/OTLP exporter/Prometheus/健康告警（W6）；queue/checkpoint/replay/resume（W7）；A/B 实验（W8）；P2 岗位项（Skills Runtime/沙箱/remote MCP/生产 Reflection）；trusted proxy 真实代理链部署验证。下一候选波：**W4-SSE 错误字段审计**（独立小波）或 W5 durable RAG 起步。
