---
name: agent-upgrade-phase4-learning-ch8-ch9
description: Phase 4 Ch8+Ch9 学习总结 (2026-08-03): 记忆系统 + 上下文工程核心概念与 AgentEvo 差距分析
metadata:
  type: project
---

Phase 4 学习任务完成。已系统学习 Hello-Agents Ch8（记忆与检索）和 Ch9（上下文工程）。

**Why:** 为 AgentEvo 添加结构化记忆系统和 token 感知的上下文管理提供理论指导。

**How to apply:**

## Ch8 记忆系统核心要点

1. **四层记忆架构**: Working (TTL/纯内存) → Episodic (SQLite+Qdrant 事件) → Semantic (Qdrant+Neo4j 知识图谱) → Perceptual (多模态)
2. **MemoryTool 统一接口**: `execute(action, **kwargs)` — 9 种操作覆盖记忆全生命周期
3. **混合检索公式**: `(TF-IDF向量 × 0.7 + 关键词 × 0.3) × 时间衰减 × 重要性权重`
4. **记忆巩固**: importance ≥ 0.7 → working→episodic; importance ≥ 0.8 → episodic→semantic
5. **RAG 高级策略**: MQE (多查询扩展并行检索), HyDE (假设文档嵌入)

## Ch9 上下文工程核心要点

1. **GSSC 管道**: Gather → Select (relevance×weight + recency×weight, 贪婪填充) → Structure (六段模板) → Compress (分段截断)
2. **ContextConfig**: max_tokens, reserve_ratio, min_relevance, enable_compression
3. **三大长程技术**: Compaction (摘要接力), Structured Note-taking (Agent 主动写笔记), Sub-agent (干净窗口探索)
4. **JIT 上下文**: 不预加载所有数据，运行时通过 TerminalTool 按需访问 (head/tail/grep/ls)
5. **CodebaseMaintainer**: ContextBuilder + NoteTool + TerminalTool + MemoryTool 四合一实战

## AgentEvo 当前状态 vs 目标

| 能力 | 现状 | Ch8/Ch9 启发 |
|------|------|-------------|
| 消息存储 | SQLite messages 表 (会话粒度) | 需要 MemoryItem 粒度 + memory_type |
| 跨会话记忆 | ❌ 无 | 需要 agent_memory 表 + FAISS 长期索引 |
| 上下文构建 | 直接拼接历史消息 | 需要 GSSC 管道 + token 预算管理 |
| 上下文压缩 | ❌ 无 | 需要 Compaction: LLM 摘要 → 新窗口 |
| Agent 笔记 | ❌ 无 | 需要 NoteTool 等价物 (Agent 主动持久化) |
| Sub-agent | ✅ Phase 2 已实现 | 对标 Ch9 的 Sub-agent Architecture |

## 关联
- [[agent-upgrade-phase4-p0]] — P0 Plan 驱动多 Agent 执行 (已完成)
- [[agent-upgrade-phase3]] — Phase 3 MCP 协议升级
- [[agent-upgrade-vision]] — 最终形态
- [[agent-upgrade-init]] — 启动决策
