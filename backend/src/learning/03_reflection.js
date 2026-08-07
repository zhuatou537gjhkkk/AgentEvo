/**
 * 🧪 练习 3：从零实现 Reflection (自审循环)
 *
 * 对应 Hello-Agents: chapter4/Reflection.py + chapter7 (MyReflectionAgent)
 * 对应 AgentEvo:    完全没有 (chat.js 输出完直接 res.end)
 *
 * 目标：理解 Actor → Critic → Refiner 迭代模式
 *
 * 运行: node src/learning/03_reflection.js
 */

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";

// ═══════════════════════════════════════════════════════
// 知识点 1: Memory — 记录执行轨迹
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 的 Memory 类:
//   - add_record(type, content) — 记录每次执行/反思
//   - get_trajectory()          — 格式化为完整轨迹文本
//   - get_last_execution()      — 获取最近一次执行结果
//
// 这不是 Phase 4 的三层记忆系统，而是 Reflection 循环的内部记账。
// 每一次 Actor 输出 → 一条 execution 记录
// 每一次 Critic 反馈 → 一条 reflection 记录

class Memory {
    constructor() {
        this.records = [];
    }

    add(type, content) {
        this.records.push({ type, content });
        console.log(`📝 记忆: +1 ${type}`);
    }

    getLast(type) {
        for (let i = this.records.length - 1; i >= 0; i--) {
            if (this.records[i].type === type) return this.records[i].content;
        }
        return null;
    }

    getTrajectory() {
        return this.records.map(r => {
            if (r.type === "execution") return `--- 上一轮输出 ---\n${r.content}`;
            if (r.type === "reflection") return `--- 评审反馈 ---\n${r.content}`;
            return r.content;
        }).join("\n\n");
    }
}


// ═══════════════════════════════════════════════════════
// 知识点 2: 三个角色的 Prompt
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 的三个 Prompt (三个独立 LLM 调用):
//   INITIAL_PROMPT  → Actor: "生成初版代码"
//   REFLECT_PROMPT  → Critic: "审查代码效率"
//   REFINE_PROMPT   → Refiner: "根据反馈优化"

const ACTOR_PROMPT = `你是一位 Python 程序员。请根据要求编写代码。

要求: {task}

请直接输出完整的 Python 代码，包含函数签名和文档字符串。不要输出多余的解释。`;

const CRITIC_PROMPT = `你是一位严格的代码审查专家。请审查以下代码。

## 原始任务
{task}

## 待审查代码
{content}

请分析:
1. 代码是否正确完成任务
2. 算法效率是否有优化空间
3. 代码风格是否规范

如果代码已经足够好，请回复"无需改进"。
否则，请具体指出问题并给出改进建议。`;

const REFINER_PROMPT = `你是一位 Python 程序员。请根据审查反馈优化代码。

## 原始任务
{task}

## 当前代码
{content}

## 审查反馈
{feedback}

请输出优化后的完整代码。只输出代码，不要输出解释。`;


// ═══════════════════════════════════════════════════════
// 知识点 3: Reflection 循环 — 核心引擎
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 循环结构:
//   1. Actor: llm.think(INITIAL_PROMPT) → 初版代码
//   2. for i in range(max_iterations):
//      a. Critic: llm.think(REFLECT_PROMPT + code) → feedback
//      b. 如果 "无需改进" → 停止
//      c. Refiner: llm.think(REFINE_PROMPT + code + feedback) → 优化代码
//      d. 记录到 Memory
//   → 返回最终代码
//
// AgentEvo 缺失的:
//   - chat.js 没有 Critic 调用
//   - chat.js 没有 Refiner 调用
//   - 输出完直接 res.end()

async function reflectionLoop(llm, task, maxIterations = 2) {
    const memory = new Memory();

    // === Phase 1: 初始生成 (Actor) ===
    console.log("\n🎭 Actor: 初始生成...");
    let currentCode = await llm.invoke([{
        role: "user", content: ACTOR_PROMPT.replace("{task}", task)
    }]);
    currentCode = extractText(currentCode);
    memory.add("execution", currentCode);
    console.log(`📝 初版代码 (${currentCode.length} 字符)`);

    // === Phase 2: 迭代反思 (Critic → Refiner) ===
    for (let i = 0; i < maxIterations; i++) {
        console.log(`\n--- 第 ${i + 1}/${maxIterations} 轮 ---`);

        // 2a. Critic 审查
        console.log("🔍 Critic: 审查中...");
        const criticPrompt = CRITIC_PROMPT
            .replace("{task}", task)
            .replace("{content}", currentCode);
        let feedback = await llm.invoke([{ role: "user", content: criticPrompt }]);
        feedback = extractText(feedback);
        memory.add("reflection", feedback);
        console.log(`📋 反馈: ${feedback.slice(0, 150)}...`);

        // 2b. 终止条件
        if (feedback.includes("无需改进") || feedback.includes("no improvement needed")) {
            console.log("✅ Critic 认为已无需改进，停止迭代");
            break;
        }

        // 2c. Refiner 优化
        console.log("🔧 Refiner: 优化中...");
        const refinePrompt = REFINER_PROMPT
            .replace("{task}", task)
            .replace("{content}", currentCode)
            .replace("{feedback}", feedback);
        let refined = await llm.invoke([{ role: "user", content: refinePrompt }]);
        currentCode = extractText(refined);
        memory.add("execution", currentCode);
        console.log(`📝 优化后代码 (${currentCode.length} 字符)`);
    }

    // === 最终结果 ===
    console.log("\n--- 执行轨迹 ---");
    console.log(memory.getTrajectory());
    console.log("\n--- 最终代码 ---");
    console.log(currentCode);

    return { finalCode: currentCode, trajectory: memory.getTrajectory() };
}


// ═══════════════════════════════════════════════════════
// 知识点 4: 对比 — AgentEvo 需要加什么
// ═══════════════════════════════════════════════════════
//
// AgentEvo chat.js 当前流程:
//   用户输入 → AgentExecutor → SSE stream → res.end()
//
// 加入 Reflection 后:
//   用户输入 → ReAct 循环 → 初版答案
//            → Critic 审查 → 发现问题
//              ├─ "无需改进" → 输出答案
//              └─ 有问题 → Refiner 重新生成 → 回到 Critic
//
// 改造关键:
//   1. chatWithStream 中 Agent 输出完成后不立即 res.end()
//   2. 调一次 Critic prompt 审查答案质量
//   3. 如果反馈指出问题，调 Refiner prompt 重新生成
//   4. 最多迭代 N 轮（防止无限循环 + Token 消耗过大）
//   5. 将 Reflection 过程也通过 SSE 发射给前端展示
//
// 新增 SSE 事件:
//   - type: "reflection_start" → 开始自审
//   - type: "reflection_feedback" → 审查反馈
//   - type: "reflection_refine" → 正在优化
//   - type: "reflection_end" → 自审完成


// ═══════════════════════════════════════════════════════
// 知识点 5: Reflection vs Plan-and-Solve 的区别
// ═══════════════════════════════════════════════════════
//
// Plan-and-Solve: 先拆解再执行 (Planning → Execution)
//   — 适用于: 已知该如何做，但步骤多
//   — 如: 研究量子计算在药物研发中的应用 (先搜索再整理再写报告)
//
// Reflection: 先做再审查再优化 (Act → Critique → Refine)
//   — 适用于: 需要高质量输出，能自我纠正
//   — 如: 写代码 (生成 → 审查效率 → 优化)
//   — 如: 写长文 (初稿 → 审查逻辑 → 润色)
//
// 两者不互斥! 可以先 Plan-Solve 拆解，然后对每个步骤的产出做 Reflection。


// ── Helper ─────────────────────────────────────────────

function extractText(response) {
    if (typeof response === "string") return response;
    return response?.content || response?.content?.text || "";
}

// ═══════════════════════════════════════════════════════
// 运行 (由于需要多次 LLM 调用，时间比 ReAct 更长)
// ═══════════════════════════════════════════════════════

async function main() {
    const llm = new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL || process.env.QWEN_MODEL || "deepseek-v4-flash",
        temperature: 0.3,
        configuration: { baseURL: process.env.OPENAI_BASE_URL },
    });

    const task = "编写一个 Python 函数，找出 1 到 n 之间的所有素数";

    console.log(`\n📝 任务: ${task}`);
    console.log("=".repeat(50));

    const result = await reflectionLoop(llm, task, 2);

    console.log(`\n✅ 完成! 共 ${result.trajectory.split("\n").length} 行执行轨迹`);
}

main().catch(console.error);
