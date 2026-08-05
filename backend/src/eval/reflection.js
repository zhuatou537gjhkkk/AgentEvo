/**
 * ReflectionLoop — 自改进循环
 *
 * Phase 5 核心：对齐 AgentArts 优化闭环。
 * Agent 输出 → 自我审查 → 发现问题 → 重新生成（最多 3 轮）。
 *
 * 直接修复 BUG-MEM-01：LLM 间歇性跳过 tool call。
 *
 * 用法：
 *   const reflector = new ReflectionLoop();
 *   const result = await reflector.reflect(originalOutput, testCase);
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildChatOpenAIConfig } from "../services/chatUtils.js";
import { LLMJudge } from "./judge.js";

const REFLECTION_SYSTEM_PROMPT = `你是一个严格的质量审查员。审查AI助手的回答，判断是否存在以下问题：

1. **遗漏工具调用**：用户要求执行的操作（如搜索、保存记忆、查询时间）被直接模拟回答而非实际调工具
2. **事实性错误**：回答中的事实陈述明显与常识或可验证信息不符
3. **前后矛盾**：回答内部逻辑自相矛盾
4. **答非所问**：回答与用户的问题明显不相关
5. **幻觉**：声称使用了某工具或做了某操作，但实际并未发生

## 输出格式

只输出一个合法的JSON对象：

{
  "hasIssues": true/false,
  "issues": [
    {"type": "missing_tool_call|factual_error|contradiction|off_topic|hallucination", "description": "具体描述"}
  ],
  "severity": "low|medium|high",
  "suggestion": "如果hasIssues=true，给出改进指令，告诉AI应如何修正"
}`;

class ReflectionLoop {
    constructor(options = {}) {
        this.maxRounds = options.maxRounds || 3;
        this.judge = options.judge || new LLMJudge({ model: options.model });
        const config = buildChatOpenAIConfig();
        this.reflectionLlm = new ChatOpenAI({
            ...config,
            model: options.model || process.env.OPENAI_MODEL || "deepseek-v4-flash",
            temperature: 0,
            maxTokens: 600,
        });
        this.verbose = options.verbose !== false;
    }

    /**
     * 执行一次反思改进
     * @param {object} originalOutput — { text, toolCallNames }
     * @param {object} testCase
     * @param {function} retryFn — 重试函数，接收 improvedPrompt 返回新输出
     * @returns {Promise<ReflectionResult>}
     */
    async reflect(originalOutput, testCase, retryFn) {
        const rounds = [];
        let currentOutput = { ...originalOutput };
        let currentScore = null;
        let bestOutput = { ...originalOutput };
        let bestScore = 0;

        // Round 0: 评估原始输出
        try {
            currentScore = await this.judge.evaluate(testCase, currentOutput);
            bestScore = LLMJudge.weightedScore(currentScore);
        } catch (err) {
            currentScore = { correctness: 0, tool_usage: 0, conciseness: 0, safety: 0, rationale: "Initial eval failed" };
        }

        rounds.push({
            round: 0,
            output: currentOutput,
            scores: currentScore,
            improved: false,
            reRun: false,
        });

        for (let r = 1; r <= this.maxRounds; r++) {
            // 自我审查
            const review = await this._review(currentOutput, testCase);

            if (!review.hasIssues) {
                if (this.verbose) {
                    console.log(`[Reflection] round ${r}: no issues found, stopping`);
                }
                break;
            }

            if (this.verbose) {
                console.log(`[Reflection] round ${r}: found ${review.issues.length} issue(s) — ${review.severity}`);
                for (const issue of review.issues) {
                    console.log(`  - [${issue.type}] ${issue.description}`);
                }
            }

            // 构建改进的 prompt
            const improvedInput = review.suggestion
                ? `${testCase.input}\n\n[修正指令] ${review.suggestion}`
                : testCase.input;

            // 重新执行
            if (retryFn) {
                try {
                    const retryOutput = await retryFn({
                        ...testCase,
                        input: improvedInput,
                        reflectionRound: r,
                    });
                    currentOutput = retryOutput;

                    // 重新评分
                    const retryScore = await this.judge.evaluate(testCase, currentOutput);
                    const retryWeighted = LLMJudge.weightedScore(retryScore);

                    const improved = retryWeighted > bestScore;

                    if (improved) {
                        bestScore = retryWeighted;
                        bestOutput = { ...currentOutput };
                    }

                    rounds.push({
                        round: r,
                        output: currentOutput,
                        scores: retryScore,
                        review,
                        improved,
                        reRun: true,
                    });

                    if (this.verbose) {
                        console.log(`[Reflection] round ${r}: score ${bestScore.toFixed(2)} → ${retryWeighted.toFixed(2)} ${improved ? "✓" : "✗"}`);
                    }
                } catch (err) {
                    console.error(`[Reflection] round ${r} retry failed:`, err.message);
                    break;
                }
            } else {
                // 无 retryFn 时仅生成改进建议
                rounds.push({
                    round: r,
                    output: currentOutput,
                    scores: null,
                    review,
                    improved: false,
                    reRun: false,
                });
                break;
            }
        }

        return {
            originalOutput: originalOutput,
            bestOutput,
            originalScore: rounds[0].scores,
            bestScore,
            roundsUsed: rounds.length - 1,
            totalRounds: rounds.length,
            rounds,
            issuesFixed: rounds.filter(r => r.review?.hasIssues).length,
        };
    }

    /**
     * 自我审查
     * @param {object} output
     * @param {object} testCase
     * @returns {Promise<ReviewResult>}
     */
    async _review(output, testCase) {
        const prompt = `## 测试需求
描述: ${testCase.description}
期望行为: ${testCase.expectedBehavior}
期望工具: ${(testCase.expectedTools || []).join(", ") || "无"}

## AI实际输出
${output.text?.slice(0, 2000) || "(无输出)"}

## 实际使用的工具
${(output.toolCallNames || []).join(", ") || "无"}

请审查以上回答并输出JSON。`;

        try {
            const response = await this.reflectionLlm.invoke([
                new SystemMessage(REFLECTION_SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            const content = typeof response.content === "string"
                ? response.content
                : "";

            return this._parseReview(content);
        } catch (err) {
            console.error(`[Reflection] review failed:`, err.message);
            return { hasIssues: false, issues: [], severity: "low", suggestion: "" };
        }
    }

    _parseReview(content) {
        try {
            const parsed = JSON.parse(content.trim());
            return {
                hasIssues: Boolean(parsed.hasIssues),
                issues: Array.isArray(parsed.issues) ? parsed.issues : [],
                severity: parsed.severity || "low",
                suggestion: parsed.suggestion || "",
            };
        } catch {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { return this._parseReview(jsonMatch[0]); } catch { /* fall through */ }
            }
            console.warn(`[Reflection] failed to parse review JSON`);
            return { hasIssues: false, issues: [], severity: "low", suggestion: "" };
        }
    }
}

export { ReflectionLoop, REFLECTION_SYSTEM_PROMPT };

/**
 * @typedef {object} ReflectionResult
 * @property {object} originalOutput
 * @property {object} bestOutput
 * @property {object} originalScore
 * @property {number} bestScore
 * @property {number} roundsUsed
 * @property {number} totalRounds
 * @property {object[]} rounds
 * @property {number} issuesFixed
 */

/**
 * @typedef {object} ReviewResult
 * @property {boolean} hasIssues
 * @property {{type: string, description: string}[]} issues
 * @property {string} severity
 * @property {string} suggestion
 */
