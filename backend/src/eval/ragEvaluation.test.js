import { describe, expect, it } from "vitest";
import {
    RAG_GOLDEN_CASES,
    RAG_GOLDEN_FIXTURES,
    aggregateRagEvaluation,
    evaluateRagCase,
    runRagEvaluation,
    validateRagGoldenCases,
} from "./ragEvaluation.js";

describe("K7 knowledge RAG evaluation", () => {
    it("contains the required deterministic golden scenarios", () => {
        expect(RAG_GOLDEN_CASES).toHaveLength(12);
        expect(Object.keys(RAG_GOLDEN_FIXTURES)).toEqual(expect.arrayContaining(RAG_GOLDEN_CASES.map((item) => item.id)));
        expect(Object.values(RAG_GOLDEN_FIXTURES).every((items) => Array.isArray(items) && items.length > 0)).toBe(true);
        expect(validateRagGoldenCases().ok).toBe(true);
        expect(new Set(RAG_GOLDEN_CASES.map((item) => item.category))).toEqual(new Set([
            "semantic", "exact_term", "cross_page", "table", "formula", "ocr_pdf",
            "ocr_image", "no_answer", "revision", "owner_isolation", "provider_retry", "restart_recovery",
        ]));
    });

    it("computes Recall@K, MRR, nDCG, citation page accuracy and no-answer precision", () => {
        const positive = evaluateRagCase(RAG_GOLDEN_CASES[0], {
            status: "ok",
            items: [{ chunkId: "doc-cn-restart", pageStart: 2, pageEnd: 2 }],
            metrics: { latencyMs: 12, embeddingCalls: 1, compression: { ratio: 0.4 } },
        });
        const negative = evaluateRagCase(RAG_GOLDEN_CASES[7], { status: "no_match", items: [] });
        const summary = aggregateRagEvaluation([positive, negative]);

        expect(positive.recallAtK).toBe(1);
        expect(positive.reciprocalRank).toBe(1);
        expect(positive.ndcgAtK).toBe(1);
        expect(positive.pageAccuracy).toBe(1);
        expect(negative.noAnswerCorrect).toBe(true);
        expect(summary.noAnswerPrecision).toBe(1);
        expect(summary.avgCompressionRatio).toBe(0.4);
        expect(summary.embeddingCalls).toBe(1);
    });

    it("marks stale or cross-owner evidence as a deterministic failure", () => {
        const testCase = RAG_GOLDEN_CASES[8];
        const result = evaluateRagCase(testCase, {
            status: "ok",
            items: [{ chunkId: "doc-revision-old", pageStart: 21 }],
        });
        expect(result.excludedPresent).toBe(true);
        expect(result.passed).toBe(false);
    });

    it("runs an injected offline retriever and isolates provider errors", async () => {
        let clock = 100;
        const report = await runRagEvaluation({
            cases: RAG_GOLDEN_CASES.slice(0, 2),
            now: () => (clock += 5),
            retrieve: async (testCase) => ({
                status: "ok",
                items: [{ chunkId: testCase.relevantChunkIds[0], pageStart: testCase.expectedPages[0] }],
                metrics: { rerankLatencyMs: 2 },
            }),
        });
        expect(report.summary.total).toBe(2);
        expect(report.summary.passed).toBe(2);
        expect(report.summary.avgRerankLatencyMs).toBe(2);
    });
});
