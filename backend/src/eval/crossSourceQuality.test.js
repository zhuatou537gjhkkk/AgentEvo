import { describe, expect, it } from "vitest";
import { aggregateCrossSourceQuality, evaluateCrossSourceQuality } from "./crossSourceQuality.js";
import { calibrateCrossSourceWeights } from "./crossSourceCalibration.js";

function traceWith(diagnostics) {
    return { metadata: { cross_source_recall: diagnostics } };
}

const baseDiagnostics = {
    selected: [
        { id: "u-1", sourceType: "user_memory", score: 0.9 },
        { id: "p-1", sourceType: "project_memory", score: 0.85 },
        { id: "r-1", sourceType: "rag", score: 0.8 },
    ],
    selectedTokens: 120,
    config: { maxItems: 10, maxTokens: 1000 },
    bySource: {
        user_memory: { selected: 1, cap: 4 },
        project_memory: { selected: 1, cap: 4 },
        rag: { selected: 1, cap: 4 },
    },
    errors: {},
};

describe("cross-source quality", () => {
    it("scores useful multi-source recall and keeps diagnostics content-free", () => {
        const result = evaluateCrossSourceQuality({
            id: "scenario-1",
            category: "cross_source_recall",
            crossSourceChecks: {
                requiredSourceTypes: ["user_memory", "project_memory", "rag"],
                outputAny: ["建议"],
            },
        }, { text: "根据项目文档和我的偏好给出实现建议。", trace: traceWith(baseDiagnostics) });

        expect(result.status).toBe("evaluated");
        expect(result.passed).toBe(true);
        expect(result.metrics.sourceCoverage).toBe(1);
        expect(result.metrics.budgetCompliance).toBe(1);
    });

    it("fails when a forbidden candidate is selected or leaked into the answer", () => {
        const result = evaluateCrossSourceQuality({
            id: "scenario-2",
            category: "cross_source_recall",
            crossSourceChecks: {
                forbiddenIds: ["foreign-user-memory"],
                outputNone: ["foreign secret"],
            },
        }, {
            text: "foreign secret was used",
            trace: traceWith({ ...baseDiagnostics, selected: [{ id: "foreign-user-memory", sourceType: "user_memory", score: 0.9 }] }),
        });

        expect(result.passed).toBe(false);
        expect(result.metrics.isolation).toBe(0);
    });

    it("reports missing trace as unavailable instead of silently passing", () => {
        const result = evaluateCrossSourceQuality({ id: "scenario-3", category: "cross_source_recall" }, { text: "ok" });
        expect(result.status).toBe("unavailable");
        expect(result.passed).toBe(false);
        expect(aggregateCrossSourceQuality([{ crossSourceQuality: result }])).toMatchObject({ evaluated: 0, unavailable: 1, passRate: null });
    });

    it("calibrates ranking weights deterministically from labeled scenarios", () => {
        const report = calibrateCrossSourceWeights([
            {
                now: Date.parse("2026-09-11T00:00:00Z"),
                candidates: [
                    { id: "recent", relevanceScore: 0.75, timestamp: "2026-09-10T00:00:00Z", metadata: { type: "memory", confidence: 0.9, importance: 0.8 } },
                    { id: "old", relevanceScore: 0.76, timestamp: "2025-01-01T00:00:00Z", metadata: { type: "memory", confidence: 0.9, importance: 0.8 } },
                ],
                expectedIds: ["recent"],
            },
        ], { weightCandidates: [{ relevance: 0.3, confidence: 0.1, importance: 0.1, recency: 0.4, trust: 0.1 }] });

        expect(report.version).toBe("cross-source-calibration-v1");
        expect(report.evaluatedScenarios).toBe(1);
        expect(report.best.weights.recency).toBeGreaterThan(0);
        expect(report.best.score).toBeGreaterThanOrEqual(report.baseline.score);
    });
});
