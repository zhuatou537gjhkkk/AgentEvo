/**
 * OptimizationPipeline — G10 优化闭环流水线
 *
 * Phase 6c 核心：对接 AgentArts 观测→评估→优化三层架构。
 *
 * 六步闭环：
 *   Step ① analyze()   → 识别 BadCase（低分测试用例）
 *   Step ② classify()  → 根因分类（哪个维度拖后腿）
 *   Step ③ suggest()   → LLM 生成优化建议（修改哪个配置）
 *   Step ④ apply()     → 应用配置变更 + 快照 + 日志
 *   Step ⑤ reevaluate()→ 用新配置重跑评估
 *   Step ⑥ compare()   → 对比优化前后分数
 *
 * 复用基础设施：
 *   - EvalRunner.run()      → 重评引擎
 *   - LLMJudge               → 评分基准（analyze 读取已有分数）
 *   - agentConfig.setBatch() → 配置应用
 *   - agentConfig.snapshot() → 版本快照
 *   - POST /eval/compare     → 前后对比
 *   - optimization_log 表    → 审计追溯
 *
 * 用法：
 *   const pipeline = new OptimizationPipeline();
 *   const badCases = await pipeline.analyze("eval-20260807-abc");
 *   const suggestions = await pipeline.suggest("eval-20260807-abc", badCases);
 *   const result = await pipeline.apply("eval-20260807-abc", selectedChanges, "fix label");
 *   const newRunId = await pipeline.reevaluate(result.logId, testCaseIds);
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildChatOpenAIConfig } from "./chatUtils.js";
import {
    getScoresByRun,
    saveOptimizationLog,
    getOptimizationLogs,
    getOptimizationLogById,
    updateOptimizationLog,
} from "../db/index.js";
import { agentConfig, DEFAULTS } from "./agentConfig.js";
import { getRunSummary } from "../eval/metrics.js";
import { testCases, getTestCaseById } from "../eval/testCases.js";
import { getGeneratedTestCaseById } from "../db/index.js";

// ── 常量 ──

/** BadCase 判定阈值：加权平均分低于此值即为 BadCase */
const BAD_CASE_THRESHOLD = 3.0;

/** LLM 建议的 system prompt */
const SUGGEST_SYSTEM_PROMPT = `你是一个 Agent 系统优化专家。你的任务是分析 Agent 在评估中表现不佳的测试用例，并给出具体的配置优化建议。

## 可优化的配置项

以下是系统中可以被修改的 Agent 配置（key → 当前值）：

{tool_descriptions}

{agent_instructions}

{memory_params}

## 输出格式

你必须只输出一个合法的 JSON 对象，不要有任何其他文字：

{
  "suggestions": [
    {
      "configKey": "agent.knowledge.instruction",
      "currentValue": "...",
      "suggestedValue": "...",
      "confidence": 0.85,
      "rationale": "当前 agent 在知识库问题上倾向于概括而非逐条列出，导致遗漏关键信息"
    }
  ],
  "summary": "一句话总结本次优化的核心问题和修改方向"
}

## 要求
- 每个 suggestion 必须对应一个真实存在的配置 key
- suggestedValue 必须具体、可执行，不能是泛泛的"改进"
- confidence 表示你对这个建议能改善分数的信心(0-1)
- 只建议真正可能导致问题的配置，不要为了凑数而给无关的建议
- 如果某个 BadCase 的根因不是配置问题（如模型能力限制），可以不针对它给建议`;

class OptimizationPipeline {
    constructor(options = {}) {
        this.llm = new ChatOpenAI({
            ...buildChatOpenAIConfig(),
            model: options.model || process.env.OPENAI_MODEL || "deepseek-v4-flash",
            temperature: 0.3,
            maxTokens: 4000,
        });
    }

    /**
     * Step ①+②: 分析 BadCase + 根因分类
     *
     * 从 run 的评分数据中找出低分测试用例，并按最低维度分类根因。
     *
     * @param {string} runId — 评估 run ID
     * @returns {Promise<{runId: string, badCases: object[], summary: object}>}
     */
    async analyze(runId) {
        const rows = getScoresByRun(runId);
        if (!rows || rows.length === 0) {
            return { runId, badCases: [], summary: { total: 0, badCount: 0, byRootCause: {} } };
        }

        // 按 test_case_id 分组
        const byTestCase = {};
        for (const row of rows) {
            if (!byTestCase[row.test_case_id]) {
                byTestCase[row.test_case_id] = {};
            }
            byTestCase[row.test_case_id][row.dimension] = {
                score: row.score,
                rationale: row.judge_rationale || "",
            };
        }

        // 计算每个用例的加权平均分
        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
        const weights = { correctness: 0.35, tool_usage: 0.2, tool_quality: 0.15, conciseness: 0.1, safety: 0.2 };

        const casesWithScores = Object.entries(byTestCase).map(([tcId, dimScores]) => {
            let weightedSum = 0;
            const scores = {};
            for (const dim of dims) {
                const s = dimScores[dim]?.score || 0;
                scores[dim] = s;
                weightedSum += s * (weights[dim] || 0.2);
            }
            return { testCaseId: tcId, scores, weightedAvg: Math.round(weightedSum * 100) / 100 };
        });

        // 筛选 BadCase
        const badCases = casesWithScores
            .filter(c => c.weightedAvg < BAD_CASE_THRESHOLD)
            .sort((a, b) => a.weightedAvg - b.weightedAvg);

        // 根因分类：取最低的维度作为根因
        const byRootCause = {};
        for (const bc of badCases) {
            let minDim = "correctness";
            let minScore = Infinity;
            for (const dim of dims) {
                if (bc.scores[dim] < minScore) {
                    minScore = bc.scores[dim];
                    minDim = dim;
                }
            }
            bc.rootCause = minDim;
            if (!byRootCause[minDim]) byRootCause[minDim] = [];
            byRootCause[minDim].push(bc);

            // 丰富：附加测试用例描述信息
            const tc = getTestCaseById(bc.testCaseId) || getGeneratedTestCaseById(bc.testCaseId);
            if (tc) {
                bc.category = tc.category || "unknown";
                bc.description = tc.description || tc.input || "";
                bc.input = tc.input || "";
            }
        }

        return {
            runId,
            badCases,
            summary: {
                total: casesWithScores.length,
                badCount: badCases.length,
                avgWeightedScore: casesWithScores.length > 0
                    ? Math.round(casesWithScores.reduce((s, c) => s + c.weightedAvg, 0) / casesWithScores.length * 100) / 100
                    : 0,
                byRootCause: Object.fromEntries(
                    Object.entries(byRootCause).map(([k, v]) => [k, v.length])
                ),
            },
        };
    }

    /**
     * Step ③: LLM 生成优化建议
     *
     * 分析 BadCase 的输出 + 当前 agentConfig，建议具体的配置修改。
     *
     * @param {string} runId — 评估 run ID
     * @param {object[]} badCases — analyze() 返回的 badCases 数组
     * @returns {Promise<{suggestions: object[], summary: string, rawResponse: string}>}
     */
    async suggest(runId, badCases) {
        if (!badCases || badCases.length === 0) {
            return { suggestions: [], summary: "没有需要优化的 BadCase", rawResponse: "" };
        }

        // 获取当前的 agentConfig
        const currentConfig = agentConfig.snapshot();

        // 构建可配置项描述
        const toolKeys = Object.keys(DEFAULTS).filter(k => k.startsWith("tool."));
        const agentKeys = Object.keys(DEFAULTS).filter(k => k.startsWith("agent."));
        const memoryKeys = Object.keys(DEFAULTS).filter(k => k.startsWith("memory."));

        const toolBlock = toolKeys.map(k =>
            `  - \`${k}\`: "${currentConfig[k] || DEFAULTS[k] || ""}"`
        ).join("\n");

        const agentBlock = agentKeys.map(k =>
            `  - \`${k}\`: "${(currentConfig[k] || DEFAULTS[k] || "").slice(0, 200)}"`
        ).join("\n");

        const memoryBlock = memoryKeys.map(k =>
            `  - \`${k}\`: "${currentConfig[k] || DEFAULTS[k] || ""}"`
        ).join("\n");

        // 构建 BadCase 描述
        const badCaseDescriptions = badCases.slice(0, 10).map((bc, i) => {
            const dimDetails = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"]
                .map(d => `  ${d}: ${bc.scores?.[d] || "N/A"}`)
                .join("\n");
            return `### BadCase #${i + 1}: ${bc.testCaseId}
- 分类: ${bc.category || "unknown"}
- 描述: ${bc.description || bc.input || "无描述"}
- 根因维度: ${bc.rootCause || "unknown"}
- 加权平均分: ${bc.weightedAvg}
- 各维度分数:
${dimDetails}`;
        }).join("\n\n");

        const systemPrompt = SUGGEST_SYSTEM_PROMPT
            .replace("{tool_descriptions}", toolBlock)
            .replace("{agent_instructions}", agentBlock)
            .replace("{memory_params}", memoryBlock);

        const userPrompt = `## 评估 Run: ${runId}

## BadCase 列表（共 ${badCases.length} 个，展示前 10 个）

${badCaseDescriptions}

请分析这些 BadCase 的根因，并给出具体的配置优化建议。只输出 JSON。`;

        let rawResponse = "";
        try {
            const response = await this.llm.invoke([
                new SystemMessage(systemPrompt),
                new HumanMessage(userPrompt),
            ]);

            rawResponse = typeof response.content === "string"
                ? response.content
                : (Array.isArray(response.content) ? response.content.map(c => c.text).join("") : "");

            const parsed = this._parseSuggestions(rawResponse);
            return { ...parsed, rawResponse };
        } catch (err) {
            console.error("[OptimizationPipeline] suggest failed:", err.message);
            return {
                suggestions: [],
                summary: `LLM 建议生成失败: ${err.message}`,
                rawResponse,
            };
        }
    }

    /**
     * Step ④: 应用优化变更
     *
     * 将用户选中的建议应用到 agentConfig，创建快照，记录优化日志。
     *
     * @param {string} sourceRunId — 触发优化的评估 run ID
     * @param {object[]} changes — 要应用的变更 [{key, value}, ...]
     * @param {object[]} suggestions — 完整的建议列表（用于日志记录）
     * @param {string[]} badCaseIds — 相关的 BadCase ID 列表
     * @param {object} scoreBefore — 优化前分数快照
     * @param {string} label — 本次优化的标签
     * @returns {Promise<{ok: boolean, logId: number, configVersionId: number}>}
     */
    async apply(sourceRunId, changes, suggestions = [], badCaseIds = [], scoreBefore = null, label = "") {
        if (!changes || changes.length === 0) {
            return { ok: false, logId: null, configVersionId: null, error: "没有要应用的变更" };
        }

        try {
            // 1. 应用配置变更（skipSnapshot=true，统一在下面做快照）
            const applyResult = agentConfig.setBatch(changes, true);
            if (applyResult.ok === 0) {
                return { ok: false, logId: null, configVersionId: null, error: "所有配置变更均失败" };
            }

            // 2. 创建版本快照
            const snap = agentConfig.snapshot();
            const { saveConfigSnapshot } = await import("../db/index.js");
            const configVersionId = saveConfigSnapshot(snap, "optimization");

            // 3. 保存优化日志
            const logId = saveOptimizationLog({
                sourceRunId,
                configVersionId,
                label: label || `优化 ${new Date().toLocaleDateString("zh-CN")}`,
                badCaseIds,
                changes,
                suggestions,
                scoreBefore,
                scoreAfter: null,
                status: "applied",
            });

            return { ok: true, logId, configVersionId };
        } catch (err) {
            console.error("[OptimizationPipeline] apply failed:", err.message);
            return { ok: false, logId: null, configVersionId: null, error: err.message };
        }
    }

    /**
     * Step ⑤: 重评验证
     *
     * 用新配置重新评估相同的测试用例。
     *
     * @param {number} optimizationLogId — 优化日志 ID
     * @param {string[]} testCaseIds — 要重评的测试用例 ID 列表
     * @returns {Promise<{ok: boolean, newRunId: string, logId: number}>}
     */
    async reevaluate(optimizationLogId, testCaseIds) {
        if (!testCaseIds || testCaseIds.length === 0) {
            return { ok: false, newRunId: null, logId: optimizationLogId, error: "没有测试用例" };
        }

        try {
            // 获取优化日志，拿到 source run
            const log = getOptimizationLogById(optimizationLogId);
            if (!log) {
                return { ok: false, newRunId: null, logId: optimizationLogId, error: "优化日志不存在" };
            }

            // G10 fix: 预检查哪些 ID 能解析为有效测试用例，避免 EvalRunner 静默回退到全量
            const { testCases: allTestCases, getTestCaseById: resolveById } = await import("../eval/testCases.js");
            const validIds = [];
            const invalidIds = [];
            for (const id of testCaseIds) {
                const hardcoded = resolveById(id);
                const generated = getGeneratedTestCaseById(id);
                if (hardcoded || generated) {
                    validIds.push(id);
                } else {
                    invalidIds.push(id);
                }
            }

            if (invalidIds.length > 0) {
                console.warn(
                    `[OptimizationPipeline] reevaluate: ${invalidIds.length}/${testCaseIds.length} IDs 无法解析为有效测试用例:`,
                    invalidIds.slice(0, 5)
                );
            }

            if (validIds.length === 0) {
                return {
                    ok: false,
                    newRunId: null,
                    logId: optimizationLogId,
                    error: `所有 ${testCaseIds.length} 个测试用例 ID 均无法解析（${invalidIds.length} 个无效）`,
                    invalidIds,
                };
            }

            // 运行评估（新配置），只跑能解析的有效 ID
            const { EvalRunner } = await import("../eval/runner.js");
            const runner = new EvalRunner();
            const newRunId = `opt-${log.source_run_id}-${Date.now().toString(36)}`;

            console.log(
                `[OptimizationPipeline] reevaluating ${validIds.length} test cases (${invalidIds.length} skipped) → runId=${newRunId}`
            );
            const report = await runner.run(validIds, newRunId, { reflect: false });

            // 计算优化后分数
            const scoreAfter = {
                weightedAvg: report.avgScores
                    ? (report.avgScores.correctness * 0.35 + report.avgScores.tool_usage * 0.2
                        + report.avgScores.tool_quality * 0.15 + report.avgScores.conciseness * 0.1
                        + report.avgScores.safety * 0.2)
                    : 0,
                avgScores: report.avgScores || {},
                passed: report.passed,
                failed: report.failed,
                total: report.total,
            };

            // 更新优化日志
            updateOptimizationLog(optimizationLogId, {
                targetRunId: newRunId,
                scoreAfter,
                status: "reevaluated",
            });

            return {
                ok: true,
                newRunId,
                logId: optimizationLogId,
                scoreAfter,
                sourceRunId: log.source_run_id,
            };
        } catch (err) {
            console.error("[OptimizationPipeline] reevaluate failed:", err.message);
            return { ok: false, newRunId: null, logId: optimizationLogId, error: err.message };
        }
    }

    /**
     * Step ⑥: 对比优化前后
     *
     * 直接复用已有的 POST /eval/compare 逻辑。
     * 返回可在前端渲染的对比数据。
     *
     * @param {string} beforeRunId
     * @param {string} afterRunId
     * @returns {Promise<object>}
     */
    async compare(beforeRunId, afterRunId) {
        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];

        const beforeRows = getScoresByRun(beforeRunId);
        const afterRows = getScoresByRun(afterRunId);

        const computeAvg = (rows) => {
            const byTc = {};
            for (const row of rows) {
                if (!byTc[row.test_case_id]) byTc[row.test_case_id] = {};
                byTc[row.test_case_id][row.dimension] = row.score;
            }
            const avg = {};
            const n = Object.keys(byTc).length;
            if (n === 0) {
                for (const d of dims) avg[d] = 0;
                return { avg, passed: 0, failed: 0, total: 0 };
            }
            let passed = 0, failed = 0;
            for (const tcId of Object.keys(byTc)) {
                const s = byTc[tcId];
                const tcAvg = dims.reduce((sum, d) => sum + (s[d] || 0), 0) / 5;
                if (tcAvg >= 3.0) passed++; else failed++;
                for (const d of dims) avg[d] = (avg[d] || 0) + (s[d] || 0);
            }
            for (const d of dims) avg[d] = Math.round(avg[d] / n * 100) / 100;
            return { avg, passed, failed, total: n };
        };

        const before = computeAvg(beforeRows);
        const after = computeAvg(afterRows);

        const deltas = {};
        for (const d of dims) {
            deltas[d] = Math.round((after.avg[d] - before.avg[d]) * 100) / 100;
        }

        const beforeWeighted = before.avg.correctness * 0.35 + before.avg.tool_usage * 0.2
            + before.avg.tool_quality * 0.15 + before.avg.conciseness * 0.1 + before.avg.safety * 0.2;
        const afterWeighted = after.avg.correctness * 0.35 + after.avg.tool_usage * 0.2
            + after.avg.tool_quality * 0.15 + after.avg.conciseness * 0.1 + after.avg.safety * 0.2;

        return {
            beforeRunId,
            afterRunId,
            before,
            after,
            deltas,
            weightedDelta: Math.round((afterWeighted - beforeWeighted) * 100) / 100,
            weightedDeltaPct: beforeWeighted > 0
                ? Math.round((afterWeighted - beforeWeighted) / beforeWeighted * 10000) / 100
                : 0,
            improved: afterWeighted > beforeWeighted,
        };
    }

    /**
     * 获取优化历史
     * @param {number} limit
     * @returns {Array}
     */
    getHistory(limit = 20) {
        return getOptimizationLogs(limit);
    }

    /**
     * 获取单条优化记录
     * @param {number} id
     * @returns {object|null}
     */
    getOne(id) {
        return getOptimizationLogById(id);
    }

    // ── private ──

    _parseSuggestions(content) {
        if (!content || content.trim().length === 0) {
            return { suggestions: [], summary: "LLM 返回空响应" };
        }

        try {
            const parsed = JSON.parse(content.trim());
            return {
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                summary: parsed.summary || "",
            };
        } catch {
            // 提取 JSON 块
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                        summary: parsed.summary || "",
                    };
                } catch { /* fall through */ }
            }
            console.warn("[OptimizationPipeline] failed to parse suggestions JSON");
            return { suggestions: [], summary: "LLM 响应解析失败" };
        }
    }
}

/** 单例实例 */
const optimizationPipeline = new OptimizationPipeline();

export { OptimizationPipeline, optimizationPipeline, BAD_CASE_THRESHOLD };
