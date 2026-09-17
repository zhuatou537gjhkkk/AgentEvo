import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";
import { clearMemoryVectorRecallCache } from "./memoryVectorRecall.js";

const USER_ID = 1;
const previousVectorFlag = process.env.MEMORY_VECTOR_RECALL_V2;
const previousTypeAwareFlag = process.env.MEMORY_TYPE_AWARE_SCORING_V2;

function semanticTestEmbedder() {
    const vectorFor = (value) => /简洁|简明|短一些/.test(String(value)) ? [1, 0] : [0, 1];
    return {
        async embed(texts) { return (Array.isArray(texts) ? texts : [texts]).map(vectorFor); },
        async embedOne(text) { return vectorFor(text); },
    };
}

describe("user memory hybrid vector recall", () => {
    let memory;

    beforeEach(() => {
        process.env.MEMORY_VECTOR_RECALL_V2 = "true";
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "false";
        clearMemoryVectorRecallCache();
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    afterAll(() => {
        clearMemoryVectorRecallCache();
        if (previousVectorFlag == null) delete process.env.MEMORY_VECTOR_RECALL_V2;
        else process.env.MEMORY_VECTOR_RECALL_V2 = previousVectorFlag;
        if (previousTypeAwareFlag == null) delete process.env.MEMORY_TYPE_AWARE_SCORING_V2;
        else process.env.MEMORY_TYPE_AWARE_SCORING_V2 = previousTypeAwareFlag;
    });

    it("recalls a semantic paraphrase through the vector candidate path", async () => {
        const id = memory.add("用户喜欢简洁回答", "semantic", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });

        const result = await memory.recallHybrid("回答尽量简明", {
            embedder: semanticTestEmbedder(),
            vectorWeight: 1,
            candidateLimit: 1,
            maxItems: 1,
            maxTokens: 100,
            minImportance: 0.3,
        });

        expect(result.memories[0]).toMatchObject({ id, content: "用户喜欢简洁回答" });
        expect(result.diagnostics).toMatchObject({
            retrievalMode: "hybrid",
            vectorCandidates: 1,
            vectorEnabled: true,
        });
        expect(result.memories[0].recallReasons).toContain("vector_match");
    });

    it("falls back to lexical recall when the embedding provider fails", async () => {
        memory.add("用户偏好 TypeScript", "semantic", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });
        const failingEmbedder = {
            async embed() { throw new Error("embedding unavailable"); },
            async embedOne() { throw new Error("embedding unavailable"); },
        };

        const result = await memory.recallHybrid("TypeScript", {
            embedder: failingEmbedder,
            candidateLimit: 5,
            maxItems: 1,
            maxTokens: 100,
        });

        expect(result.memories).toHaveLength(1);
        expect(result.diagnostics.retrievalMode).toBe("lexical_fallback");
        expect(result.diagnostics.vectorError).toContain("embedding unavailable");
    });

    it("uses the same type-aware scorer for lexical, vector, and hybrid paths", async () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const id = memory.add("用户喜欢简洁回答", "semantic", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });

        process.env.MEMORY_VECTOR_RECALL_V2 = "false";
        const lexical = await memory.recallHybrid("简洁", {
            candidateLimit: 5,
            maxItems: 1,
            maxTokens: 100,
        });
        expect(lexical.diagnostics.retrievalMode).toBe("lexical");

        process.env.MEMORY_VECTOR_RECALL_V2 = "true";
        clearMemoryVectorRecallCache();
        const vector = await memory.recallHybrid("短一些", {
            embedder: semanticTestEmbedder(),
            vectorWeight: 1,
            candidateLimit: 1,
            maxItems: 1,
            maxTokens: 100,
        });
        const hybrid = await memory.recallHybrid("简洁回答", {
            embedder: semanticTestEmbedder(),
            vectorWeight: 0.5,
            candidateLimit: 5,
            maxItems: 1,
            maxTokens: 100,
        });

        for (const result of [lexical, vector, hybrid]) {
            expect(result.memories[0]).toMatchObject({
                id,
                recallWeightProfile: "semantic",
            });
            expect(result.memories[0].recallScoreComponents.type).toBe("semantic");
            expect(result.memories[0].recallScore).toBeGreaterThanOrEqual(0);
            expect(result.memories[0].recallScore).toBeLessThanOrEqual(1);
        }
        expect(vector.diagnostics.vectorCandidates).toBeGreaterThan(0);
        expect(hybrid.diagnostics.retrievalMode).toBe("hybrid");
    });
});
