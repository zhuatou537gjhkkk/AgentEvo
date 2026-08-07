---
name: agent-upgrade-phase4-p0
description: Phase 4 P0 Plan 驱动多 Agent 执行完成 (2026-08-02)
metadata:
  type: project
---

Phase 4 P0 完成。核心变更：Planner 从生成 display-only plan steps 改为生成 subTask[] 驱动执行。

**Why:** Phase 3 验证暴露 6 个核心缺陷：Planner 与执行脱节、Agent 工具硬编码、Router 不感知 MCP 工具、fanout 按 intent 而非 subTask、getTool() 本地遮蔽 MCP 工具、Synthesizer 仅简单拼接。

**How to apply:**

### 架构变更

1. **State 新增 3 字段**: `subTasks` (数组), `planResults` (字典), `currentSubTask` (对象)
2. **Router 动态工具感知**: prompt 动态注入 ToolRegistry.getToolCategories()，不依赖 planMode；Capability Gate 增强
3. **Planner 重写**: planMode=true → LLM 分解 subTask[]（type=tool/reasoning）；toolName 可用性校验；blocked 标记
4. **fanoutToAgents 双路径**: subTasks 存在 → fanoutBySubTasks (Send[] to tool_executor)；否则 → fanoutByIntents (向后兼容)
5. **toolExecutorNode** (新增): 通用工具执行器，接收 currentSubTask，动态 getTool()，执行，存 planResults
6. **Synthesizer 升级**: 读取 planResults + reasoning 结构指引 + blocked 提示；Solo 仍透传
7. **getTool() 命名空间**: `serverName/toolName` 格式；裸名注册仅当无本地冲突；getToolCategories()
8. **mapIntentToNode()**: 动态映射 — 已知 Agent 节点优先，MCP 类别 → tool_executor

### 向后兼容
- `USE_LANGGRAPH=false` 完全不执行
- `planMode=false` + 4 固定 intent → 走旧 intent-based 路径（行为等价）
- 现有 Agent 节点一行不改
- SSE 事件类型不变

### 关联
- [[agent-upgrade-phase3]] — Phase 3 验证暴露的问题
- [[agent-upgrade-vision]] — 最终形态
- [[agent-upgrade-init]] — 启动决策
