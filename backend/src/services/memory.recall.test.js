import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";
import {
    DEFAULT_RECALL_WEIGHTS,
    TYPE_AWARE_RECALL_WEIGHTS,
    rankMemoryCandidates,
    resolveRecallWeights,
    scoreMemoryCandidate,
} from "./memoryRecall.js";
import { ContextBuilder, ContextConfig } from "./contextBuilder.js";
import { MEMORY_FLAG_NAMES, clearMemoryFlags, memoryTypeAwareScoringEnabled } from "./memoryFlags.js";

const USER_ID = 1;
const previousFlag = process.env.MEMORY_RECALL_V2;
const previousTypeAwareFlag = process.env.MEMORY_TYPE_AWARE_SCORING_V2;

describe("memory recall and context injection", () => {
    let memory;

    beforeEach(() => {
        process.env.MEMORY_RECALL_V2 = "true";
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "false";
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    afterEach(() => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "false";
    });

    afterAll(() => {
        if (previousFlag == null) delete process.env.MEMORY_RECALL_V2;
        else process.env.MEMORY_RECALL_V2 = previousFlag;
        if (previousTypeAwareFlag == null) delete process.env.MEMORY_TYPE_AWARE_SCORING_V2;
        else process.env.MEMORY_TYPE_AWARE_SCORING_V2 = previousTypeAwareFlag;
    });

    it("keeps the legacy formula exact while type-aware scoring is off", () => {
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        const score = scoreMemoryCandidate({
            relevanceScore: 0.9,
            confidence: 0.4,
            importance: 0.8,
            pinned: true,
            created_at: new Date(now).toISOString(),
        }, now);

        expect(score.score).toBe(0.88);
        expect(score).not.toHaveProperty("recallWeightProfile");
        expect(score).not.toHaveProperty("recallScoreComponents");
    });

    it("exposes the flag, clears it, and resolves normalized type profiles", () => {
        expect(MEMORY_FLAG_NAMES).toContain("MEMORY_TYPE_AWARE_SCORING_V2");
        expect(memoryTypeAwareScoringEnabled()).toBe(false);

        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        expect(memoryTypeAwareScoringEnabled()).toBe(true);
        expect(resolveRecallWeights("WORKING")).toEqual(TYPE_AWARE_RECALL_WEIGHTS.working);
        expect(resolveRecallWeights("episodic")).toEqual(TYPE_AWARE_RECALL_WEIGHTS.episodic);
        expect(resolveRecallWeights("semantic")).toEqual(TYPE_AWARE_RECALL_WEIGHTS.semantic);
        expect(resolveRecallWeights("future_type")).toEqual(DEFAULT_RECALL_WEIGHTS);
        expect(Object.values(resolveRecallWeights("working")).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);

        clearMemoryFlags();
        expect(memoryTypeAwareScoringEnabled()).toBe(false);
        process.env.MEMORY_RECALL_V2 = "true";
    });

    it("gives working memory the highest recency weight by memory type", () => {
        expect(TYPE_AWARE_RECALL_WEIGHTS.working.recency).toBeGreaterThan(TYPE_AWARE_RECALL_WEIGHTS.episodic.recency);
        expect(TYPE_AWARE_RECALL_WEIGHTS.episodic.recency).toBeGreaterThan(TYPE_AWARE_RECALL_WEIGHTS.semantic.recency);
        expect(TYPE_AWARE_RECALL_WEIGHTS.working.relevance).toBeGreaterThan(TYPE_AWARE_RECALL_WEIGHTS.working.recency);
    });

    it("uses recent event time for episodic ordering", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        const result = rankMemoryCandidates([
            { id: 1, status: "active", memory_type: "episodic", content: "older deploy event", relevanceScore: 0.8, confidence: 0.8, importance: 0.8, created_at: new Date(now - 180 * 86400000).toISOString() },
            { id: 2, status: "active", memory_type: "episodic", content: "recent deploy event", relevanceScore: 0.8, confidence: 0.8, importance: 0.8, created_at: new Date(now - 86400000).toISOString() },
        ], { maxItems: 2, maxTokens: 100 }, now);

        expect(result.selected.map((item) => item.id)).toEqual([2, 1]);
        expect(result.selected[0].recallWeightProfile).toBe("episodic");
    });

    it("lets a strong, old semantic fact beat a weak recent event", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        const result = rankMemoryCandidates([
            { id: 1, status: "active", memory_type: "semantic", content: "stable project fact", relevanceScore: 0.85, confidence: 0.95, importance: 0.9, created_at: new Date(now - 365 * 86400000).toISOString() },
            { id: 2, status: "active", memory_type: "episodic", content: "weak recent event", relevanceScore: 0.65, confidence: 0.2, importance: 0.2, created_at: new Date(now).toISOString() },
        ], { maxItems: 2, maxTokens: 100 }, now);

        expect(result.selected[0]).toMatchObject({ id: 1, recallWeightProfile: "semantic" });
        expect(result.selected[0].recallScore).toBeGreaterThan(result.selected[1].recallScore);
    });

    it("falls back to the default profile for missing or unknown memory types", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        for (const row of [{ id: 1 }, { id: 2, memory_type: "not-a-memory-type" }]) {
            const score = scoreMemoryCandidate({
                ...row,
                relevanceScore: 0.7,
                confidence: 0.8,
                importance: 0.6,
                created_at: new Date(now).toISOString(),
            }, now);
            expect(score.recallWeightProfile).toBe("default");
            expect(score.recallScoreComponents.weights).toEqual(DEFAULT_RECALL_WEIGHTS);
        }
    });

    it("keeps working memory out of cross-session defaults unless explicitly requested", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const workingId = memory.add("working-only scratch note", "working", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });
        const defaultResult = memory.recall("working-only scratch", { maxItems: 5, maxTokens: 100 });
        const explicitResult = memory.recall("working-only scratch", {
            memoryTypes: ["working"],
            maxItems: 5,
            maxTokens: 100,
        });

        expect(defaultResult.memories.map((item) => item.id)).not.toContain(workingId);
        expect(explicitResult.memories.map((item) => item.id)).toContain(workingId);
        expect(explicitResult.memories[0].recallWeightProfile).toBe("working");
    });

    it("clamps scores, preserves pinned bonus, and returns PII-free numeric explanations", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        const base = { memory_type: "semantic", relevanceScore: 1, confidence: 1, importance: 1, created_at: new Date(now).toISOString() };
        const unpinned = scoreMemoryCandidate(base, now);
        const pinned = scoreMemoryCandidate({ ...base, pinned: true }, now);

        expect(unpinned.score).toBeLessThanOrEqual(1);
        expect(unpinned.score).toBeGreaterThanOrEqual(0);
        expect(pinned.score).toBe(1);
        expect(unpinned.recallScoreComponents.contributions.pinnedBonus).toBe(0);
        expect(pinned.recallScoreComponents.contributions.pinnedBonus).toBe(0.08);
        expect(Object.keys(pinned.recallScoreComponents)).toEqual(["type", "weights", "contributions"]);
        expect(JSON.stringify(pinned.recallScoreComponents)).not.toContain("content");
    });

    it("keeps rank status, confidence, item, token, and tie-break behavior intact", () => {
        const now = Date.parse("2026-09-14T00:00:00.000Z");
        const result = rankMemoryCandidates([
            { id: 3, status: "pending", content: "pending", relevanceScore: 1, confidence: 1, created_at: new Date(now).toISOString() },
            { id: 2, status: "rejected", content: "rejected", relevanceScore: 1, confidence: 1, created_at: new Date(now).toISOString() },
            { id: 1, status: "invalidated", content: "invalidated", relevanceScore: 1, confidence: 1, created_at: new Date(now).toISOString() },
            { id: 4, status: "active", content: "a", relevanceScore: 0.8, confidence: 0.1, created_at: new Date(now).toISOString() },
            { id: 5, status: "active", content: "b", relevanceScore: 0.8, confidence: 0.9, created_at: new Date(now).toISOString() },
            { id: 6, status: "active", content: "c", relevanceScore: 0.8, confidence: 0.9, created_at: new Date(now).toISOString() },
        ], { maxItems: 1, maxTokens: 2, minConfidence: 0.2, typeAwareScoring: false }, now);

        expect(result.selected.map((item) => item.id)).toEqual([6]);
        expect(result.dropped).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 4, reason: "below_confidence" }),
            expect.objectContaining({ id: 5, reason: "max_items" }),
        ]));
        expect(result.scanned).toBe(6);
    });

    it("ranks by relevance plus trust signals and explains budget drops", () => {
        const result = rankMemoryCandidates([
            { id: 1, status: "active", content: "用户偏好 TypeScript", relevanceScore: 0.9, confidence: 0.95, importance: 0.8, created_at: new Date().toISOString() },
            { id: 2, status: "active", content: "用户以前提到过 JavaScript", relevanceScore: 0.5, confidence: 0.4, importance: 0.4, created_at: new Date().toISOString() },
        ], { maxItems: 1, maxTokens: 100 });

        expect(result.selected[0]).toMatchObject({ id: 1, recallReasons: expect.arrayContaining(["query_relevance", "high_confidence"]) });
        expect(result.dropped).toEqual(expect.arrayContaining([expect.objectContaining({ id: 2, reason: "max_items" })]));
    });

    it("records recall only after context acceptance, not candidate search", () => {
        const first = memory.add("用户偏好 TypeScript", "semantic", 0.9, {}, null, { status: "active", confidence: 0.95 });
        const second = memory.add("用户偏好 JavaScript", "semantic", 0.9, {}, null, { status: "active", confidence: 0.4 });
        const result = memory.recall("用户偏好", { candidateLimit: 10, maxItems: 1, maxTokens: 100 });

        expect(result.memories).toHaveLength(1);
        expect(memory.list(20).find((item) => item.id === first)?.recall_count || 0).toBe(0);
        expect(memory.list(20).find((item) => item.id === second)?.recall_count || 0).toBe(0);

        memory.recordRecall(result.memories.map((item) => item.id));
        expect(memory.list(20).find((item) => item.id === result.memories[0].id).recall_count).toBe(1);
    });

    it("keeps type-aware recall scoped to the owning user", () => {
        process.env.MEMORY_TYPE_AWARE_SCORING_V2 = "true";
        const otherUserId = createUser(`memory-recall-other-${Date.now()}`, "test-password-hash");
        const otherMemory = new MemoryService(otherUserId);
        otherMemory.forget("all");
        const ownId = memory.add("alice only preference", "semantic", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });
        const otherId = otherMemory.add("bob only preference", "semantic", 0.9, {}, null, {
            status: "active",
            confidence: 0.95,
        });

        const ownResult = memory.recall("alice preference", { memoryTypes: ["semantic"], maxItems: 5, maxTokens: 100 });
        const otherResult = otherMemory.recall("bob preference", { memoryTypes: ["semantic"], maxItems: 5, maxTokens: 100 });

        expect(ownResult.memories.map((item) => item.id)).toContain(ownId);
        expect(ownResult.memories.map((item) => item.id)).not.toContain(otherId);
        expect(otherResult.memories.map((item) => item.id)).toContain(otherId);
        expect(otherResult.memories.map((item) => item.id)).not.toContain(ownId);
        otherMemory.forget("all");
    });

    it("injects diagnostics and records only memories surviving the context budget", async () => {
        const builder = new ContextBuilder(new ContextConfig({ maxTokens: 600, memoryBudgetTokens: 200 }), {
            recall: () => ({
                memories: [{
                    id: 7,
                    content: "用户喜欢简洁回答",
                    memory_type: "semantic",
                    created_at: new Date().toISOString(),
                    recallScore: 0.95,
                    recallTokens: 8,
                    recallReasons: ["query_relevance", "high_confidence"],
                }],
                diagnostics: { enabled: true, scanned: 2, selected: [7], dropped: [], selectedTokens: 8 },
            }),
            recordRecall: (ids) => { builder.recorded = ids; },
        });

        const context = await builder.build("回答风格", [], "");
        expect(context).toContain("用户喜欢简洁回答");
        expect(builder.lastMemoryRecall).toMatchObject({ contextSelected: [7] });
        expect(builder.recorded).toEqual([7]);
    });
});
