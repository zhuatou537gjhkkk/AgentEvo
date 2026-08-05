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
import { getTestCasesByCategory, getTestCaseCategories, testCases } from "./testCases.js";
import { getRunSummary, getTrends, getTrendsByRun, getRunList, getFeedback, getFeedbackStats } from "./metrics.js";
import { saveFeedback, getScoresByRun } from "../db/index.js";

const router = express.Router();

/**
 * POST /eval/run
 * 运行评估套件
 *
 * Body: { testCaseIds?: string[], runId?: string, categories?: string[], reflect?: boolean }
 */
router.post("/run", async (req, res) => {
    try {
        const { testCaseIds, runId, categories, reflect = false } = req.body || {};

        // 如果指定了 categories，按分类获取测试用例
        let ids = testCaseIds || [];
        if (!ids.length && categories && categories.length > 0) {
            const allFromCats = [];
            for (const cat of categories) {
                allFromCats.push(...getTestCasesByCategory(cat).map(tc => tc.id));
            }
            ids = allFromCats;
        }

        // 验证 ID 有效性
        const validIds = ids.length > 0
            ? ids.filter(id => testCases.some(tc => tc.id === id))
            : [];

        const runner = new EvalRunner();

        const report = await runner.run(validIds, runId, { reflect });

        res.json({ ok: true, ...report });
    } catch (err) {
        console.error(`[eval] POST /run failed:`, err.message);
        res.status(500).json({ ok: false, message: err.message });
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

        if (runId) {
            const summary = getRunSummary(String(runId));
            return res.json({ ok: true, summary });
        }

        // 没有 runId 时返回趋势数据
        const trends = getTrends(Number(limit) || 50);
        res.json({ ok: true, trends });
    } catch (err) {
        console.error(`[eval] GET /scores failed:`, err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
});

/**
 * GET /eval/report
 * 聚合报告 — 趋势 + 统计 + 反馈汇总
 */
router.get("/report", (req, res) => {
    try {
        const reqUserId = Number(req.user?.id || 1);
        const { runId } = req.query;

        // 如果指定 runId，按 run 过滤趋势数据
        const trends = runId
            ? getTrendsByRun(String(runId), 30)
            : getTrends(30);
        const feedbackStats = getFeedbackStats(reqUserId);

        // 如果指定 runId，过滤分类统计
        const allCategories = getTestCaseCategories();
        let categories = allCategories;
        let totalTestCases = testCases.length;

        if (runId) {
            // 按该 run 中实际涉及的 testCaseId 过滤分类
            const rows = getScoresByRun(String(runId));
            const runTestCaseIds = [...new Set(rows.map(r => r.test_case_id))];
            const categoryCount = {};
            for (const tcId of runTestCaseIds) {
                const tc = testCases.find(t => t.id === tcId);
                if (tc) {
                    categoryCount[tc.category] = (categoryCount[tc.category] || 0) + 1;
                }
            }
            categories = Object.entries(categoryCount).map(([category, count]) => ({ category, count }));
            totalTestCases = runTestCaseIds.length;
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
        res.status(500).json({ ok: false, message: err.message });
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
            return res.status(400).json({ ok: false, message: "invalid messageId" });
        }

        const feedback = getFeedback(reqUserId, messageId);
        res.json({ ok: true, feedback: feedback || null });
    } catch (err) {
        console.error(`[eval] GET /feedback/:messageId failed:`, err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
});

/**
 * GET /eval/runs
 * 获取历史 run 列表（供前端下拉选择）
 */
router.get("/runs", (req, res) => {
    try {
        const runs = getRunList();
        res.json({ ok: true, runs });
    } catch (err) {
        console.error(`[eval] GET /runs failed:`, err.message);
        res.status(500).json({ ok: false, message: err.message });
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
        res.status(500).json({ ok: false, message: err.message });
    }
});

export default router;
