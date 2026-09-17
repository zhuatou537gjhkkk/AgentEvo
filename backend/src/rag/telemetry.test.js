import { beforeEach, describe, expect, it } from "vitest";
import db, { initDB } from "../db/index.js";
import { getKnowledgeQuerySummary, getRecentKnowledgeQueries, recordKnowledgeQuery } from "./telemetry.js";

let nextUser = 24000;
function freshUser() {
    nextUser += 1;
    initDB();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
        .run(nextUser, `rag_telemetry_${nextUser}`, "x");
    return { userId: nextUser, tenantId: `user:${nextUser}` };
}

beforeEach(() => initDB());

describe("K7/K8 retrieval telemetry", () => {
    it("persists bounded retrieval/rerank/compression metrics and aggregates them", () => {
        const alice = freshUser();
        recordKnowledgeQuery({
            scope: alice,
            projectId: "__uploads__",
            mode: "dual-read",
            status: "hit",
            source: "durable",
            items: 2,
            latencyMs: 21,
            groundedness: 0.8,
            query: "private query text",
            metrics: {
                lexicalCount: 4,
                embeddingCount: 3,
                fusionCount: 5,
                rerankCount: 5,
                rerankLatencyMs: 7,
                compression: { ratio: 0.42 },
                embeddingCalls: 1,
                rewrite: { applied: true, latencyMs: 18, model: "current-chat-model", calls: 1, usage: { input_tokens: 10, output_tokens: 5 } },
                rerankApplied: true,
                rerankFallback: false,
                rerankModel: "current-chat-model",
                llmCalls: 2,
                rerankUsage: { input_tokens: 20, output_tokens: 8 },
                servedMode: "durable",
                fallbackCode: null,
                selectedItems: [
                    { chunkId: 101, documentId: "doc-a", content: "must not persist" },
                    { chunkId: 102, documentId: "doc-a" },
                ],
            },
        });

        const recent = getRecentKnowledgeQueries(alice, { limit: 1 })[0];
        expect(recent.lexical_count).toBe(4);
        expect(recent.embedding_count).toBe(3);
        expect(recent.rerank_latency_ms).toBe(7);
        expect(recent.compression_ratio).toBe(0.42);
        expect(recent.selected_chunk_ids).toBe("[101,102]");
        expect(recent.selected_document_ids).toBe('["doc-a"]');
        expect(recent.query_preview).toBe("private query text");
        expect(recent.rewrite_applied).toBe(1);
        expect(recent.rewrite_model).toBe("current-chat-model");
        expect(recent.rerank_applied).toBe(1);
        expect(recent.rerank_model).toBe("current-chat-model");
        expect(recent.llm_calls).toBe(2);
        expect(recent.llm_input_tokens).toBe(30);
        expect(recent.llm_output_tokens).toBe(13);

        const summary = getKnowledgeQuerySummary(alice);
        expect(summary.avgRerankLatencyMs).toBe(7);
        expect(summary.avgCompressionRatio).toBe(0.42);
        expect(summary.embeddingCalls).toBe(1);
        expect(summary.fallbackCount).toBe(0);
        expect(summary.llmCalls).toBe(2);
        expect(summary.rewriteApplied).toBe(1);
        expect(summary.rerankApplied).toBe(1);
    });

    it("keeps telemetry owner and tenant scoped", () => {
        const alice = freshUser();
        const bob = freshUser();
        recordKnowledgeQuery({ scope: alice, projectId: "p", status: "hit", query: "alice-only" });
        expect(getRecentKnowledgeQueries(alice, { limit: 5 }).some((row) => row.query_preview === "alice-only")).toBe(true);
        expect(getRecentKnowledgeQueries(bob, { limit: 5 }).some((row) => row.query_preview === "alice-only")).toBe(false);
        expect(getKnowledgeQuerySummary(bob).total).toBe(0);
    });
});
