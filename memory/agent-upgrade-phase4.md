---
name: agent-upgrade-phase4
description: Phase 4 记忆与上下文工程完成 (2026-08-03): 三层记忆架构 + GSSC 上下文管道 + 前端记忆管理
metadata:
  type: project
---

Phase 4 记忆与上下文工程完成。

**Why:** Ch8+Ch9 学习后落地实践。对标 Hello-Agents MemoryTool + ContextBuilder，为 AgentEvo 实现结构化记忆系统和 token 感知的上下文管理。

**How to apply:**

## 方向A: 三层记忆架构

### 数据库 (`backend/src/db/index.js`)
- 新增 `agent_memory` 表: id, user_id, session_id, content, memory_type, importance(0~1), metadata(JSON), created_at, updated_at
- 3 个索引: idx_agent_memory_user_id, idx_agent_memory_type, idx_agent_memory_session
- 10 个 exported functions: addMemory, searchMemory, consolidateMemory, forgetMemory, getMemoryStats, getMemorySummary, updateMemory, removeMemory

### 记忆服务 (`backend/src/services/memory.js`)
- `MemoryService` class: add/search/consolidate/forget/stats/summary/update/remove
- `extractFromConversation()`: 正则自动提取用户偏好/决策（3 种模式）
- `llmMemoryConsolidation()`: LLM 驱动的会话总结提取 + 记忆巩固
- 混合检索公式: `(keyword_score × 0.7 + recency_score × 0.1) × (0.8 + importance × 0.4)`

### 记忆工具 (`backend/src/mcp/tools.js`)
- `memory_tool` DynamicTool: 6 种 action (add/search/consolidate/forget/stats/summary)
- 已注册到 agentTools + ToolRegistry，所有 Agent 节点可用

### 自动巩固 (`backend/src/services/chatGraph.js`)
- 每次 chatWithGraph 完成后自动执行:
  1. extractFromConversation() 提取用户偏好
  2. consolidate("working"→"episodic", threshold=0.7)

## 方向B: 上下文工程 GSSC 管道

### ContextBuilder (`backend/src/services/contextBuilder.js`)
- `ContextConfig`: maxTokens, reserveRatio, minRelevance, enableCompression, relevanceWeight, recencyWeight, maxHistoryTurns
- `ContextPacket`: content, timestamp, tokenCount, relevanceScore, metadata
- GSSC 管道四阶段:
  1. **Gather**: 系统指令 + 对话历史 + 记忆检索 + 自定义包 (fault-tolerant per source)
  2. **Select**: combinedScore = relevanceWeight × relevance + recencyWeight × recency; 贪婪填充到 token 预算
  3. **Structure**: [Role][Task][State][Context][Output] 五段模板
  4. **Compress**: 分段截断，保留句子边界

### chatGraph 集成
- `chatWithGraph` 中自动构建优化上下文
- `optimizedContext` 注入 State，所有 Agent 节点可用
- `createChatContextBuilder()` 默认配置: maxTokens=6000, reserveRatio=0.15, 10轮历史

## 方向C: 前端记忆管理

### 后端 API (`backend/src/app.js`)
- `GET /memory` — 列表/搜索记忆
- `GET /memory/stats` — 记忆统计
- `DELETE /memory/:id` — 删除单条
- `DELETE /memory` — 清空所有
- `POST /memory/consolidate` — 手动触发巩固

### 前端组件
- `frontend/src/components/MemoryPanel.jsx`: 记忆浏览/搜索/删除/清空/巩固 UI
- `frontend/src/store/chatStore.js`: memories/memoryStats/isMemoryLoading state + 5 actions
- `frontend/src/api/chat.js`: 5 API functions (fetchMemories, fetchMemoryStats, deleteMemory, clearAllMemories, consolidateMemories)
- `frontend/src/components/SettingsModal.jsx`: 集成 MemoryPanel tab

## 文件清单

| 文件 | 说明 |
|------|------|
| `backend/src/db/index.js` | +140 行: agent_memory 表 + 10 个 CRUD functions |
| `backend/src/services/memory.js` | 🆕 190 行: MemoryService + llmMemoryConsolidation |
| `backend/src/services/contextBuilder.js` | 🆕 300 行: ContextBuilder + GSSC 管道 |
| `backend/src/mcp/tools.js` | +80 行: memory_tool DynamicTool |
| `backend/src/services/chatGraph.js` | +20 行: ContextBuilder 集成 + 自动巩固 |
| `backend/src/app.js` | +63 行: 5 个记忆管理 API 端点 |
| `frontend/src/components/MemoryPanel.jsx` | 🆕 190 行: 记忆管理面板 |
| `frontend/src/api/chat.js` | +38 行: 5 个记忆 API functions |
| `frontend/src/store/chatStore.js` | +55 行: 记忆 state + 5 actions |
| `frontend/src/components/SettingsModal.jsx` | +7 行: 集成 MemoryPanel |

## 回归测试
- 后端 144 测试 ✅ 全部通过
- 前端 57 测试 ✅ 全部通过
- 记忆 API 6 端点 ✅ 手动验证通过
- ContextBuilder GSSC ✅ 手动验证通过

## 关联
- [[agent-upgrade-phase4-p0]] — P0 Plan 驱动多 Agent 执行 (已完成)
- [[agent-upgrade-phase4-learning-ch8-ch9]] — Ch8+Ch9 学习总结
- [[agent-upgrade-phase3]] — Phase 3 MCP 协议升级
- [[agent-upgrade-vision]] — 最终形态
