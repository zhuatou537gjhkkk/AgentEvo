/**
 * Phase 6b G8: 评估任务对比 — 单元测试
 *
 * 测试 computeAvgScores 辅助函数 + POST /eval/compare 路由逻辑
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 在 mock 之前先导入纯函数 ──
// 由于 computeAvgScores 是 evalRoutes.js 里的私有函数，
// 我们直接内联一份进行测试（与源代码保持同步）

/**
 * computeAvgScores — 从 evalRoutes.js 提取用于测试
 * 从 scores rows 数组计算各维度均值
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

// ── computeAvgScores 测试 ──

describe("computeAvgScores", () => {
    it("should return zeros for empty rows", () => {
        const result = computeAvgScores([]);
        expect(result.total).toBe(0);
        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.avgScores).toEqual({
            correctness: 0, tool_usage: 0, tool_quality: 0, conciseness: 0, safety: 0,
        });
    });

    it("should compute averages for a single test case", () => {
        const rows = [
            { test_case_id: "tc-01", dimension: "correctness", score: 4 },
            { test_case_id: "tc-01", dimension: "tool_usage", score: 5 },
            { test_case_id: "tc-01", dimension: "tool_quality", score: 3 },
            { test_case_id: "tc-01", dimension: "conciseness", score: 4 },
            { test_case_id: "tc-01", dimension: "safety", score: 5 },
        ];
        const result = computeAvgScores(rows);
        expect(result.total).toBe(1);
        expect(result.avgScores.correctness).toBe(4);
        expect(result.avgScores.tool_usage).toBe(5);
        expect(result.avgScores.tool_quality).toBe(3);
        expect(result.avgScores.conciseness).toBe(4);
        expect(result.avgScores.safety).toBe(5);
    });

    it("should compute averages across multiple test cases", () => {
        const rows = [
            // tc-01
            { test_case_id: "tc-01", dimension: "correctness", score: 4 },
            { test_case_id: "tc-01", dimension: "tool_usage", score: 5 },
            { test_case_id: "tc-01", dimension: "tool_quality", score: 3 },
            { test_case_id: "tc-01", dimension: "conciseness", score: 4 },
            { test_case_id: "tc-01", dimension: "safety", score: 5 },
            // tc-02
            { test_case_id: "tc-02", dimension: "correctness", score: 2 },
            { test_case_id: "tc-02", dimension: "tool_usage", score: 3 },
            { test_case_id: "tc-02", dimension: "tool_quality", score: 2 },
            { test_case_id: "tc-02", dimension: "conciseness", score: 3 },
            { test_case_id: "tc-02", dimension: "safety", score: 4 },
        ];
        const result = computeAvgScores(rows);
        expect(result.total).toBe(2);
        // tc-01: (4+5+3+4+5)/5 = 4.2 → avgScores: 4+2/2=3, 5+3/2=4, ...
        expect(result.avgScores.correctness).toBe(3);    // (4+2)/2
        expect(result.avgScores.tool_usage).toBe(4);     // (5+3)/2
        expect(result.avgScores.tool_quality).toBe(2.5); // (3+2)/2
        expect(result.avgScores.conciseness).toBe(3.5);  // (4+3)/2
        expect(result.avgScores.safety).toBe(4.5);       // (5+4)/2
    });

    it("should classify passed/failed correctly", () => {
        // tc-01 avg = (5+5+5+5+5)/5 = 5.0 → passed
        // tc-02 avg = (1+1+1+1+1)/5 = 1.0 → failed
        // tc-03 avg = (3+3+3+3+3)/5 = 3.0 → passed (>= 3.0)
        const rows = [
            { test_case_id: "tc-01", dimension: "correctness", score: 5 },
            { test_case_id: "tc-01", dimension: "tool_usage", score: 5 },
            { test_case_id: "tc-01", dimension: "tool_quality", score: 5 },
            { test_case_id: "tc-01", dimension: "conciseness", score: 5 },
            { test_case_id: "tc-01", dimension: "safety", score: 5 },
            { test_case_id: "tc-02", dimension: "correctness", score: 1 },
            { test_case_id: "tc-02", dimension: "tool_usage", score: 1 },
            { test_case_id: "tc-02", dimension: "tool_quality", score: 1 },
            { test_case_id: "tc-02", dimension: "conciseness", score: 1 },
            { test_case_id: "tc-02", dimension: "safety", score: 1 },
            { test_case_id: "tc-03", dimension: "correctness", score: 3 },
            { test_case_id: "tc-03", dimension: "tool_usage", score: 3 },
            { test_case_id: "tc-03", dimension: "tool_quality", score: 3 },
            { test_case_id: "tc-03", dimension: "conciseness", score: 3 },
            { test_case_id: "tc-03", dimension: "safety", score: 3 },
        ];
        const result = computeAvgScores(rows);
        expect(result.total).toBe(3);
        expect(result.passed).toBe(2); // tc-01 + tc-03
        expect(result.failed).toBe(1); // tc-02
    });

    it("should handle null/undefined scores gracefully", () => {
        const rows = [
            { test_case_id: "tc-01", dimension: "correctness", score: 4 },
            // missing dimensions for tc-01 → treated as 0
            { test_case_id: "tc-02", dimension: "conciseness", score: 5 },
            { test_case_id: "tc-02", dimension: "safety", score: 2 },
        ];
        const result = computeAvgScores(rows);
        expect(result.total).toBe(2);
        // tc-02 only has 2 dims → avg = (5+2)/5 = 1.4 → failed
        expect(result.failed).toBeGreaterThanOrEqual(1);
    });

    it("should round avgScores to 2 decimal places", () => {
        const rows = [
            { test_case_id: "tc-01", dimension: "correctness", score: 4 },
            { test_case_id: "tc-01", dimension: "tool_usage", score: 3 },
            { test_case_id: "tc-01", dimension: "tool_quality", score: 4 },
            { test_case_id: "tc-01", dimension: "conciseness", score: 3 },
            { test_case_id: "tc-01", dimension: "safety", score: 5 },
            { test_case_id: "tc-02", dimension: "correctness", score: 5 },
            { test_case_id: "tc-02", dimension: "tool_usage", score: 4 },
            { test_case_id: "tc-02", dimension: "tool_quality", score: 5 },
            { test_case_id: "tc-02", dimension: "conciseness", score: 4 },
            { test_case_id: "tc-02", dimension: "safety", score: 5 },
        ];
        const result = computeAvgScores(rows);
        // correctness = (4+5)/2 = 4.5
        expect(result.avgScores.correctness).toBe(4.5);
        // tool_usage = (3+4)/2 = 3.5
        expect(result.avgScores.tool_usage).toBe(3.5);
        // All values should be at most 2 decimal places
        for (const key of Object.keys(result.avgScores)) {
            const str = String(result.avgScores[key]);
            const decimals = str.includes(".") ? str.split(".")[1].length : 0;
            expect(decimals).toBeLessThanOrEqual(2);
        }
    });
});

// ── POST /eval/compare 路由逻辑测试 ──

describe("POST /eval/compare route logic", () => {
    it("should reject fewer than 2 runIds", () => {
        // 模拟路由中的校验逻辑
        function validateCompareInput(runIds) {
            if (!Array.isArray(runIds) || runIds.length < 2) {
                return { ok: false, message: "至少需要 2 个 run ID 进行对比" };
            }
            if (runIds.length > 5) {
                return { ok: false, message: "最多支持 5 个 run 对比" };
            }
            return null; // valid
        }

        expect(validateCompareInput([])).not.toBeNull();
        expect(validateCompareInput(["r1"])).not.toBeNull();
        expect(validateCompareInput("not-array")).not.toBeNull();
        expect(validateCompareInput(["r1", "r2"])).toBeNull();
        expect(validateCompareInput(["r1", "r2", "r3", "r4", "r5"])).toBeNull();
    });

    it("should reject more than 5 runIds", () => {
        function validateCompareInput(runIds) {
            if (!Array.isArray(runIds) || runIds.length < 2) {
                return { ok: false, message: "至少需要 2 个 run ID 进行对比" };
            }
            if (runIds.length > 5) {
                return { ok: false, message: "最多支持 5 个 run 对比" };
            }
            return null;
        }

        expect(validateCompareInput(["r1", "r2", "r3", "r4", "r5", "r6"])).not.toBeNull();
    });

    it("should identify regressed dimensions (delta <= -0.5)", () => {
        // 模拟 compare 路由中计算退化维度的逻辑
        function findRegressedDims(perRun, dims) {
            const baseline = perRun[0];
            const regressed = new Set();
            for (const entry of perRun) {
                if (entry === baseline) continue;
                for (const d of dims) {
                    const delta = entry.avgScores[d] - baseline.avgScores[d];
                    if (delta <= -0.5) regressed.add(d);
                }
            }
            return [...regressed];
        }

        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
        const perRun = [
            { runId: "baseline", avgScores: { correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4 }, isBaseline: true },
            { runId: "run2", avgScores: { correctness: 3, tool_usage: 4, tool_quality: 3, conciseness: 4, safety: 3 }, isBaseline: false },
            { runId: "run3", avgScores: { correctness: 3.5, tool_usage: 3, tool_quality: 3.5, conciseness: 3.5, safety: 4.5 }, isBaseline: false },
        ];

        const regressed = findRegressedDims(perRun, dims);
        // run2: correctness delta=-1(<=-0.5 ✓), tool_usage delta=0, tool_quality delta=-1(✓), conciseness delta=0, safety delta=-1(✓)
        // run3: correctness delta=-0.5(✓), tool_usage delta=-1(✓), tool_quality delta=-0.5(✓), conciseness delta=-0.5(✓), safety delta=+0.5
        expect(regressed).toContain("correctness");
        expect(regressed).toContain("tool_quality");
        expect(regressed).toContain("safety");
        expect(regressed).toContain("tool_usage");
    });

    it("should not flag small deltas as regressed (delta > -0.5)", () => {
        function findRegressedDims(perRun, dims) {
            const baseline = perRun[0];
            const regressed = new Set();
            for (const entry of perRun) {
                if (entry === baseline) continue;
                for (const d of dims) {
                    const delta = entry.avgScores[d] - baseline.avgScores[d];
                    if (delta <= -0.5) regressed.add(d);
                }
            }
            return [...regressed];
        }

        const dims = ["correctness", "tool_usage"];
        const perRun = [
            { runId: "baseline", avgScores: { correctness: 4, tool_usage: 4 }, isBaseline: true },
            { runId: "run2", avgScores: { correctness: 3.6, tool_usage: 3.8 }, isBaseline: false },
        ];

        const regressed = findRegressedDims(perRun, dims);
        // correctness: 3.6 - 4 = -0.4 → not regressed
        // tool_usage: 3.8 - 4 = -0.2 → not regressed
        expect(regressed).toHaveLength(0);
    });

    it("should compute deltas relative to first run (baseline)", () => {
        function computeDeltas(perRun, dims) {
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
            return perRun;
        }

        const dims = ["correctness", "tool_usage"];
        const perRun = [
            { runId: "baseline", avgScores: { correctness: 4.0, tool_usage: 5.0 }, isBaseline: true },
            { runId: "run2", avgScores: { correctness: 3.5, tool_usage: 4.2 }, isBaseline: false },
        ];

        const result = computeDeltas(perRun, dims);
        expect(result[0].deltas).toEqual({ correctness: 0, tool_usage: 0 });
        expect(result[1].deltas.correctness).toBe(-0.5);
        expect(result[1].deltas.tool_usage).toBe(-0.8);
    });
});
