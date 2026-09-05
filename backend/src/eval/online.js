/**
 * OnlineEvaluator — 在线评估采样器
 *
 * Phase 6a G1：对标 AgentArts 在线评估（基于 Trace 自动采样）。
 *
 * 与 EvalRunner（离线批量）互补：
 *   - 离线：开发阶段手动触发，基于预设评测集批量测试
 *   - 在线：生产环境自动采样，基于真实用户对话持续监测
 *
 * 用法：
 *   const onlineEval = new OnlineEvaluator({ sampleRate: 0.1 });
 *   // 在 chat 流完成后：
 *   onlineEval.maybeEvaluate({ userId, sessionId, messageId, userInput, assistantText, toolCalls });
 */

import { LLMJudge } from "./judge.js";
import { saveEvalRunScores } from "./metrics.js";
import crypto from "crypto";
import { getUserScope } from "../db/index.js";

/**
 * 从对话中构建简易 testCase（在线评估没有预设评测集）
 */
function buildOnlineTestCase(userInput) {
    return {
        id: `online_${crypto.randomUUID().slice(0, 8)}`,
        category: "online",
        difficulty: "unknown",
        description: `在线采样: ${userInput.slice(0, 80)}`,
        input: userInput,
        expectedBehavior: "合理的回答",
        expectedTools: [],
    };
}

class OnlineEvaluator {
    constructor(options = {}) {
        /**
         * 采样率：0.0 ~ 1.0，默认 10%
         */
        this.sampleRate = typeof options.sampleRate === "number"
            ? Math.max(0, Math.min(1, options.sampleRate))
            : 0.1;

        /**
         * 是否启用
         */
        this.enabled = options.enabled !== undefined
            ? options.enabled
            : (process.env.ONLINE_EVAL_ENABLED === "true");

        /**
         * LLMJudge 实例（temperature=0 保证一致性）
         */
        this.judge = options.judge || new LLMJudge({
            model: options.model || process.env.OPENAI_MODEL || "deepseek-v4-flash",
        });

        /**
         * 评估计数器（统计用）
         */
        this._evalCount = 0;
        this._evalSkipped = 0;
    }

    /**
     * 根据采样策略决定是否评估，是则异步执行
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {number} params.sessionId
     * @param {number} [params.messageId]
     * @param {string} params.userInput — 用户原始消息
     * @param {string} params.assistantText — Agent 输出文本
     * @param {string[]} params.toolCallNames — 实际调用的工具名
     * @param {{toolName: string, input: string, output: string}[]} [params.toolCallsDetail]
     * @param {string} [params.runId] — 关联的 runId（可选）
     * @returns {boolean} 是否触发了评估
     */
    maybeEvaluate(params) {
        const scope = params?.scope || getUserScope(params?.userId);
        if (!scope) return false;
        params = { ...params, scope };
        if (!this.enabled) {
            this._evalSkipped++;
            return false;
        }

        // 判断是否采样
        const shouldSample = this._shouldSample(params);
        if (!shouldSample) {
            this._evalSkipped++;
            return false;
        }

        // 异步执行评估（不阻塞调用方）
        setImmediate(() => {
            this._evaluate(params).catch(err => {
                console.error("[OnlineEvaluator] async eval failed:", err.message);
            });
        });

        return true;
    }

    /**
     * 获取统计信息
     * @returns {{enabled: boolean, sampleRate: number, evaluated: number, skipped: number}}
     */
    getStats() {
        return {
            enabled: this.enabled,
            sampleRate: this.sampleRate,
            evaluated: this._evalCount,
            skipped: this._evalSkipped,
        };
    }

    // ── private ──

    /**
     * 采样决策
     */
    _shouldSample(params) {
        // 数学随机采样
        return Math.random() < this.sampleRate;
    }

    /**
     * 执行一次在线评估
     */
    async _evaluate(params) {
        const {
            userId,
            sessionId,
            messageId,
            userInput,
            assistantText,
            toolCallNames = [],
            toolCallsDetail = [],
            runId = null,
        } = params;

        if (!userInput || !assistantText) {
            return;
        }

        const effectiveRunId = runId || `online_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

        const testCase = buildOnlineTestCase(userInput);

        try {
            const scores = await this.judge.evaluate(testCase, {
                text: assistantText,
                toolCallNames,
                toolCallsDetail,
                trace: null,
            });

            // 写入 eval_scores 表（score_type='online'）
            saveEvalRunScores({
                scores,
                scope: params.scope || getUserScope(userId),
                runId: effectiveRunId,
                testCaseId: testCase.id,
                judgeModel: this.judge.llm.model || "unknown",
                scoreType: "online",
                messageId: messageId || null,
            });

            this._evalCount++;
        } catch (err) {
            console.error(`[OnlineEvaluator] eval "${testCase.id}" failed:`, err.message);
            // 不抛异常，在线评估失败不应影响主流程
        }
    }
}

export { OnlineEvaluator };
