/**
 * Phase 5: 评估系统 API 调用
 *
 * 使用动态 import 模式避免与 chatStore 循环依赖。
 * request() 来自 chat.js 的通用 HTTP wrapper。
 */

import { request } from "./chat.js";

/**
 * 运行评估套件
 * @param {object} params
 * @param {string[]} params.testCaseIds
 * @param {string} [params.runId]
 * @param {string[]} [params.categories]
 * @param {boolean} [params.reflect]
 * @returns {Promise<object>}
 */
export async function runEvalSuite({ testCaseIds = [], runId = null, categories = [], reflect = false } = {}) {
    const res = await request("/eval/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCaseIds, runId, categories, reflect }),
    }, { timeoutMs: 10 * 60 * 1000 }); // 10min — 评估跑 53 用例需几分钟
    return res.json();
}

/**
 * 获取评估报告
 * @param {string} [runId] — 可选，按 run 筛选
 * @returns {Promise<object>}
 */
export async function fetchEvalReport(runId = null) {
    const params = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const res = await request(`/eval/report${params}`, { method: "GET" });
    return res.json();
}

/**
 * 获取历史 run 列表
 * @returns {Promise<object>}
 */
export async function fetchEvalRuns() {
    const res = await request("/eval/runs", { method: "GET" });
    return res.json();
}

/**
 * 获取历史分数/趋势
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function fetchEvalScores({ runId = null, limit = 50 } = {}) {
    const params = new URLSearchParams();
    if (runId) params.set("runId", runId);
    if (limit) params.set("limit", String(limit));

    const res = await request(`/eval/scores?${params.toString()}`, { method: "GET" });
    return res.json();
}

/**
 * 获取测试用例列表
 * @param {string} [category]
 * @returns {Promise<object>}
 */
export async function fetchEvalCases(category = "") {
    const params = category ? `?category=${encodeURIComponent(category)}` : "";
    const res = await request(`/eval/cases${params}`, { method: "GET" });
    return res.json();
}

/**
 * 提交用户反馈
 * @param {number} messageId
 * @param {string} rating — 'thumbs_up' | 'thumbs_down'
 * @param {string} [comment]
 * @returns {Promise<object>}
 */
export async function submitFeedback(messageId, rating, comment = null) {
    const res = await request("/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId, rating, comment }),
    });
    return res.json();
}

/**
 * 获取用户对某条消息的反馈
 * @param {number} messageId
 * @returns {Promise<object>}
 */
export async function fetchMessageFeedback(messageId) {
    const res = await request(`/eval/feedback/${messageId}`, { method: "GET" });
    return res.json();
}

/**
 * 获取可观测性记录（扩展版）
 * @param {number} [limit]
 * @returns {Promise<object>}
 */
export async function fetchObservability(limit = 30) {
    const res = await request(`/observability/recent?limit=${limit}`, { method: "GET" });
    return res.json();
}

// ══════════════════════════════════════════════════════════
// Phase 6b G7: 评测集自动生成
// ══════════════════════════════════════════════════════════

/**
 * 从种子用例生成测试用例
 * @param {object} params
 * @param {object[]} params.seeds — 1-3 条种子用例
 * @param {object} params.options — { category, count, difficultyMix }
 * @returns {Promise<object>}
 */
export async function generateTestCases({ seeds = [], options = {} } = {}) {
    const res = await request("/eval/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seeds, options }),
    }, { timeoutMs: 120000 }); // 2min — LLM 生成需要时间
    return res.json();
}

/**
 * 查询生成的测试用例列表
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function fetchGeneratedCases({ category = null, reviewed = null, page = 1, pageSize = 50 } = {}) {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (reviewed !== null && reviewed !== undefined) params.set("reviewed", String(reviewed));
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    const res = await request(`/eval/generated?${params.toString()}`, { method: "GET" });
    return res.json();
}

/**
 * 编辑/审核单条生成用例
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<object>}
 */
export async function updateGeneratedCase(id, updates = {}) {
    const res = await request(`/eval/generated/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
    });
    return res.json();
}

/**
 * 删除单条生成用例
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function deleteGeneratedCase(id) {
    const res = await request(`/eval/generated/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
    return res.json();
}

/**
 * 批量审核生成用例
 * @param {string[]} ids
 * @returns {Promise<object>}
 */
export async function approveGeneratedCases(ids = []) {
    const res = await request("/eval/generated/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
    return res.json();
}

/**
 * Phase 6b G8: 对比多个评估 run
 * @param {string[]} runIds — 2-5 个 run ID
 * @returns {Promise<object>}
 */
export async function compareRuns(runIds = []) {
    const res = await request("/eval/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds }),
    });
    return res.json();
}

// ══════════════════════════════════════════════════════════
// Phase 6c G10: 优化闭环流水线
// ══════════════════════════════════════════════════════════

/**
 * Step ①+②: 分析 BadCase + 根因分类
 * @param {string} runId
 * @returns {Promise<object>}
 */
export async function analyzeBadCases(runId) {
    const res = await request("/eval/optimize/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
    });
    return res.json();
}

/**
 * Step ③: LLM 生成优化建议
 * @param {string} runId
 * @param {object[]} badCases
 * @returns {Promise<object>}
 */
export async function suggestOptimizations(runId, badCases = []) {
    const res = await request("/eval/optimize/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, badCases }),
    }, { timeoutMs: 120000 }); // 2min — LLM 生成需要时间
    return res.json();
}

/**
 * Step ④: 应用优化变更
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function applyOptimizations({
    sourceRunId,
    changes = [],
    suggestions = [],
    badCaseIds = [],
    scoreBefore = null,
    label = "",
} = {}) {
    const res = await request("/eval/optimize/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRunId, changes, suggestions, badCaseIds, scoreBefore, label }),
    });
    return res.json();
}

/**
 * Step ⑤: 重评验证
 * @param {number} optimizationLogId
 * @param {string[]} testCaseIds
 * @returns {Promise<object>}
 */
export async function reevaluateOptimization(optimizationLogId, testCaseIds = []) {
    const res = await request("/eval/optimize/reevaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimizationLogId, testCaseIds }),
    }, { timeoutMs: 10 * 60 * 1000 }); // 10min
    return res.json();
}

/**
 * 获取优化历史
 * @param {number} [limit=20]
 * @returns {Promise<object>}
 */
export async function fetchOptimizationHistory(limit = 20) {
    const res = await request(`/eval/optimize/history?limit=${limit}`, { method: "GET" });
    return res.json();
}

/**
 * 获取单条优化记录详情
 * @param {number} id
 * @returns {Promise<object>}
 */
export async function fetchOptimizationLog(id) {
    const res = await request(`/eval/optimize/${id}`, { method: "GET" });
    return res.json();
}
