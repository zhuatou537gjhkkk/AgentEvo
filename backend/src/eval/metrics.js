/**
 * Phase 5: 评估指标 — DB 存储和查询
 *
 * 封装 eval_scores + eval_feedback 表的读写操作。
 */

import {
    saveEvalScore,
    getScoresByRun,
    getScoreTrends,
    getScoreTrendsByRun,
    getRunIds,
    saveFeedback,
    getFeedbackByMessage,
    getFeedbackSummary,
} from "../db/index.js";

/**
 * 保存一次评估的所有维度分数
 * @param {object} params
 * @param {object} params.scores — {correctness, tool_usage, conciseness, safety}
 * @param {string} params.runId
 * @param {string} params.testCaseId
 * @param {string} params.traceId
 * @param {number} [params.messageId]
 * @param {string} [params.judgeModel]
 * @param {string} [params.scoreType] — 'offline' | 'online'
 */
export function saveEvalRunScores({
    scores,
    runId,
    testCaseId,
    traceId = null,
    messageId = null,
    judgeModel = "",
    scoreType = "offline",
}) {
    const dimensions = [
        { key: "correctness", score: scores.correctness },
        { key: "tool_usage", score: scores.tool_usage },
        { key: "tool_quality", score: scores.tool_quality },
        { key: "conciseness", score: scores.conciseness },
        { key: "safety", score: scores.safety },
    ];

    for (const dim of dimensions) {
        saveEvalScore({
            traceId,
            messageId,
            testCaseId,
            runId,
            dimension: dim.key,
            score: dim.score,
            judgeRationale: scores.rationale || null,
            judgeModel,
            scoreType,
        });
    }
}

/**
 * 获取某个 run 的汇总结果
 * @param {string} runId
 * @returns {object}
 */
export function getRunSummary(runId) {
    const rows = getScoresByRun(runId);

    if (rows.length === 0) {
        return { runId, total: 0, passed: 0, failed: 0, avgScores: {} };
    }

    // 按 testCaseId 分组
    const byTestCase = {};
    for (const row of rows) {
        if (!byTestCase[row.test_case_id]) {
            byTestCase[row.test_case_id] = {};
        }
        byTestCase[row.test_case_id][row.dimension] = row.score;
    }

    const testCaseIds = Object.keys(byTestCase);
    const avgScores = { correctness: 0, tool_usage: 0, tool_quality: 0, conciseness: 0, safety: 0 };
    let passed = 0;
    let failed = 0;

    for (const tcId of testCaseIds) {
        const dims = byTestCase[tcId];
        const avg = (
            (dims.correctness || 0) +
            (dims.tool_usage || 0) +
            (dims.tool_quality || 0) +
            (dims.conciseness || 0) +
            (dims.safety || 0)
        ) / 5;

        avgScores.correctness += dims.correctness || 0;
        avgScores.tool_usage += dims.tool_usage || 0;
        avgScores.tool_quality += dims.tool_quality || 0;
        avgScores.conciseness += dims.conciseness || 0;
        avgScores.safety += dims.safety || 0;

        if (avg >= 3.0) passed++;
        else failed++;
    }

    const n = testCaseIds.length;
    for (const key of Object.keys(avgScores)) {
        avgScores[key] = n > 0 ? Math.round(avgScores[key] / n * 100) / 100 : 0;
    }

    return {
        runId,
        total: n,
        passed,
        failed,
        avgScores,
    };
}

/**
 * 获取评分趋势数据
 * @param {number} limit
 * @returns {Array}
 */
export function getTrends(limit = 30) {
    return getScoreTrends(limit);
}

/**
 * 获取指定 run 的趋势数据
 * @param {string} runId
 * @param {number} limit
 * @returns {Array}
 */
export function getTrendsByRun(runId, limit = 30) {
    return getScoreTrendsByRun(runId, limit);
}

/**
 * 获取所有历史 run 列表
 * @returns {Array<{run_id: string, created_at: string}>}
 */
export function getRunList() {
    return getRunIds();
}

/**
 * 提交用户反馈
 * @param {number} userId
 * @param {number} messageId
 * @param {string} rating — 'thumbs_up' | 'thumbs_down'
 * @param {string} [comment]
 */
export function submitFeedback(userId, messageId, rating, comment) {
    return saveFeedback(userId, messageId, rating, comment);
}

/**
 * 获取用户对消息的反馈
 * @param {number} userId
 * @param {number} messageId
 * @returns {object|null}
 */
export function getFeedback(userId, messageId) {
    return getFeedbackByMessage(userId, messageId);
}

/**
 * 获取用户反馈汇总
 * @param {number} userId
 * @returns {{ thumbs_up: number, thumbs_down: number, total: number }}
 */
export function getFeedbackStats(userId) {
    return getFeedbackSummary(userId);
}
