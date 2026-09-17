import { describe, expect, it } from "vitest";
import { runRerank, validateRerankOutput } from "./reranker.js";

const candidates = [
    { chunkId: 1, rank: 1, content: "first" },
    { chunkId: 2, rank: 2, content: "second" },
];

describe("K6 reranker", () => {
    it("validates the provider allowlist and reorders candidates", async () => {
        const result = await runRerank({
            query: "second",
            candidates,
            provider: async () => JSON.stringify([
                { chunkId: "2", relevance: 0.95 },
                { chunkId: "1", relevance: 0.2 },
            ]),
        });

        expect(result.applied).toBe(true);
        expect(result.items.map((item) => item.chunkId)).toEqual([2, 1]);
        expect(result.items[0].content).toBe("second");
        expect(result.items[0].rerankScore).toBe(0.95);
    });

    it("rejects hallucinated IDs and falls back to fused order", async () => {
        const result = await runRerank({
            candidates,
            provider: async () => ({ items: [
                { chunkId: "ghost", relevance: 1 },
                { chunkId: "1", relevance: 0 },
            ] }),
        });

        expect(result.fallback).toBe(true);
        expect(result.reason).toBe("unknown-or-duplicate-id");
        expect(result.items.map((item) => item.chunkId)).toEqual([1, 2]);
        expect(validateRerankOutput([{ chunkId: "1", relevance: 2 }], candidates).ok).toBe(false);
    });

    it("falls back after provider timeout", async () => {
        const result = await runRerank({
            candidates,
            timeoutMs: 50,
            provider: () => new Promise(() => {}),
        });

        expect(result.fallback).toBe(true);
        expect(result.reason).toBe("RERANK_TIMEOUT");
        expect(result.items).toHaveLength(2);
    });

    it("uses deterministic pass-through without a provider", async () => {
        const result = await runRerank({ candidates });
        expect(result.applied).toBe(false);
        expect(result.fallback).toBe(false);
        expect(result.reason).toBe("deterministic-pass-through");
        expect(result.items.map((item) => item.chunkId)).toEqual([1, 2]);
    });
});
