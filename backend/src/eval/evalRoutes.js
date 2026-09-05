/**
 * Phase 5: 评估系统 API 路由
 *
 * 端点:
 *   POST /eval/run          — 运行评估
 *   GET  /eval/scores       — 历史分数查询
 *   GET  /eval/report       — 聚合趋势报告
 *   POST /chat/feedback     — 用户反馈 (在 app.js 中挂载)
 *   GET  /eval/feedback/:messageId — 获取消息反馈
 */

import express from "express";
import { EvalRunner } from "./runner.js";
import { TestCaseGenerator } from "./generator.js";
import { getTestCasesByCategory, getTestCaseCategories, testCases } from "./testCases.js";
import { getRunSummary, getTrends, getTrendsByRun, getRunList, getFeedback, getFeedbackStats } from "./metrics.js";
import { saveFeedback, getScoresByRun, listConfigVersions } from "../db/index.js";
import {
    getGeneratedTestCases,
    getGeneratedTestCaseById,
    updateGeneratedTestCase,
    deleteGeneratedTestCase,
    approveGeneratedTestCases,
} from "../db/index.js";
import { OptimizationPipeline } from "../services/optimize.js";
import { scopeFromRequest, notFoundResource } from "../security/resourceScope.js";
import { toErrorEnvelope } from "../services/resilience.js";

const router = express.Router();

function getScope(req) {
    return scopeFromRequest(req);
}

function sendError(req, res, statusCode = 500, code = "REQUEST_FAILED", message = "request failed") {
    return res.status(statusCode).json(toErrorEnvelope(Object.assign(new Error(message), {
        code,
        statusCode,
        retryable: statusCode >= 500,
    }), req.requestId));
}

/**
 * POST /eval/run
 * 运行评估套件
 *
 * Body: { testCaseIds?: string[], runId?: string, categories?: string[], reflect?: boolean }
 */
router.post("/run", async (req, res) => {
    try {
        const scope = getScope(req);
        const { testCaseIds, runId, categories, reflect = false } = req.body || {};
        if (testCaseIds !== undefined && !Array.isArray(testCaseIds)) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("testCaseIds 必须是数组"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
        }

        // 如果指定了 categories，按分类获取测试用例
        let ids = testCaseIds || [];
        if (!ids.length && categories && categories.length > 0) {
            const allFromCats = [];
            for (const cat of categories) {
                allFromCats.push(...getTestCasesByCategory(cat).map(tc => tc.id));
            }
            ids = allFromCats;
        }

        // 验证 ID 有效性（同时检查硬编码用例 + DB 生成用例 G7）
        const validIds = ids.length > 0
            ? ids.filter(id =>
                testCases.some(tc => tc.id === id) ||
                getGeneratedTestCaseById(id, scope) !== null
            )
            : [];

        const runner = new EvalRunner();

        const report = await runner.run(validIds, runId, { reflect, scope });

        res.json({ ok: true, ...report });
    } catch (err) {
        console.error(`[eval] POST /run failed:`, err.message);
        const status = Number(err?.statusCode) || 500;
        res.status(status).json(toErrorEnvelope(Object.assign(new Error("evaluation failed"), { code: err?.code || "EVAL_FAILED", statusCode: status, retryable: status >= 500 }), req.requestId));
    }
});

/**
 * GET /eval/scores
 * 查询历史评估分数
 *
 * Query: ?runId=xxx&limit=50
 */
router.get("/scores", (req, res) => {
    try {
        const { runId, limit = 50 } = req.query;
        const scope = getScope(req);

        if (runId) {
            const summary = getRunSummary(String(runId), scope);
            if (summary.total === 0) return notFoundResource(res);

            return res.json({ ok: true, summary });
        }

        // 没有 runId 时返回趋势数据
        const trends = getTrends(Number(limit) || 50, scope);
        res.json({ ok: true, trends });
    } catch (err) {
        console.error(`[eval] GET /scores failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/report
 * 聚合报告 — 趋势 + 统计 + 反馈汇总
 */
router.get("/report", (req, res) => {
    try {
        const reqUserId = Number(req.user?.id);
        const scope = getScope(req);
        const { runId } = req.query;

        // 如果指定 runId，按 run 过滤趋势数据
        const trends = runId
            ? getTrendsByRun(String(runId), 30, scope)
            : getTrends(30, scope);
        const feedbackStats = getFeedbackStats(reqUserId, scope);

        // 如果指定 runId，过滤分类统计（同时查硬编码 + DB 生成用例 G7）
        const allCategories = getTestCaseCategories();
        let categories = allCategories;
        let totalTestCases = testCases.length;

        if (runId) {
            const rows = getScoresByRun(String(runId), scope);
            const runTestCaseIds = [...new Set(rows.map(r => r.test_case_id))];
            const categoryCount = {};
            for (const tcId of runTestCaseIds) {
                // 先查硬编码，再查 DB 生成用例 (G7)
                const tc = testCases.find(t => t.id === tcId) || getGeneratedTestCaseById(tcId, scope);
                if (tc) {
                    const cat = tc.category || "unknown";
                    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
                }
            }
            categories = Object.entries(categoryCount).map(([category, count]) => ({ category, count }));
            totalTestCases = runTestCaseIds.length;
        } else {
            // 无 runId 时，把已审核的生成用例也计入总数 (G7)
            const generatedReviewed = getGeneratedTestCases({ reviewed: 1, page: 1, pageSize: 1000, scope });
            totalTestCases = testCases.length + (generatedReviewed?.length || 0);
        }

        res.json({
            ok: true,
            trendData: trends,
            feedbackStats,
            totalTestCases,
            categories,
            runId: runId || null,
        });
    } catch (err) {
        console.error(`[eval] GET /report failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/feedback/:messageId
 * 获取用户对某条消息的反馈
 */
router.get("/feedback/:messageId", (req, res) => {
    try {
        const reqUserId = Number(req.user?.id || 1);
        const messageId = Number(req.params.messageId);

        if (!messageId || messageId <= 0) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "invalid messageId");
        }

        const feedback = getFeedback(reqUserId, messageId, getScope(req));
        res.json({ ok: true, feedback: feedback || null });
    } catch (err) {
        console.error(`[eval] GET /feedback/:messageId failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/runs
 * 获取历史 run 列表（供前端下拉选择）
 */
router.get("/runs", (req, res) => {
    try {
        const runs = getRunList(getScope(req));
        res.json({ ok: true, runs });
    } catch (err) {
        console.error(`[eval] GET /runs failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/cases
 * 获取测试用例列表（供前端展示）
 */
router.get("/cases", (req, res) => {
    try {
        const { category } = req.query;
        const cases = category ? getTestCasesByCategory(String(category)) : testCases;
        const categories = getTestCaseCategories();

        res.json({
            ok: true,
            total: cases.length,
            categories,
            testCases: cases.map(tc => ({
                id: tc.id,
                category: tc.category,
                difficulty: tc.difficulty,
                description: tc.description,
            })),
        });
    } catch (err) {
        console.error(`[eval] GET /cases failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ══════════════════════════════════════════════════════════
// Phase 6b G7: 评测集自动生成
// ══════════════════════════════════════════════════════════

/**
 * POST /eval/generate
 * 从种子用例生成多样化测试用例
 *
 * Body: {
 *   seeds: [{id, category, difficulty, input, expectedBehavior, expectedTools, ...}],  // 1-3 条
 *   options: { category, count, difficultyMix: {easy, medium, hard} }
 * }
 */
router.post("/generate", async (req, res) => {
    try {
        const { seeds = [], options = {} } = req.body || {};

        if (!Array.isArray(seeds)) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "seeds 必须是数组");
        }

        if (seeds.length > 3) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "种子用例最多 3 条");
        }

        const generator = new TestCaseGenerator();
        const result = await generator.generate(seeds, { ...options, scope: getScope(req) });

        res.json(result);
    } catch (err) {
        console.error(`[eval] POST /generate failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/generated
 * 查询生成的测试用例
 *
 * Query: ?category=&reviewed=0|1&page=1&pageSize=50
 */
router.get("/generated", (req, res) => {
    try {
        const category = req.query.category || null;
        const reviewed = req.query.reviewed !== undefined ? Number(req.query.reviewed) : null;
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

        const cases = getGeneratedTestCases({ category, reviewed, page, pageSize, scope: getScope(req) });

        res.json({ ok: true, cases, page, pageSize });
    } catch (err) {
        console.error(`[eval] GET /generated failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * PATCH /eval/generated/:id
 * 编辑/审核单条生成用例
 *
 * Body: { input?, expectedBehavior?, expectedTools?, difficulty?, category?,
 *         description?, reviewed? }
 */
router.patch("/generated/:id", (req, res) => {
    try {
        const { id } = req.params;
        const existing = getGeneratedTestCaseById(id, getScope(req));

        if (!existing) {
            return sendError(req, res, 404, "NOT_FOUND", "用例不存在");
        }

        const ok = updateGeneratedTestCase(id, req.body || {}, getScope(req));

        res.json({ ok, message: ok ? "更新成功" : "未变更" });
    } catch (err) {
        console.error(`[eval] PATCH /generated/:id failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * DELETE /eval/generated/:id
 * 删除单条生成用例
 */
router.delete("/generated/:id", (req, res) => {
    try {
        const { id } = req.params;
        const ok = deleteGeneratedTestCase(id, getScope(req));

        res.json({ ok, message: ok ? "删除成功" : "用例不存在" });
    } catch (err) {
        console.error(`[eval] DELETE /generated/:id failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * POST /eval/generated/approve
 * 批量审核生成用例
 *
 * Body: { ids: string[] }
 */
router.post("/generated/approve", (req, res) => {
    try {
        const { ids = [] } = req.body || {};

        if (!Array.isArray(ids) || ids.length === 0) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "ids 不能为空");
        }

        const scope = getScope(req);
        const count = ids.reduce((total, id) => total + (updateGeneratedTestCase(id, { reviewed: true }, scope) ? 1 : 0), 0);

        res.json({ ok: true, message: `已审核 ${count} 条用例`, count });
    } catch (err) {
        console.error(`[eval] POST /generated/approve failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ══════════════════════════════════════════════════════════
// Phase 6b G8: 评估任务对比
// ══════════════════════════════════════════════════════════

/**
 * Helper: 从 scores 行计算各维度均值
 */
function computeAvgScores(rows) {
    const byTestCase = {};
    for (const row of rows) {
        if (!byTestCase[row.test_case_id]) {
            byTestCase[row.test_case_id] = {};
        }
        byTestCase[row.test_case_id][row.dimension] = row.score;
    }

    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
    const avgScores = { correctness: 0, tool_usage: 0, tool_quality: 0, conciseness: 0, safety: 0 };
    const n = Object.keys(byTestCase).length;

    if (n === 0) return { avgScores, total: 0, passed: 0, failed: 0 };

    let passed = 0, failed = 0;
    for (const tcId of Object.keys(byTestCase)) {
        const dimScores = byTestCase[tcId];
        const avg = (dimScores.correctness || 0) + (dimScores.tool_usage || 0) +
                    (dimScores.tool_quality || 0) + (dimScores.conciseness || 0) +
                    (dimScores.safety || 0);
        for (const key of dims) avgScores[key] += dimScores[key] || 0;
        if (avg / 5 >= 3.0) passed++; else failed++;
    }

    for (const key of dims) avgScores[key] = n > 0 ? Math.round(avgScores[key] / n * 100) / 100 : 0;

    return { avgScores, total: n, passed, failed };
}

/**
 * POST /eval/compare
 * 对比最多 5 个评估 run，返回雷达图叠加数据 + 维度差值表
 *
 * Body: { runIds: string[] }
 */
router.post("/compare", (req, res) => {
    try {
        const { runIds = [] } = req.body || {};
        const scope = getScope(req);

        if (!Array.isArray(runIds) || runIds.length < 2) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "至少需要 2 个 run ID 进行对比");
        }
        if (runIds.length > 5) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "最多支持 5 个 run 对比");
        }

        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
        const dimLabels = ["正确性", "工具选择", "工具质量", "简洁度", "安全性"];

        // 计算每个 run 的维度均值
        const perRun = runIds.map((runId, idx) => {
            const rows = getScoresByRun(String(runId), scope);
            if (rows.length === 0) throw Object.assign(new Error("resource not found"), { statusCode: 404, code: "NOT_FOUND" });
            const { avgScores, total, passed, failed } = computeAvgScores(rows);
            return {
                runId,
                avgScores,
                total,
                passed,
                failed,
                passedRate: total > 0 ? Math.round((passed / total) * 100) / 100 : 0,
                isBaseline: idx === 0,
            };
        });

        // 以第一个 run 为 baseline 计算 deltas
        const baseline = perRun[0];
        for (const entry of perRun) {
            if (entry === baseline) {
                entry.deltas = Object.fromEntries(dims.map(d => [d, 0]));
            } else {
                entry.deltas = Object.fromEntries(
                    dims.map(d => [d, Math.round((entry.avgScores[d] - baseline.avgScores[d]) * 100) / 100])
                );
            }
        }

        // 找出退化维度（任意 run 的 delta <= -0.5）
        const regressedDims = new Set();
        for (const entry of perRun) {
            if (entry === baseline) continue;
            for (const d of dims) {
                if (entry.deltas[d] <= -0.5) regressedDims.add(d);
            }
        }

        res.json({
            ok: true,
            dims,
            dimLabels,
            baseline: {
                runId: baseline.runId,
                avgScores: baseline.avgScores,
                total: baseline.total,
                passed: baseline.passed,
                failed: baseline.failed,
                passedRate: baseline.passedRate,
            },
            comparisons: perRun,
            regressedDims: [...regressedDims],
        });
    } catch (err) {
        console.error(`[eval] POST /compare failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ══════════════════════════════════════════════════════════
// Phase 6c G10: 优化闭环流水线
// ══════════════════════════════════════════════════════════

const optimizer = new OptimizationPipeline();

/**
 * POST /eval/optimize/analyze
 * Step ①+②: 分析 BadCase + 根因分类
 *
 * Body: { runId: string }
 */
router.post("/optimize/analyze", (req, res) => {
    try {
        const { runId } = req.body || {};
        if (!runId) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "runId 不能为空");
        }

        const result = optimizer.analyze(runId, getScope(req));

        // analyze() 是同步的（只读 DB），包装成 Promise 统一接口
        Promise.resolve(result).then(data => {
            res.json({ ok: true, ...data });
        }).catch(err => {
            console.error(`[eval] POST /optimize/analyze failed:`, err.message);
            res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
        });
    } catch (err) {
        console.error(`[eval] POST /optimize/analyze failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * POST /eval/optimize/suggest
 * Step ③: LLM 生成优化建议
 *
 * Body: { runId: string, badCases: object[] }
 */
router.post("/optimize/suggest", async (req, res) => {
    try {
        const { runId, badCases = [] } = req.body || {};
        if (!runId) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "runId 不能为空");
        }

        const result = await optimizer.suggest(runId, badCases, getScope(req));
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`[eval] POST /optimize/suggest failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * POST /eval/optimize/apply
 * Step ④: 应用优化变更
 *
 * Body: {
 *   sourceRunId: string,
 *   changes: [{key: string, value: string}, ...],
 *   suggestions?: object[],
 *   badCaseIds?: string[],
 *   scoreBefore?: object,
 *   label?: string
 * }
 */
router.post("/optimize/apply", async (req, res) => {
    try {
        const {
            sourceRunId,
            changes = [],
            suggestions = [],
            badCaseIds = [],
            scoreBefore = null,
            label = "",
        } = req.body || {};

        if (!sourceRunId) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "sourceRunId 不能为空");
        }
        if (!Array.isArray(changes) || changes.length === 0) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "changes 不能为空");
        }

        const result = await optimizer.apply(
            sourceRunId,
            changes,
            suggestions,
            badCaseIds,
            scoreBefore,
            label,
            getScope(req)
        );

        res.json(result);
    } catch (err) {
        console.error(`[eval] POST /optimize/apply failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * POST /eval/optimize/reevaluate
 * Step ⑤: 用新配置重评 BadCase
 *
 * Body: { optimizationLogId: number, testCaseIds: string[] }
 */
router.post("/optimize/reevaluate", async (req, res) => {
    try {
        const { optimizationLogId, testCaseIds = [] } = req.body || {};

        if (!optimizationLogId) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "optimizationLogId 不能为空");
        }
        if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "testCaseIds 不能为空");
        }

        const result = await optimizer.reevaluate(optimizationLogId, testCaseIds, getScope(req));
        res.json(result);
    } catch (err) {
        console.error(`[eval] POST /optimize/reevaluate failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/optimize/history
 * 获取优化历史列表
 *
 * Query: ?limit=20
 */
router.get("/optimize/history", (req, res) => {
    try {
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const scope = getScope(req);
        const logs = optimizer.getHistory(limit, scope);

        // G10: 为每条日志补充 config_version_before，供前端回滚使用
        // config_version_id 是优化后的快照，回滚应恢复到优化前的版本
        try {
            const allVersions = listConfigVersions(200, scope); // id DESC
            for (const log of logs) {
                if (log.config_version_id) {
                    const before = allVersions.find(v => v.id < log.config_version_id);
                    log.config_version_before = before ? before.id : null;
                } else {
                    log.config_version_before = null;
                }
            }
        } catch (e) {
            // 版本查询失败不阻塞历史返回
            console.warn("[eval] /optimize/history enrich config_version_before failed:", e.message);
            for (const log of logs) log.config_version_before = null;
        }

        res.json({ ok: true, logs });
    } catch (err) {
        console.error(`[eval] GET /optimize/history failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

/**
 * GET /eval/optimize/:id
 * 获取单条优化记录详情
 */
router.get("/optimize/:id", (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || id <= 0) {
            return sendError(req, res, 400, "INVALID_ARGUMENT", "invalid id");
        }

        const log = optimizer.getOne(id, getScope(req));
        if (!log) {
            return sendError(req, res, 404, "NOT_FOUND", "优化记录不存在");
        }
        res.json({ ok: true, log });
    } catch (err) {
        console.error(`[eval] GET /optimize/:id failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

export default router;
