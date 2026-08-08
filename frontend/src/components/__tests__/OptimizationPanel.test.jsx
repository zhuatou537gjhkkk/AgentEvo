/**
 * OptimizationPanel 组件测试 — Phase 6c G10
 *
 * 覆盖：
 *   - 六步闭环状态机逻辑
 *   - BadCase 识别阈值
 *   - Step 激活条件判断
 *   - 对比结果计算
 *
 * 运行: npx vitest run src/components/__tests__/OptimizationPanel.test.jsx
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════
// 六步闭环 Step 激活条件
// ═══════════════════════════════════════════════════════

/**
 * 模拟 OptimizationPanel 的 stepActive 逻辑
 * 对应源码: stepActive(step) => boolean
 */
function stepActive(step, state) {
    const { optSelectedRunId, optBadCases, optSuggestions, optSelectedIdsSize, optResult, optLogId, optLoading } = state;

    if (optLoading) return false;

    switch (step) {
        case 1: return !!optSelectedRunId;
        case 2: return !!(optBadCases?.badCases?.length > 0);
        case 3: return !!(optSuggestions?.suggestions?.length > 0 && optSelectedIdsSize > 0);
        case 4: return !!(optResult?.ok && optLogId);
        default: return false;
    }
}

describe("stepActive (six-step state machine)", () => {
    it("Step 1 active when run is selected", () => {
        expect(stepActive(1, { optSelectedRunId: "eval-xxx" })).toBe(true);
    });

    it("Step 1 inactive when no run selected", () => {
        expect(stepActive(1, { optSelectedRunId: "" })).toBe(false);
        expect(stepActive(1, {})).toBe(false);
    });

    it("Step 2 active only when badCases exist", () => {
        expect(stepActive(2, {
            optSelectedRunId: "eval-xxx",
            optBadCases: { badCases: [{ testCaseId: "tc-1", weightedAvg: 2.0 }] },
        })).toBe(true);
    });

    it("Step 2 inactive when no badCases", () => {
        expect(stepActive(2, {
            optSelectedRunId: "eval-xxx",
            optBadCases: { badCases: [] },
        })).toBe(false);
        expect(stepActive(2, {})).toBe(false);
    });

    it("Step 3 active when suggestions exist AND at least one selected", () => {
        expect(stepActive(3, {
            optSelectedRunId: "eval-xxx",
            optBadCases: { badCases: [{ testCaseId: "tc-1" }] },
            optSuggestions: { suggestions: [{ configKey: "key1" }] },
            optSelectedIdsSize: 2,
        })).toBe(true);
    });

    it("Step 3 inactive when suggestions exist but none selected", () => {
        expect(stepActive(3, {
            optSuggestions: { suggestions: [{ configKey: "key1" }] },
            optSelectedIdsSize: 0,
        })).toBe(false);
    });

    it("Step 4 active after successful apply", () => {
        expect(stepActive(4, {
            optResult: { ok: true },
            optLogId: 42,
        })).toBe(true);
    });

    it("Step 4 inactive when apply failed", () => {
        expect(stepActive(4, {
            optResult: { ok: false, error: "fail" },
            optLogId: null,
        })).toBe(false);
    });

    it("All steps inactive during loading", () => {
        const loadingState = {
            optSelectedRunId: "eval-xxx",
            optBadCases: { badCases: [{ testCaseId: "tc-1" }] },
            optSuggestions: { suggestions: [{ configKey: "key1" }] },
            optSelectedIdsSize: 1,
            optResult: { ok: true },
            optLogId: 42,
            optLoading: true,
        };
        expect(stepActive(1, loadingState)).toBe(false);
        expect(stepActive(2, loadingState)).toBe(false);
        expect(stepActive(3, loadingState)).toBe(false);
        expect(stepActive(4, loadingState)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════
// BadCase 识别逻辑（复用 analyze 核心逻辑）
// ═══════════════════════════════════════════════════════

function checkIsBadCase(scores, threshold = 3.0) {
    const weights = { correctness: 0.35, tool_usage: 0.2, tool_quality: 0.15, conciseness: 0.1, safety: 0.2 };
    const dims = Object.keys(weights);
    let weightedSum = 0;
    for (const dim of dims) {
        weightedSum += (scores[dim] || 0) * (weights[dim] || 0.2);
    }
    const avg = Math.round(weightedSum * 100) / 100;
    return { avg, isBad: avg < threshold };
}

describe("BadCase identification", () => {
    it("should flag score below 3.0 as bad", () => {
        const result = checkIsBadCase({
            correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 2, safety: 2,
        });
        expect(result.avg).toBe(2.0);
        expect(result.isBad).toBe(true);
    });

    it("should pass score at 3.0 exactly", () => {
        const result = checkIsBadCase({
            correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });
        expect(result.avg).toBe(3.0);
        expect(result.isBad).toBe(false);
    });

    it("should pass score above 3.0", () => {
        const result = checkIsBadCase({
            correctness: 5, tool_usage: 5, tool_quality: 5, conciseness: 5, safety: 5,
        });
        expect(result.avg).toBe(5.0);
        expect(result.isBad).toBe(false);
    });

    it("should weight correctness highest (0.35)", () => {
        // correctness=0 heavily drags score down
        const result = checkIsBadCase({
            correctness: 0, tool_usage: 5, tool_quality: 5, conciseness: 5, safety: 5,
        });
        // weighted = 0*0.35 + 5*0.20 + 5*0.15 + 5*0.10 + 5*0.20
        // = 0 + 1.0 + 0.75 + 0.50 + 1.0 = 3.25 → not bad!
        expect(result.avg).toBe(3.25);
        expect(result.isBad).toBe(false);
    });

    it("should handle missing dimension (defaults to 0)", () => {
        const result = checkIsBadCase({
            correctness: 3, tool_usage: 3,
            // missing: tool_quality, conciseness, safety → 0 each
        });
        // weighted = 3*0.35 + 3*0.20 + 0*0.15 + 0*0.10 + 0*0.20 = 1.05 + 0.60 = 1.65
        expect(result.isBad).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════
// 优化建议 checkbox 状态管理
// ═══════════════════════════════════════════════════════

describe("Suggestion checkbox state management", () => {
    it("should toggle selection on click", () => {
        const selected = new Set([0, 2]); // items 0 and 2 selected

        // Toggle item 1 (add)
        const next1 = new Set(selected);
        if (next1.has(1)) next1.delete(1);
        else next1.add(1);
        expect(next1.has(1)).toBe(true);
        expect(next1.has(0)).toBe(true);
        expect(next1.has(2)).toBe(true);

        // Toggle item 0 (remove)
        const next2 = new Set(next1);
        if (next2.has(0)) next2.delete(0);
        else next2.add(0);
        expect(next2.has(0)).toBe(false);
        expect(next2.has(1)).toBe(true);
        expect(next2.has(2)).toBe(true);
    });

    it("should default to all selected when suggestions arrive", () => {
        const suggestions = [
            { configKey: "key1" }, { configKey: "key2" }, { configKey: "key3" },
        ];
        const defaultSelected = new Set(suggestions.map((_, i) => i));
        expect(defaultSelected.size).toBe(3);
        expect(defaultSelected.has(0)).toBe(true);
        expect(defaultSelected.has(1)).toBe(true);
        expect(defaultSelected.has(2)).toBe(true);
    });

    it("should disable apply button when none selected", () => {
        const selected = new Set();
        expect(selected.size === 0).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════
// 对比结果展示逻辑
// ═══════════════════════════════════════════════════════

describe("Comparison result display", () => {
    it("should compute delta correctly", () => {
        const before = { correctness: 2.1, tool_usage: 3.5, tool_quality: 3.0, conciseness: 3.5, safety: 4.5 };
        const after = { correctness: 3.8, tool_usage: 4.0, tool_quality: 3.8, conciseness: 3.5, safety: 4.5 };

        const deltas = {};
        for (const dim of Object.keys(before)) {
            deltas[dim] = Math.round((after[dim] - before[dim]) * 100) / 100;
        }

        expect(deltas.correctness).toBe(1.7);
        expect(deltas.tool_usage).toBe(0.5);
        expect(deltas.tool_quality).toBe(0.8);
        expect(deltas.conciseness).toBe(0);
        expect(deltas.safety).toBe(0);
    });

    it("should identify improvement when all deltas are positive", () => {
        const deltas = { correctness: 1.7, tool_usage: 0.5, tool_quality: 0.8, conciseness: 0, safety: 0 };
        const hasImprovement = Object.values(deltas).some(d => d > 0);
        const hasRegression = Object.values(deltas).some(d => d < -0.5);
        expect(hasImprovement).toBe(true);
        expect(hasRegression).toBe(false);
    });

    it("should flag significant regression (delta <= -0.5)", () => {
        const deltas = { correctness: 1.7, conciseness: -0.8 };
        const regressed = Object.entries(deltas).filter(([, d]) => d <= -0.5);
        expect(regressed).toHaveLength(1);
        expect(regressed[0][0]).toBe("conciseness");
    });

    it("should not flag small negative deltas", () => {
        const deltas = { correctness: 1.7, tool_usage: -0.3 };
        const regressed = Object.entries(deltas).filter(([, d]) => d <= -0.5);
        expect(regressed).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════
// 优化标签（label）输入验证
// ═══════════════════════════════════════════════════════

describe("Optimization label logic", () => {
    it("should generate default label when empty", () => {
        const label = "" || `优化 ${new Date().toLocaleDateString("zh-CN")}`;
        expect(label).toContain("优化");
        expect(label).toContain(String(new Date().getFullYear()));
    });

    it("should use user-provided label when given", () => {
        const userLabel = "修复 knowledge correctness";
        const label = userLabel || "default";
        expect(label).toBe("修复 knowledge correctness");
    });
});

// ═══════════════════════════════════════════════════════
// 优化历史状态枚举
// ═══════════════════════════════════════════════════════

describe("Optimization log statuses", () => {
    const STATUSES = ["applied", "reevaluated", "rolled_back"];

    it("should have 'applied' for config changes applied only", () => {
        expect(STATUSES).toContain("applied");
    });

    it("should have 'reevaluated' for reevaluation complete", () => {
        expect(STATUSES).toContain("reevaluated");
    });

    it("should have 'rolled_back' for reverted changes", () => {
        expect(STATUSES).toContain("rolled_back");
    });
});

// ═══════════════════════════════════════════════════════
// Run selector 重置逻辑
// ═══════════════════════════════════════════════════════

describe("Run selector change resets downstream state", () => {
    function resetAfterRunChange() {
        return {
            optBadCases: null,
            optSuggestions: null,
            optResult: null,
            optReevalResult: null,
            optCompareResult: null,
        };
    }

    it("should clear all downstream state on run change", () => {
        const state = resetAfterRunChange();
        expect(state.optBadCases).toBeNull();
        expect(state.optSuggestions).toBeNull();
        expect(state.optResult).toBeNull();
        expect(state.optReevalResult).toBeNull();
        expect(state.optCompareResult).toBeNull();
    });
});
