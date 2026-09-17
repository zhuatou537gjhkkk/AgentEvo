import { describe, expect, it } from "vitest";
import { normalizeRagEvalReport, normalizeRagTelemetry } from "../rag.js";

describe("K11 RAG API mappers", () => {
    it("normalizes partial telemetry and calculates recent p95 without exposing query text", () => {
        const result = normalizeRagTelemetry({ telemetry: { summary: { total: 3, hit: 2, hitRate: 2 / 3 }, recent: [{ id: 1, status: "hit", latency_ms: 10, query_preview: "secret" }, { id: 2, status: "error", latency_ms: 30 }] } });
        expect(result.summary).toMatchObject({ total: 3, hit: 2, noMatch: 0 });
        expect(result.recentP95LatencyMs).toBe(30);
        expect(result.recent[0]).not.toHaveProperty("queryPreview");
    });

    it("keeps missing profile metrics nullable and preserves sample counts", () => {
        const result = normalizeRagEvalReport({ ragEval: { available: true, datasetVersion: "rag-v1", profiles: { hybrid: { summary: { sampleCount: 4, recallAtK: 0.8 } } } } });
        expect(result).toMatchObject({ available: true, datasetVersion: "rag-v1", profiles: { hybrid: { sampleCount: 4, recallAtK: 0.8, mrr: null } } });
        expect(result.profiles.full).toBeUndefined();
    });
});
