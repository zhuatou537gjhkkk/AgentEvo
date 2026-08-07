/**
 * 🧪 练习 2：从零实现 Plan-and-Solve (架构级分离)
 *
 * 对应 Hello-Agents: chapter4/Plan_and_solve.py
 * 对应 AgentEvo:    chat.js 的 Plan 模式 (PLAN_MODE_INSTRUCTION + update_todo)
 *
 * 目标：理解 "prompt suggestion" vs "架构分离" 的本质区别
 *
 * 运行: node src/learning/02_plan_and_solve.js
 */

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";

// ═══════════════════════════════════════════════════════
// 知识点 1: Planner — 独立的 LLM 调用，只做计划
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 的 Planner:
//   - 独立的 PLANNER_PROMPT_TEMPLATE（聚焦于"拆解"）
//   - ast.literal_eval 解析 LLM 输出的 Python 列表
//   - 返回结构化的计划: ["步骤1", "步骤2", "步骤3"]
//
// AgentEvo 当前做法:
//   - chat.js:22-23 PLAN_MODE_INSTRUCTION 塞进 System Prompt
//   - 同一个 LLM 在 ReAct 循环中"顺便"调 update_todo
//   - 没有独立的 Planner 调用
//
// ⚠️ 核心差距: 同一个 LLM 边想边做 vs 先规划再执行

const PLANNER_PROMPT = `你是一个任务规划专家。你的唯一工作是：将复杂问题分解为可执行的步骤列表。

规则:
1. 每个步骤必须是一个独立的、可执行的任务
2. 步骤按逻辑顺序排列
3. 输出必须是纯 JSON 数组，不要有任何额外文本

问题: {question}

请输出计划 (纯 JSON 数组):`;

async function planner(llm, question) {
    console.log(`\n📋 Planner 工作中...`);
    const response = await llm.invoke([{
        role: "user",
        content: PLANNER_PROMPT.replace("{question}", question)
    }]);

    const text = typeof response.content === "string"
        ? response.content
        : response.content?.text || "";

    console.log(`📋 Planner 原始输出:\n${text}`);

    // 解析 JSON 数组 (Hello-Agents 用 ast.literal_eval)
    try {
        // 尝试提取 JSON 数组
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const plan = JSON.parse(jsonMatch[0]);
            if (Array.isArray(plan)) {
                console.log(`✅ 计划: ${JSON.stringify(plan, null, 2)}`);
                return plan;
            }
        }
    } catch {
        console.log("⚠️ 计划解析失败，用 fallback");
    }
    return ["分析问题", "收集信息", "给出答案"];
}


// ═══════════════════════════════════════════════════════
// 知识点 2: Executor — 另一个独立的 LLM 调用，只做执行
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 的 Executor:
//   - 每步一个独立的 LLM 调用
//   - 能看到"前面步骤的结果" (history)
//   - 专注于当前这一个步骤
//
// AgentEvo 当前:
//   - 同一个 ReAct 循环，没有"步骤边界"
//   - Agent 可能在执行一半时"忘记"计划

const EXECUTOR_PROMPT = `你是一个任务执行专家。你现在要执行计划中的一个步骤。

## 完整计划
{plan}

## 已完成的步骤及结果
{history}

## 当前要执行的步骤
{current_step}

请执行这个步骤并给出结果。只输出这个步骤的答案，不要输出计划中的其他步骤。`;

async function executor(llm, question, plan) {
    const history = [];
    let finalAnswer = "";

    console.log(`\n⚡ Executor 开始执行 (共 ${plan.length} 步)...`);

    for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        console.log(`\n⚡ 步骤 ${i + 1}/${plan.length}: "${step}"`);

        const prompt = EXECUTOR_PROMPT
            .replace("{plan}", plan.map((s, j) => `${j + 1}. ${s}`).join("\n"))
            .replace("{history}", history.join("\n") || "(尚无历史)")
            .replace("{current_step}", step);

        const response = await llm.invoke([{ role: "user", content: prompt }]);
        const result = typeof response.content === "string"
            ? response.content
            : response.content?.text || "";

        console.log(`✅ 步骤 ${i + 1} 结果: ${result.slice(0, 100)}...`);

        history.push(`步骤 ${i + 1} "${step}" → ${result}`);
        finalAnswer = result; // 最后一步的结果就是最终答案
    }

    return finalAnswer;
}


// ═══════════════════════════════════════════════════════
// 知识点 3: 对比 — prompt-level vs architecture-level
// ═══════════════════════════════════════════════════════
//
// AgentEvo 当前 (prompt-level):
//
//   buildPrompt(planMode=true)
//     → 注入 PLAN_MODE_INSTRUCTION: "你必须先调用 update_todo..."
//     → 同一个 LLM 调用来决定要不要做计划
//     → Agent 可能遵循，也可能忽略
//
// Hello-Agents (architecture-level):
//
//   Planner LLM (prompt 专为规划设计)
//     → 输出结构化计划
//     → ↓
//   Executor LLM (prompt 专为执行设计, 逐步骤)
//     → 第1步调 LLM → 第2步调 LLM → ...
//     → 每步都能看到前面步骤的结果
//
// ┌─────────────────────┬──────────────────────┬──────────────────────┐
// │ 维度                │ AgentEvo (prompt)     │ Hello-Agents (架构)  │
// ├─────────────────────┼──────────────────────┼──────────────────────┤
// │ Planner Prompt      │ 一句话混在 System    │ 独立模板，精细控制   │
// │ Planner LLM         │ 和 Executor 共用一个 │ 独立调用             │
// │ 计划必须被遵循?     │ ❌ "建议"            │ ✅ 架构强制          │
// │ 步骤级可见性        │ ❌ ReAct 循环内混在一起│ ✅ 每步看到历史    │
// │ 可中断/恢复         │ ✅ TaskProgressCard  │ ❌ 无前端            │
// └─────────────────────┴──────────────────────┴──────────────────────┘


// ═══════════════════════════════════════════════════════
// 知识点 4: AgentEvo 改造的关键洞察
// ═══════════════════════════════════════════════════════
//
// 你不需要完全替换现有 System Prompt。
// 你需要的是:
//
//   当前: LLM (ReAct循环, 顺便列计划)
//            ↓
//   改造: Planner LLM → [计划] → Executor (ReAct循环, 逐步骤)
//
// 改造后 Plan 模式的 chatWithStream 流程:
//
//   1. Planner LLM 调一次 → 生成计划列表
//   2. 发射 todo_updated SSE 事件（前端 TaskProgressCard 展示）
//   3. 对每个计划步骤:
//      a. 构建步骤上下文（原始问题 + 计划 + 前面步骤结果）
//      b. AgentExecutor.streamEvents() 执行这一步
//      c. 发射 todo_updated（标记完成）
//   4. Synthesizer LLM → 汇总所有步骤结果 → 输出最终答案
//
// 这就是 Phase 2 的核心改造。
// 你已有的 update_todo + TaskProgressCard 可以无缝融入这个架构。


// ═══════════════════════════════════════════════════════
// 运行演示: 解决一个需要多步骤推理的问题
// ═══════════════════════════════════════════════════════

async function main() {
    const llm = new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL || process.env.QWEN_MODEL || "deepseek-v4-flash",
        temperature: 0,
        configuration: { baseURL: process.env.OPENAI_BASE_URL },
    });

    const question = "一个水果店周一卖出了15个苹果。周二卖出的苹果数量是周一的两倍。周三卖出的数量比周二少了5个。请问这三天总共卖出了多少个苹果？";

    console.log(`\n❓ 问题: ${question}`);

    // Phase 1: Planner 生成计划
    const plan = await planner(llm, question);

    if (plan.length === 0) {
        console.log("无法生成计划，退出");
        return;
    }

    // Phase 2: Executor 逐步执行
    const answer = await executor(llm, question, plan);

    console.log(`\n🎉 最终答案: ${answer}`);
    console.log("\n---");
    console.log("对比: AgentEvo 当前用 planMode 开关 → 在 System Prompt 加一句话");
    console.log("      本演示 → Planner 和 Executor 是两个完全独立的 LLM 调用");
    console.log("      Phase 2 目标: 把这种架构分离引入 chatWithStream()");
}

main().catch(console.error);
