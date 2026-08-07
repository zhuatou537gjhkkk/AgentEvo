---
name: agent-upgrade-known-bugs
description: Agent 升级已知 Bug 追踪。持续更新，Phase 结束时清理。
metadata:
  type: project
---

## 已知 Bug

### BUG-MEM-01: general_chat 节点 LLM 间歇性跳过 tool call

- **发现**: 2026-08-04, Phase 4 E2E 测试 TC-E6
- **严重程度**: 🟢 已修复 (Phase 5 Reflection 循环)
- **现象**: 用户要求使用 memory 工具，LLM 有时不调用 tool 直接用自然语言假装已执行
- **修复**: Phase 5 ReflectionLoop.reflect() → 自我审查检测 missing_tool_call → 构建改进 prompt → 重新生成（最多 3 轮）
- **启用**: `POST /eval/run {reflect: true}` — 不在生产路径默认开启以避免延迟
- **关联**: [[agent-upgrade-phase5]]

### BUG-METRICS-01: Token 计数不准

- **发现**: Phase 2 (老 bug)
- **严重程度**: 🟢 已修复 (2026-08-05, 3 尾巴清理)
- **现象**: Token 计数使用 `Math.ceil(str.length / 4)` 估算，中文被低估约 4 倍
- **修复**:
  1. 从 LLM API 流式响应中提取真实 `usage_metadata` (`AIMessageChunk.usage_metadata`)
  2. `chat.js`: streamEvents v2 循环中累加 `on_chat_model_stream` chunk 的 usage
  3. `chatGraph.js`: State 新增 `tokenUsage` 字段（sum reducer），Router/Planner/Synthesizer 节点各自返回 usage
  4. `streamDirectChat`: 返回值从 `string` 改为 `{fullText, usage}`
  5. `estimateTokens` 升级为 CJK-aware 版本（CJK 1 字≈1 token，英文 1 词≈1.3 token）作为 fallback
  6. `app.js` 两处硬编码 `answer.length/4` → `estimateTokens(answer)`
- **关联**: [[agent-upgrade-phase5]]

### BUG-SYNTH-01: Synthesizer 混合意图边缘场景

- **发现**: Phase 2 (老 bug)
- **严重程度**: 🟢 已修复 (2026-08-05, 3 尾巴清理)
- **修复**:
  1. **Planner 多意图感知**: prompt 中 `state.intent` → `state.intents.join("、")`，使 Planner 能看到全部意图并生成对应的 subTask
  2. **错误结果过滤**: Synthesizer 新增 `isErrorResult()` 检测，过滤 `(.*工具不可用)`、`知识库检索出错:`、`联网搜索出错:` 等错误字符串，不混入融合 prompt
  3. 被过滤的错误来源通过 `blockedNote` 告知用户
- **关联**: 3 尾巴清理测试 [[docs/TEST_CASES_3TAILS]]

### BUG-DB-01: Session 删除 FK 约束失败

- **发现**: 2026-08-05, 3 尾巴清理 TC-2.1 测试中
- **严重程度**: 🟢 已修复
- **现象**: 删除 Session 时报 `FOREIGN KEY constraint failed`
- **根因**: `removeSession` 事务只清理了 message_metrics、messages、sessions 3 张表，Phase 4/5 新增的 eval_scores、eval_feedback、eval_traces、agent_memory 4 张表未加入级联删除
- **修复**: 新增 4 个 prepared statement，事务中按正确依赖顺序删除：eval_scores → eval_feedback → eval_traces → agent_memory → message_metrics → messages → sessions
- **关联**: [[docs/TEST_CASES_3TAILS]]

### BUG-ROUTER-01: Router 多意图检测盲区

- **发现**: 2026-08-05, 3 尾巴清理 TC-2.1
- **严重程度**: 🟢 已修复
- **现象**: 
  1. 用户问"Python 的 asyncio 是什么？顺便在知识库里找找"，Router 只返回 `[knowledge]`（第一轮）
  2. 修复后返回 `[general, knowledge]`，Router 仍倾向归类为 `general` 而非 `search`（第二轮）
  3. Planner 在 `intent==="general"` 时直接跳过，即使 mixed intents 中还有其他有效意图
- **修复**:
  1. Router prompt 加入 `enableWebSearch` 感知 hint：联网开启时优先 `search` 而非 `general`
  2. 缩小 `general` 语义范围：只覆盖"纯主观/创造性任务"
  3. 加入多意图信号词：如"顺便"、"同时"、"另外"、"也帮我"
  4. Planner 跳过条件改为 `state.intent === "general" && allIntents.length === 1`
- **关联**: [[docs/TEST_CASES_3TAILS]]

### BUG-MEM-02: 中文记忆搜索返回空

- **发现**: 2026-08-05, 3 尾巴清理 TC-3.4
- **严重程度**: 🟢 已修复
- **现象**: 搜索"用户信息"，记忆库中有"用户名叫李四，住在北京，喜欢打篮球"，返回 `results:[]`
- **根因**: `searchMemory()` 用 `split(/\s+/)` 分词 + `includes()` 子串匹配。中文无空格 → 整串当作一个 token → "用户信息" 不是 "用户名叫李四..." 的子串 → `keywordScore=0` → `relevanceScore≈0.116` < 阈值 `0.15` → 全部被过滤
- **修复**: 新增 CJK 字符 bigram 双通道匹配：
  - 通道 A: CJK bigram — "用户信息" → `["用户","户信","信息"]`，与内容 bigram 集合求交集
  - 通道 B: 空格分词 + `includes()` — 英文等空格分隔语言
  - 取两通道 score 较高值作为 `keywordScore`
- **验证**: "用户信息" bigramScore = 1/3 → `relevanceScore≈0.38` > 0.15 ✅
- **关联**: [[docs/TEST_CASES_3TAILS]]

### BUG-MEM-03: enableMemory=false 时模型仍可调用 memory 工具

- **发现**: 2026-08-05, 3 尾巴清理 TC-3.2
- **严重程度**: 🟢 已修复
- **现象**: 前端关闭记忆开关，模型仍然调用 `memory` tool 写入记忆
- **根因**: 
  1. `AgentState` 未定义 `enableMemory` 字段
  2. `initialState` 未传入 `enableMemory`
  3. `generalChatNode` 无条件将所有 system 工具（含 `memory`）通过 `bindTools()` 绑定给 LLM
- **修复**:
  1. `AgentState` 新增 `enableMemory: Annotation({ default: () => true })`
  2. `initialState` 加入 `enableMemory`
  3. `generalChatNode` systemTools 过滤：`state.enableMemory !== false || t.name !== "memory"`
  4. `ChatInput.jsx` 显式传递 `enableMemory` 到 `sendMessage()`
- **关联**: [[docs/TEST_CASES_3TAILS]]

---

## 新增功能 (2026-08-05)

### ChatInput 记忆开关

- **描述**: Phase 4 推迟项 — 用户可通过 ChatInput 工具栏控制是否启用记忆
- **链路**: ChatInput toggle → chatStore.enableMemory → API `enable_memory` → backend AgentState.enableMemory
- **后端行为（关闭时）**:
  - `generalChatNode` 不绑定 `memory` 工具 → 模型无法调用
  - 跳过 `setMemoryToolContext()` — memory tool 上下文不注入
  - ContextBuilder 不检索记忆（MemoryService 传 null）
  - 跳过 auto-extract + auto-consolidate
  - 跳过 MemoryService 初始化
- **默认**: `true`（向后兼容）
- **持久化**: localStorage (Zustand partialize)
- **关联**: [[agent-upgrade-phase4]]
