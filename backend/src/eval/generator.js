/**
 * TestCaseGenerator — 评测集自动生成器
 *
 * Phase 6b G7：用户提供 1-3 条种子用例 → LLM 批量生成多样化测试用例。
 * 生成的用例写入 eval_test_cases 表（generated=true, reviewed=false），
 * 前端可逐条审核后参与 EvalRunner 评估。
 *
 * 用法：
 *   const gen = new TestCaseGenerator();
 *   const result = await gen.generate(seeds, { category: "web_search", count: 10 });
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildChatOpenAIConfig } from "../services/chatUtils.js";
import { insertGeneratedTestCase, getGeneratedTestCaseIds, getGeneratedTestCaseById } from "../db/index.js";

const GENERATOR_SYSTEM_PROMPT = `你是一个专业的AI测试用例设计师。你的任务是根据用户提供的种子用例，生成多样化的评测测试用例。

## 生成要求

1. **场景多样性**：覆盖种子分类下的不同子场景，不要和种子用例重复
2. **难度梯度**：按用户指定的配比生成 easy/medium/hard 三种难度
3. **边界覆盖**：约 10-20% 的用例应为边界/异常场景
4. **工具匹配**：expectedTools 必须准确反映该场景实际应该使用的工具
5. **语言一致**：输入的语种和种子保持一致
6. **描述清晰**：description 字段用中文简要描述测试目的（15字以内）

## expectedTools 参考

可用工具列表：
- web_search — 联网搜索（web_search 分类必用）
- search_knowledge_base — 知识库检索
- get_system_time — 获取系统时间
- memory — 存储/读取记忆
- (空数组) — 不需要工具调用的场景

## 输出格式

你必须只输出一个合法的 JSON 数组，不要有任何其他文字：

[
  {
    "category": "...",
    "difficulty": "easy|medium|hard",
    "description": "简短中文描述",
    "input": "用户消息",
    "expectedBehavior": "期望的AI行为描述",
    "expectedTools": ["tool_name"] 或 [],
    "enableWebSearch": true|false
  },
  ...
]

## 评分参考

- expectedBehavior 要具体：不要写"准确回答"，要写"准确回答北京，可附带简要说明"
- difficulty 判断标准：easy=单步直接回答, medium=需要些许推理, hard=多步推理或复杂场景
- 边界场景示例：空输入、超长输入、矛盾指令、敏感内容拒绝等

请开始生成。`;

const CATEGORY_DEFAULTS = {
    knowledge_qa: {
        tools: [],
        enableWebSearch: false,
        description: "知识问答 — 基于模型内建知识直接回答",
    },
    web_search: {
        tools: ["web_search"],
        enableWebSearch: true,
        description: "联网搜索 — 需要实时信息或最新数据",
    },
    multi_step: {
        tools: [],
        enableWebSearch: false,
        description: "多步推理 — 需要分步骤的逻辑推理或计算",
    },
    memory_recall: {
        tools: ["memory"],
        enableWebSearch: false,
        description: "记忆召回 — 存储/检索/巩固用户偏好信息",
    },
    code_generation: {
        tools: [],
        enableWebSearch: false,
        description: "代码生成 — 编写/审查/解释代码",
    },
    creative: {
        tools: [],
        enableWebSearch: false,
        description: "创意任务 — 写作/命名/翻译/头脑风暴",
    },
    tool_selection: {
        tools: [],
        enableWebSearch: false,
        description: "工具选择 — 测试Agent是否正确选择/避免工具",
    },
    edge_case: {
        tools: [],
        enableWebSearch: false,
        description: "边界场景 — 异常输入/极端情况",
    },
};

class TestCaseGenerator {
    constructor(options = {}) {
        const config = buildChatOpenAIConfig();
        this.llm = new ChatOpenAI({
            ...config,
            model: options.model || process.env.OPENAI_MODEL || "deepseek-v4-flash",
            temperature: 0.7,
            maxTokens: 8000,
        });
    }

    /**
     * 从种子用例生成多样化测试用例
     *
     * @param {object[]} seeds — 1-3 条种子用例（完整的 testCase 对象）
     * @param {object} options
     * @param {string} options.category — 目标分类（默认继承第一个种子的分类）
     * @param {number} options.count — 生成数量（1-50，默认 10）
     * @param {object} options.difficultyMix — {easy:n, medium:n, hard:n}（默认 3:5:2）
     * @returns {Promise<{ok: boolean, generated: object[], batchId: string, count: number, error?: string}>}
     */
    async generate(seeds = [], options = {}) {
        // ── 参数校验 ──
        if (!Array.isArray(seeds) || seeds.length === 0) {
            // 无种子时根据 category 使用内置模板
            const category = options.category || "knowledge_qa";
            if (!CATEGORY_DEFAULTS[category]) {
                return { ok: false, generated: [], batchId: "", count: 0, error: `未知分类: ${category}` };
            }
            seeds = [{
                category,
                difficulty: "medium",
                input: `（${CATEGORY_DEFAULTS[category].description}的通用查询）`,
                expectedBehavior: "根据用户查询提供准确回答",
                expectedTools: CATEGORY_DEFAULTS[category].tools,
                enableWebSearch: CATEGORY_DEFAULTS[category].enableWebSearch,
            }];
        }

        if (seeds.length > 3) {
            seeds = seeds.slice(0, 3);
        }

        const category = options.category || seeds[0].category || "knowledge_qa";
        const count = Math.min(50, Math.max(1, options.count || 10));
        const difficultyMix = options.difficultyMix || { easy: Math.round(count * 0.3), medium: Math.round(count * 0.5), hard: Math.round(count * 0.2) };

        // ── 构建种子描述 ──
        const seedBlock = seeds.map((s, i) =>
            `[种子${i + 1}]
分类: ${s.category}
难度: ${s.difficulty}
描述: ${s.description || ""}
输入: ${s.input}
期望行为: ${s.expectedBehavior || ""}
期望工具: ${JSON.stringify(s.expectedTools || [])}
联网: ${s.enableWebSearch ? "是" : "否"}`
        ).join("\n\n");

        // ── 获取已有用例 ID 用于去重 ──
        const existingIds = getGeneratedTestCaseIds({ category });
        const existingHint = existingIds.length > 0
            ? `\n\n## 注意：以下已有用例 ID 请勿重复生成类似场景\n${existingIds.slice(0, 20).join(", ")}`
            : "";

        // ── 构建用户 Prompt ──
        const userPrompt = `## 种子用例
${seedBlock}

## 生成参数
- 目标分类: ${category}
- 生成数量: ${count} 条
- 难度配比: easy=${difficultyMix.easy || 0}, medium=${difficultyMix.medium || 0}, hard=${difficultyMix.hard || 0}${existingHint}

请生成 ${count} 条多样化的 "${category}" 分类测试用例。直接输出 JSON 数组。`;

        // ── 调用 LLM ──
        console.log(`[TestCaseGenerator] 🚀 开始生成: category=${category}, count=${count}, seeds=${seeds.filter(s => s.id).length || "(内置模板)"}`);
        let content;
        try {
            const response = await this.llm.invoke([
                new SystemMessage(GENERATOR_SYSTEM_PROMPT),
                new HumanMessage(userPrompt),
            ]);
            content = typeof response.content === "string"
                ? response.content
                : (Array.isArray(response.content) ? response.content.map(c => c.text).join("") : "");
        } catch (err) {
            console.error("[TestCaseGenerator] LLM call failed:", err.message);
            return { ok: false, generated: [], batchId: "", count: 0, error: `LLM调用失败: ${err.message}` };
        }

        // ── 解析 JSON ──
        const parsed = this._parseResponse(content);
        if (!parsed || parsed.length === 0) {
            console.error("[TestCaseGenerator] failed to parse LLM output:", content.slice(0, 500));
            return { ok: false, generated: [], batchId: "", count: 0, error: "LLM 输出解析失败，未获得有效 JSON 数组" };
        }

        // ── 分配 ID + 写入 DB ──
        const batchId = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const seedIds = seeds.map(s => s.id || "").filter(Boolean);
        let seq = 0;
        const generated = [];

        for (const item of parsed.slice(0, count)) {
            seq++;
            const id = `gen_${category}_${String(seq).padStart(3, "0")}`;

            // 避免 ID 冲突 — 检查 DB 中是否已存在
            const existing = this._idExists(id);
            if (existing) {
                // 尝试加后缀
                const altId = `gen_${category}_${String(seq).padStart(3, "0")}_${Date.now().toString(36).slice(-4)}`;
                const tc = this._buildTestCase(altId, category, item, seedIds, batchId);
                insertGeneratedTestCase(tc);
                generated.push(tc);
            } else {
                const tc = this._buildTestCase(id, category, item, seedIds, batchId);
                insertGeneratedTestCase(tc);
                generated.push(tc);
            }
        }

        console.log(`[TestCaseGenerator] ✅ 生成了 ${generated.length} 条用例 (batch: ${batchId}, category: ${category})`);

        return {
            ok: true,
            generated: generated.map(tc => ({
                id: tc.id,
                category: tc.category,
                difficulty: tc.difficulty,
                description: tc.description,
                input: tc.input,
                expectedBehavior: tc.expectedBehavior,
                expectedTools: tc.expectedTools,
                enableWebSearch: tc.enableWebSearch,
                reviewed: false,
            })),
            batchId,
            count: generated.length,
        };
    }

    // ── Private helpers ──

    /**
     * 解析 LLM 输出为 JSON 数组（三级恢复链，与 LLMJudge 对齐）
     */
    _parseResponse(content) {
        if (!content || content.trim().length === 0) return null;

        try {
            const parsed = JSON.parse(content.trim());
            if (Array.isArray(parsed)) return parsed;
            // 有些模型可能返回 {testCases: [...]}
            if (parsed && Array.isArray(parsed.testCases)) return parsed.testCases;
            if (parsed && Array.isArray(parsed.cases)) return parsed.cases;
            return null;
        } catch {
            // 尝试提取 JSON 数组
            const arrMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (arrMatch) {
                try {
                    const parsed = JSON.parse(arrMatch[0]);
                    if (Array.isArray(parsed)) return parsed;
                } catch { /* continue */ }
            }
            // 尝试提取 JSON 块 (```json ... ```)
            const blockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (blockMatch) {
                try {
                    const parsed = JSON.parse(blockMatch[1].trim());
                    if (Array.isArray(parsed)) return parsed;
                } catch { /* continue */ }
            }
            return null;
        }
    }

    /**
     * 将 LLM 返回的原始 item 构建为完整的 test case 对象
     */
    _buildTestCase(id, category, item, seedIds, batchId) {
        const diffs = ["easy", "medium", "hard"];
        return {
            id,
            category: item.category || category,
            difficulty: diffs.includes(item.difficulty) ? item.difficulty : "medium",
            description: (item.description || "").slice(0, 100),
            input: item.input || "",
            expectedBehavior: item.expectedBehavior || "",
            expectedTools: Array.isArray(item.expectedTools) ? item.expectedTools : [],
            enableWebSearch: item.enableWebSearch === true || item.enableWebSearch === "true" ? 1 : 0,
            codeChecks: Array.isArray(item.codeChecks) ? item.codeChecks : null,
            generated: 1,
            reviewed: 0,
            sourceSeeds: seedIds,
            genBatchId: batchId,
        };
    }

    /**
     * 检查 DB 中是否已存在该 ID
     */
    _idExists(id) {
        return getGeneratedTestCaseById(id) !== null;
    }
}

export { TestCaseGenerator, CATEGORY_DEFAULTS };
