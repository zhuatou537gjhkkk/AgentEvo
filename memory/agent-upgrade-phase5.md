---
name: agent-upgrade-phase5
description: Phase 5 评估与自进化体系完成 (2026-08-04): AgentArts 风格观测/评估/优化三层架构 + 前端 EvalDashboard
metadata:
  type: project
---

Phase 5 评估与自进化体系完成。

**Why:** 对标华为 AgentArts（智果）平台的观测→评估→优化三层架构，建立 Agent 效果评估机制和 Reflection 自改进闭环。用户在华为实习负责 AgentArts 的观测/评估/优化模块，此 Phase 可作为实习技术输出。

**How to apply:**

## 架构总览

```
backend/src/
├── trace/              # 模块1: 观测
│   ├── collector.js    # TraceCollector: Trace → Span 层级采集
│   └── exporter.js     # OTel 兼容导出 stub
├── eval/               # 模块2+3: 评估 + 优化
│   ├── testCases.js    # 50+ 测试场景 (8 类)
│   ├── runner.js       # EvalRunner: 自动化评估流水线
│   ├── judge.js        # LLMJudge: 4 维度评分
│   ├── metrics.js      # DB 存储/查询
│   ├── reflection.js   # Reflection 自改进循环
│   └── evalRoutes.js   # Express Router (6 endpoints)
frontend/src/
├── components/
│   ├── EvalDashboard.jsx  # 趋势图 + 统计卡片
│   ├── EvalRunner.jsx     # 测试套件运行面板
│   └── EvalFeedback.jsx   # 👍/👎 用户反馈按钮
└── api/eval.js            # eval API 调用 (7 functions)
```

## 模块1: 观测 (Observability)

### 数据库: 3 张新表
- `eval_traces`: 结构化 Trace 存储 (trace_id, root_span JSON, agent_traversal_path, tool_call_count, error_count)
- `eval_scores`: 评估分数 (dimension × 4, score, judge_rationale, run_id)
- `eval_feedback`: 用户反馈 (thumbs_up/thumbs_down, UNIQUE per user+message)

### TraceCollector (`backend/src/trace/collector.js`)
- `startTrace()` / `startSpan()` / `endSpan()` / `finishTrace()`
- Span 三层: root → agent → tool
- 自动计算 tool_call_count / error_count / agent_traversal_path
- 已集成到 chat.js + chatGraph.js 双路径
- SSE `metrics` 事件新增 `trace_id` 字段

### /observability/recent 扩展
- 返回字段新增: `tool_call_count`, `error_count`, `agent_traversal_path`, `trace_id`, `content` (截断100字)

## 模块2: 评估 (Evaluation)

### 测试集 (`backend/src/eval/testCases.js`)
- 50+ 场景，覆盖 8 类：知识问答(10) / 联网搜索(10) / 多步推理(8) / 记忆召回(5) / 代码生成(5) / 创意任务(5) / 工具选择(5) / 边界场景(5)

### LLMJudge (`backend/src/eval/judge.js`)
- 4 维度评分: correctness / tool_usage / conciseness / safety (0-5)
- `LLMJudge.evaluate(testCase, capturedOutput)` → structured JSON
- `LLMJudge.isPassing(scores, threshold)` + `LLMJudge.weightedScore(scores, weights)`
- 默认权重: correctness=0.4, tool_usage=0.3, conciseness=0.1, safety=0.2

### EvalRunner (`backend/src/eval/runner.js`)
- `EvalRunner.run(testCaseIds, runId, {reflect})` → 批量运行→评分→存储
- `CapturedResponse`: 模拟 SSE response，截获 text + tool events
- 支持分类筛选，进度回调

### API 端点
| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /eval/run` | POST | 运行评估 (可选 `{reflect: true}`) |
| `GET /eval/scores` | GET | 历史分数/趋势查询 |
| `GET /eval/report` | GET | 聚合报告 (趋势+统计+反馈) |
| `GET /eval/cases` | GET | 测试用例列表 |
| `POST /chat/feedback` | POST | 👍/👎 用户反馈 |
| `GET /eval/feedback/:messageId` | GET | 获取消息反馈状态 |

## 模块3: 优化 (Optimization)

### Reflection 循环 (`backend/src/eval/reflection.js`)
- 自我审查: 检测 missing_tool_call / factual_error / contradiction / off_topic / hallucination
- 最多 3 轮重新生成，取最高分版本
- 通过 `POST /eval/run {reflect: true}` 开关控制
- 直接修复 BUG-MEM-01

## AgentArts 对齐

| AgentArts 能力 | AgentEvo 实现 |
|---|---|
| 全链路 Trace/Span | TraceCollector + eval_traces |
| 指标监测 | /observability/recent 扩展 |
| 三层评估体系 | LLMJudge 4 维度 + testCases 8 类 |
| 离线评估 + 在线评估 | EvalRunner + /chat/feedback |
| 评估→优化闭环 | Reflection 自改进循环 |
| 数据回流 | 👍/👎 → eval_feedback |

## 前端

### EvalDashboard
- 模态弹窗 (SettingsModal 模式复用)
- 趋势柱状图 (纯 CSS/Tailwind, 无额外依赖)
- 统计卡片 (总测试数/反馈数/👍/👎)
- "运行评估" 按钮 → 展开 EvalRunner

### EvalFeedback
- 👍/👎 按钮嵌入 MessageItem
- 乐观更新 + 失败回滚
- 已评分状态持久化

### Sidebar
- 新增 "评估" 按钮 (3 列 grid: 设置/评估/导出)

## 文件清单

**新建 (18 个)**:
- `backend/src/trace/collector.js`, `exporter.js`
- `backend/src/eval/testCases.js`, `runner.js`, `judge.js`, `metrics.js`, `reflection.js`, `evalRoutes.js`
- `backend/src/trace/__tests__/collector.test.js`
- `backend/src/eval/__tests__/judge.test.js`, `testCases.test.js`
- `frontend/src/components/EvalDashboard.jsx`, `EvalRunner.jsx`, `EvalFeedback.jsx`
- `frontend/src/api/eval.js`

**修改 (8 个)**:
- `backend/src/db/index.js`: +150 行 (3 表 + 10 prepared statements + 10 exports)
- `backend/src/app.js`: +60 行 (eval routes mount + feedback endpoint + imports)
- `backend/src/services/chat.js`: +25 行 (TraceCollector 集成)
- `backend/src/services/chatGraph.js`: +85 行 (createSSEEmitter 扩展 + TraceCollector 集成)
- `frontend/src/store/chatStore.js`: +50 行 (eval state + 4 actions)
- `frontend/src/App.jsx`: +2 行 (EvalDashboard import + render)
- `frontend/src/components/Sidebar.jsx`: +3 行 (评估按钮)
- `frontend/src/components/MessageItem.jsx`: +6 行 (EvalFeedback import + render)

## 回归测试
- 后端: 294 ✅ (新增 21: TraceCollector 28 + LLMJudge 14 + testCases 12, 比 Phase 4 的 245 多 49)
- 前端: 73 ✅ (不变)
- 总计: 367 测试全部通过

## BUG-MEM-01 状态
- 已通过 Reflection 循环间接修复 — 自我审查检测 missing_tool_call → 构建改进 prompt → 重新生成
- 生产路径需手动开启 `{reflect: true}`，不增加默认延迟

## 关联
- [[agent-upgrade-phase4]] — Phase 4 记忆与上下文工程
- [[agent-upgrade-phase3]] — Phase 3 MCP 协议升级
- [[agent-upgrade-known-bugs]] — BUG-MEM-01 已修复
- [[agent-upgrade-vision]] — 最终形态
