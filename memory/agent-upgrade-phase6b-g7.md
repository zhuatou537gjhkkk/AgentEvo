---
name: agent-upgrade-phase6b-g7
description: G7 评测集自动生成完成 — 生成→运行→编辑→审核→删除 全闭环 (2026-08-06)
metadata:
  type: project
---

# Phase 6b G7: 评测集自动生成 ✅

**完成日期**：2026-08-06

## 实际交付（超出原始"仅生成"范围）

1. **TestCaseGenerator** (`backend/src/eval/generator.js`, ~240行)
   - LLM 驱动：ChatOpenAI temp=0.7, maxTokens=8000
   - 8 类 CATEGORY_DEFAULTS 支持零种子生成
   - 三级 JSON 恢复链（直接 parse → 正则数组 → code block）
   - 已有用例 ID 去重提示

2. **eval_test_cases DB 表** (`backend/src/db/index.js`)
   - 字段：id, category, difficulty, description, input, expected_behavior, expected_tools, enable_web_search, code_checks, generated, reviewed, source_seeds, gen_batch_id
   - 7 prepared statements + 6 CRUD 函数

3. **5 API 端点** (`backend/src/eval/evalRoutes.js`)
   - POST /eval/generate, GET /eval/generated, PATCH /eval/generated/:id, DELETE /eval/generated/:id, POST /eval/generated/approve

4. **EvalRunner 桥接** (计划外)
   - `resolveTestCase()`: 硬编码 → DB fallback
   - `dbRowToTestCase()`: snake_case → camelCase
   - `/eval/run` 路由 ID 校验扩展
   - `/eval/report` 分类统计扩展

5. **GeneratorPanel** (`frontend/src/components/EvalDashboard.jsx`, ~250行)
   - 生成配置 + 用例列表 + inline 编辑 + 批量审核 + 逐条运行
   - 运行结果内联展示（5 维分数 + 延迟）

**Why:** 原始 G7 计划仅覆盖"生成→DB 存储"，但评测体系的价值在闭环——生成的用例必须能跑评估、能迭代优化。发现 3 个 gap 后全部补齐。

**How to apply:** G7 基础设施已就绪。后续 G8（评估任务对比）、G10（优化闭环流水线）可直接复用 eval_test_cases 表 + EvalRunner 桥接。

## 闭环验证结果

```
生成 → DB 存储 → ▶ 单条运行 → LLMJudge 5维评分
  → ✏️ 编辑 → 重跑 → ✅ 审核 → 🗑️ 删除
  → 离线评估 Tab → run 下拉可见 → 雷达图正确
```

## 相关文件

- [[agent-upgrade-phase6a]] — Phase 6a 前置依赖
- [[agent-upgrade-phase5]] — EvalRunner + LLMJudge 基础
- [[agent-upgrade-roadmap]] — 对应 Roadmap G7 条目
