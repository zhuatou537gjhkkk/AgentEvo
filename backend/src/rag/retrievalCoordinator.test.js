import { afterEach, describe, expect, it } from "vitest";
import { buildCrossSourceCitationText, dedupePackets, retrieveAcrossSources } from "./retrievalCoordinator.js";
import { clearRagFlags } from "./flags.js";

const scope = { userId: 101, tenantId: "user:101" };

afterEach(() => {
    clearRagFlags();
});

function projectHit(content = "代码说明") {
    return {
        status: "ok",
        mode: "hybrid",
        items: [{
            chunkId: "code-1",
            content,
            score: 0.92,
            filePath: "src/auth.js",
            startLine: 10,
            endLine: 18,
            commit: "abc123",
        }],
    };
}

function knowledgeHit(content = "文档说明") {
    return {
        status: "ok",
        mode: "hybrid",
        items: [{
            chunkId: "doc-1",
            content,
            score: 0.88,
            documentId: "doc-1",
            fileName: "guide.pdf",
            pageStart: 3,
            pageEnd: 4,
            headingPath: ["部署", "配置"],
        }],
    };
}

describe("K12 retrieval coordinator", () => {
    it("runs both authorized sources concurrently and emits typed citations", async () => {
        const calls = [];
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "如何部署",
            deps: {
                projectRetrieval: async (input) => {
                    calls.push({ source: "project", input });
                    return projectHit();
                },
                knowledgeRetrieval: async (input) => {
                    calls.push({ source: "knowledge", input });
                    return knowledgeHit();
                },
            },
        });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("cross_source");
        expect(result.items.map((item) => item.sourceType)).toEqual(["rag", "knowledge"]);
        expect(result.metrics.sources.project_code.status).toBe("ok");
        expect(result.metrics.sources.knowledge.status).toBe("ok");
        expect(result.text).toContain("[项目代码: src/auth.js:10-18 @ abc123]");
        expect(result.text).toContain("[知识库文档: guide.pdf p.3-4 · 部署 > 配置]");
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.input.scope).toEqual(scope);
            expect(call.input.query).toBe("如何部署");
        }
    });

    it("isolates one source failure and keeps the healthy source evidence", async () => {
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "部署",
            deps: {
                projectRetrieval: async () => ({ status: "error", errorCode: "PROJECT_DOWN", items: [] }),
                knowledgeRetrieval: async () => knowledgeHit("知识库仍然可用"),
            },
        });

        expect(result.status).toBe("ok");
        expect(result.items).toHaveLength(1);
        expect(result.items[0].sourceType).toBe("knowledge");
        expect(result.metrics.errors).toEqual({ project_code: { code: "PROJECT_DOWN" } });
    });

    it("returns no_match when both sources are healthy but empty", async () => {
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "不存在",
            deps: {
                projectRetrieval: async () => ({ status: "no_match", items: [] }),
                knowledgeRetrieval: async () => ({ status: "no_match", items: [] }),
            },
        });

        expect(result.status).toBe("no_match");
        expect(result.errorCode).toBeNull();
        expect(result.metrics.healthySources).toBe(2);
    });

    it("returns error only when both sources fail", async () => {
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "故障",
            deps: {
                projectRetrieval: async () => { throw new Error("project failure"); },
                knowledgeRetrieval: async () => ({ status: "error", errorCode: "KNOWLEDGE_DOWN", items: [] }),
            },
        });

        expect(result.status).toBe("error");
        expect(result.errorCode).toBe("CROSS_SOURCE_RETRIEVAL_FAILED");
        expect(result.metrics.errors).toEqual({
            project_code: { code: "PROJECT_RAG_QUERY_FAILED" },
            knowledge: { code: "KNOWLEDGE_DOWN" },
        });
    });

    it("deduplicates identical content before applying the shared budget", async () => {
        const duplicate = projectHit("同一份证据");
        duplicate.items[0].chunkId = "code-duplicate";
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "重复证据",
            deps: {
                projectRetrieval: async () => projectHit("同一份证据"),
                knowledgeRetrieval: async () => ({ ...duplicate, items: [{ ...duplicate.items[0], fileName: "same.md", pageStart: 1 }] }),
            },
        });

        expect(result.status).toBe("ok");
        expect(result.items).toHaveLength(1);
        expect(result.metrics.deduped).toBe(1);
        expect(dedupePackets(result.packets).deduped).toBe(0);
    });

    it("formats source-specific citations without mixing provenance", () => {
        const text = buildCrossSourceCitationText([
            { sourceType: "rag", content: "code", provenance: { file: "a.js", startLine: 1, endLine: 2, commit: "c" } },
            { sourceType: "knowledge", content: "doc", provenance: { fileName: "a.pdf", pageStart: 2, pageEnd: 2 } },
        ]);
        expect(text).toContain("[项目代码: a.js:1-2 @ c]");
        expect(text).toContain("[知识库文档: a.pdf p.2]");
        expect(text).not.toContain("a.pdf:1-");
    });

    it("creates one shared rewrite plan for both sources", async () => {
        process.env.RAG_QUERY_REWRITE_ENABLED = "true";
        process.env.RAG_CONTEXTUAL_QUERY_REWRITE_ENABLED = "true";
        let rewriteCalls = 0;
        const plans = [];
        const rewriteContext = {
            version: 1,
            recentTurns: [{ role: "assistant", content: "当前任务说明" }],
            summary: "正在完成 RAG 改造",
            workingState: { currentGoal: "完成 RAG 改造", constraints: [], completedSteps: [], nextStep: "补测试" },
        };
        const result = await retrieveAcrossSources({
            scope,
            projectId: "project-a",
            query: "这个怎么修改",
            opts: { rewriteContext, skipTelemetry: true },
            deps: {
                queryRewriter: async ({ query, context }) => {
                    rewriteCalls += 1;
                    expect(query).toBe("这个怎么修改");
                    expect(context).toEqual(rewriteContext);
                    return { rewrite: "修改当前 RAG 改造", used_context: true, meta: { model: "fake", calls: 1 } };
                },
                projectRetrieval: async (input) => {
                    plans.push(input.opts.queryPlan);
                    return projectHit("项目证据");
                },
                knowledgeRetrieval: async (input) => {
                    plans.push(input.opts.queryPlan);
                    return knowledgeHit("文档证据");
                },
            },
        });

        expect(result.status).toBe("ok");
        expect(rewriteCalls).toBe(1);
        expect(plans).toHaveLength(2);
        expect(plans[0]).toEqual(plans[1]);
        expect(plans[0].queries).toEqual(["这个怎么修改", "修改当前 RAG 改造"]);
        expect(result.metrics.rewrite.contextual).toBe(true);
        expect(result.metrics.rewrite.contextUsed).toEqual(["recent_turns", "summary", "working_memory"]);
    });
});
