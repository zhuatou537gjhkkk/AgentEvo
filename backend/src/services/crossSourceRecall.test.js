import { afterEach, describe, expect, it } from "vitest";
import {
    crossSourceConfig,
    recallAcrossSources,
    selectCrossSourceCandidates,
    sourceTypeForPacket,
} from "./crossSourceRecall.js";
import { ContextBuilder, ContextConfig } from "./contextBuilder.js";
import { clearMemoryFlags } from "./memoryFlags.js";

afterEach(() => {
    clearMemoryFlags();
});

function packet(sourceType, content, relevanceScore = 0.8, extra = {}) {
    return {
        content,
        tokenCount: Math.max(1, content.length),
        relevanceScore,
        metadata: { type: sourceType === "user_memory" ? "memory" : sourceType, sourceType, ...extra },
    };
}

describe("M9 cross-source recall", () => {
    it("recognizes legacy packet types and explicit contract source types", () => {
        expect(sourceTypeForPacket({ metadata: { type: "memory" } })).toBe("user_memory");
        expect(sourceTypeForPacket({ metadata: { type: "memory", projectMemory: true } })).toBe("project_memory");
        expect(sourceTypeForPacket({ metadata: { type: "rag" } })).toBe("rag");
        expect(sourceTypeForPacket({ metadata: { type: "repo" } })).toBeNull();
    });

    it("gives each available source a first-pass slot before score fill", () => {
        const result = selectCrossSourceCandidates([
            packet("user_memory", "user-1", 0.99),
            packet("user_memory", "user-2", 0.98),
            packet("user_memory", "user-3", 0.97),
            packet("project_memory", "project-1", 0.7),
            packet("rag", "rag-1", 0.6),
        ], { maxItems: 10, maxTokens: 1000, sourceCaps: { user_memory: 2, project_memory: 2, rag: 2 } });

        expect(result.selected).toHaveLength(4);
        expect(result.bySource.user_memory.selected).toBe(2);
        expect(result.bySource.project_memory.selected).toBe(1);
        expect(result.bySource.rag.selected).toBe(1);
        expect(result.dropped.some((item) => item.reason === "source_cap")).toBe(true);
    });

    it("enforces total token budget and records explainable drops", () => {
        const user = packet("user_memory", "1234567890", 0.9);
        const rag = packet("rag", "abcdefghij", 0.8);
        user.tokenCount = 80;
        rag.tokenCount = 80;
        const result = selectCrossSourceCandidates([user, rag], { maxItems: 10, maxTokens: 100 });
        expect(result.selectedTokens).toBeLessThanOrEqual(100);
        expect(result.dropped.some((item) => item.reason === "cross_source_budget")).toBe(true);
    });

    it("isolates source loader errors and still returns healthy sources", async () => {
        const result = await recallAcrossSources({
            user_memory: async () => { throw Object.assign(new Error("provider detail"), { code: "MEMORY_READ_FAILED" }); },
            project_memory: async () => [packet("project_memory", "healthy project fact")],
            rag: [packet("rag", "healthy rag evidence")],
        });
        expect(result.errors).toEqual({ user_memory: { code: "MEMORY_READ_FAILED" } });
        expect(result.selected.map((item) => item.content)).toEqual(expect.arrayContaining(["healthy project fact", "healthy rag evidence"]));
    });

    it("applies the cross-source policy inside ContextBuilder and exposes diagnostics", async () => {
        process.env.MEMORY_CROSS_SOURCE_V2 = "true";
        process.env.MEMORY_RECALL_V2 = "true";
        const memory = {
            userId: 7,
            recall: () => ({
                memories: [{ id: 1, content: "用户偏好简洁回答", memory_type: "semantic", status: "active", confidence: 0.9, relevanceScore: 0.9, created_at: new Date().toISOString() }],
                diagnostics: { enabled: true, selected: [1], dropped: [] },
            }),
            recordRecall: () => 1,
        };
        const builder = new ContextBuilder(new ContextConfig({ maxTokens: 2000 }), memory);
        const context = await builder.build("解释项目鉴权", [], "你是助手", {
            projectPackets: [packet("project_memory", "项目事实：鉴权使用 SQLite", 0.8, { type: "memory", projectMemory: true })],
            ragPackets: [packet("rag", "代码证据：src/auth.js", 0.85)],
            crossSourceMaxItems: 3,
            crossSourceMaxTokens: 500,
        });
        expect(context).toContain("用户偏好简洁回答");
        expect(context).toContain("项目事实：鉴权使用 SQLite");
        expect(context).toContain("代码证据：src/auth.js");
        expect(builder.lastCrossSourceRecall).toMatchObject({ enabled: true, selected: expect.any(Array), errors: {} });
        expect(builder.lastCrossSourceRecall.bySource.user_memory.selected).toBe(1);
        expect(builder.lastCrossSourceRecall.bySource.project_memory.selected).toBe(1);
        expect(builder.lastCrossSourceRecall.bySource.rag.selected).toBe(1);
        expect(JSON.stringify(builder.lastCrossSourceRecall)).not.toContain("用户偏好简洁回答");
        expect(JSON.stringify(builder.lastCrossSourceRecall)).not.toContain("代码证据：src/auth.js");
    });

    it("keeps the control arm free of cross-source packets", async () => {
        process.env.MEMORY_CROSS_SOURCE_V2 = "true";
        process.env.MEMORY_RECALL_V2 = "true";
        const memory = {
            userId: 7,
            recall: () => ({
                memories: [{ id: 2, content: "控制组不应注入的用户偏好", memory_type: "semantic", status: "active", confidence: 0.9, relevanceScore: 0.9, created_at: new Date().toISOString() }],
                diagnostics: { enabled: true, selected: [2], dropped: [] },
            }),
            recordRecall: () => 1,
        };
        const builder = new ContextBuilder(new ContextConfig({ maxTokens: 2000 }), memory);
        const context = await builder.build("解释项目鉴权", [], "你是助手", {
            projectPackets: [packet("project_memory", "控制组不应注入的项目事实", 0.9, { type: "memory", projectMemory: true })],
            crossSourceExperiment: { group: "control" },
        });
        expect(context).not.toContain("控制组不应注入的用户偏好");
        expect(context).not.toContain("控制组不应注入的项目事实");
        expect(builder.lastCrossSourceRecall).toMatchObject({ enabled: true, experimentGroup: "control", selected: [] });
    });

    it("keeps configuration bounded and source caps explicit", () => {
        const config = crossSourceConfig({ maxItems: 999, maxTokens: 999999, sourceCaps: { search: 99 } });
        expect(config.maxItems).toBe(50);
        expect(config.maxTokens).toBe(20000);
        expect(config.sourceCaps.search).toBe(20);
    });
});
