import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { runKnowledgeProjectRagBranch, knowledgeAgentNode } from "./chatGraph.js";
import { runWithAuthenticatedContext } from "./requestContext.js";
import { clearRagFlags } from "../rag/flags.js";
import { clearGraphFlags } from "./graphFlags.js";

/**
 * Phase 7 / R4 (roadmap #7) — project-code RAG inside the knowledge node + the
 * R1 projectId plumbing. A NEW file: node-level unit tests that never construct
 * an LLM or touch the (still-under-construction) retrieval module — every call
 * injects a retrievalService fake through config.configurable.
 *
 * runKnowledgeProjectRagBranch is exercised DIRECTLY (it takes requestUserId as
 * a parameter), so ok/no_match/error shapes and provenance are asserted without
 * any request-context fixture. knowledgeAgentNode-level gating proves the branch
 * only fires when ALL of PROJECT_RAG_ENABLED + state.projectId + an injected
 * retrievalService + an authenticated request context hold — otherwise it falls
 * through to the legacy LLM+tools path (flagged by a sentinel makeLlm).
 */
const AGENT = "knowledge";
const LLM_REACHED = "__LLM_REACHED__"; // sentinel thrown when the legacy path runs
const FALLTHROUGH_MAKE_LLM = () => { throw new Error(LLM_REACHED); };

function baseState(overrides = {}) {
    return {
        messages: [],
        userInput: "找出 loginUser 的实现位置",
        chatHistory: [],
        currentDate: "2026-09-06 12:00:00",
        enableWebSearch: false,
        planMode: false,
        enableMemory: false,
        systemPrompt: "test",
        temperature: 0.7,
        modelName: "test-model",
        intent: "knowledge",
        intents: ["knowledge"],
        currentAgent: null,
        subTasks: [],
        planResults: {},
        currentSubTask: null,
        optimizedContext: "",
        ...overrides,
    };
}

function subTaskState(projectId = "proj_r4") {
    return baseState({
        projectId,
        plan: [],
        currentSubTask: { id: "st1", type: "agent", agent: "knowledge", goal: "定位 loginUser", title: "定位 loginUser", status: "in_progress" },
        subTasks: [{ id: "st1", type: "agent", agent: "knowledge", goal: "定位 loginUser", title: "定位 loginUser", status: "in_progress" }],
    });
}

function okRetrieval() {
    return {
        status: "ok",
        mode: "hybrid",
        items: [
            {
                filePath: "src/auth/loginUser.js",
                startLine: 1,
                endLine: 4,
                content: "export function loginUser(id) { ... }",
                commit: "abc123",
                provenance: { file: "src/auth/loginUser.js", startLine: 1, endLine: 4, commit: "abc123" },
            },
        ],
        text: "[1] src/auth/loginUser.js:1-4 @ abc123\nexport function loginUser(id) { ... }",
        metrics: { mode: "hybrid" },
    };
}

afterEach(() => {
    clearRagFlags();
    clearGraphFlags();
});

describe("runKnowledgeProjectRagBranch (R4 #7)", () => {
    it("ok retrieval → plan/subTask shape with provenance artifact, no LLM", async () => {
        const retrievalService = async () => okRetrieval();
        const state = subTaskState();
        const result = await runKnowledgeProjectRagBranch(state, { configurable: { retrievalService } }, null, [], AGENT, 7);

        expect(result.currentAgent).toBe(AGENT);
        expect(result.tokenUsage).toBeNull();
        expect(result.planResults.st1).toBe(okRetrieval().text);
        const agentResult = result.agentResults.st1;
        expect(agentResult.status).toBe("completed");
        expect(agentResult.errorCode).toBeNull();
        expect(agentResult.artifact.retrieval).toEqual({
            mode: "hybrid",
            projectId: "proj_r4",
            items: [{ file: "src/auth/loginUser.js", startLine: 1, endLine: 4, commit: "abc123" }],
        });
        // subTask settled to completed (DAG off)
        expect(result.subTasks.find((s) => s.id === "st1").status).toBe("completed");
    });

    it("no_match → plain non-error sentence, empty provenance items", async () => {
        const retrievalService = async () => ({ status: "no_match", mode: "lexical", items: [], text: "", metrics: null });
        const state = subTaskState();
        const result = await runKnowledgeProjectRagBranch(state, { configurable: { retrievalService } }, null, [], AGENT, 7);

        expect(result.planResults.st1).toBe("未检索到相关知识片段（项目代码库无匹配）");
        expect(result.agentResults.st1.artifact.retrieval.items).toEqual([]);
        expect(result.agentResults.st1.status).toBe("completed"); // DAG off → never an error
        expect(result.agentResults.st1.errorCode).toBeNull();
    });

    it("retrieval service throwing → error text + errorCode; DAG ON marks the subTask failed", async () => {
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = "1";
        const retrievalService = async () => { throw new Error("embedding backend down"); };
        const state = subTaskState();
        const result = await runKnowledgeProjectRagBranch(state, { configurable: { retrievalService } }, null, [], AGENT, 7);

        const text = result.planResults.st1;
        expect(text.startsWith("知识库检索出错:")).toBe(true);
        expect(text).toContain("知识库检索暂时不可用");
        const agentResult = result.agentResults.st1;
        expect(agentResult.errorCode).toBe("PROJECT_RAG_QUERY_FAILED");
        expect(agentResult.status).toBe("failed");
        expect(result.subTasks.find((s) => s.id === "st1").status).toBe("failed");
        expect(result.subTasks.find((s) => s.id === "st1").statusReason).toBe("项目代码库检索失败或不可用");
    });

    it("error status without a throw → errorCode preserved and text carries the required message", async () => {
        const retrievalService = async () => ({ status: "error", errorCode: "EMBEDDING_UNAVAILABLE", items: [], text: "", metrics: null });
        const state = subTaskState();
        const result = await runKnowledgeProjectRagBranch(state, { configurable: { retrievalService } }, null, [], AGENT, 7);
        expect(result.agentResults.st1.errorCode).toBe("EMBEDDING_UNAVAILABLE");
        expect(result.planResults.st1).toBe("知识库检索出错:EMBEDDING_UNAVAILABLE（知识库检索暂时不可用）");
    });

    it("solo (no currentSubTask) → text-only AIMessage + knowledgeResults, no planResults", async () => {
        const retrievalService = async () => okRetrieval();
        const state = baseState({ projectId: "proj_r4" }); // intents:["knowledge"] → solo
        const result = await runKnowledgeProjectRagBranch(state, { configurable: { retrievalService } }, null, [], AGENT, 7);

        expect(result.currentAgent).toBe(AGENT);
        expect(result.knowledgeResults).toBe(okRetrieval().text);
        expect(result.messages).toHaveLength(1);
        expect(String(result.messages[0].content)).toBe(okRetrieval().text);
        expect(result.planResults).toBeUndefined();
        expect(result.agentResults).toBeUndefined();
    });
});

describe("knowledgeAgentNode gating (branch fires only when all preconditions hold)", () => {
    const ctx = { userId: 7, tenantId: "user:7", requestId: "rq-r4" };

    it("flag OFF + projectId + retrievalService → falls through to legacy LLM path, retrieval never called", async () => {
        let retrievalCalls = 0;
        const retrievalService = async () => { retrievalCalls += 1; return okRetrieval(); };
        const state = baseState({ projectId: "proj_r4" });
        await expect(
            runWithAuthenticatedContext(ctx, () =>
                knowledgeAgentNode(state, { configurable: { retrievalService, makeLlm: FALLTHROUGH_MAKE_LLM } })),
        ).rejects.toThrow(LLM_REACHED);
        expect(retrievalCalls).toBe(0);
    });

    it("flag ON + projectId null → falls through, retrieval never called", async () => {
        process.env.PROJECT_RAG_ENABLED = "1";
        let retrievalCalls = 0;
        const retrievalService = async () => { retrievalCalls += 1; return okRetrieval(); };
        const state = baseState(); // projectId absent → null
        await expect(
            runWithAuthenticatedContext(ctx, () =>
                knowledgeAgentNode(state, { configurable: { retrievalService, makeLlm: FALLTHROUGH_MAKE_LLM } })),
        ).rejects.toThrow(LLM_REACHED);
        expect(retrievalCalls).toBe(0);
    });

    it("flag ON + projectId + no retrievalService → falls through, legacy path runs", async () => {
        process.env.PROJECT_RAG_ENABLED = "1";
        const state = baseState({ projectId: "proj_r4" });
        await expect(
            runWithAuthenticatedContext(ctx, () =>
                knowledgeAgentNode(state, { configurable: { makeLlm: FALLTHROUGH_MAKE_LLM } })),
        ).rejects.toThrow(LLM_REACHED);
    });

    it("flag ON + projectId + retrievalService + NO request context → falls through (owner scope required)", async () => {
        process.env.PROJECT_RAG_ENABLED = "1";
        let retrievalCalls = 0;
        const retrievalService = async () => { retrievalCalls += 1; return okRetrieval(); };
        const state = baseState({ projectId: "proj_r4" });
        // NOT wrapped in runWithAuthenticatedContext → getRequestContext() === null
        await expect(
            knowledgeAgentNode(state, { configurable: { retrievalService, makeLlm: FALLTHROUGH_MAKE_LLM } }),
        ).rejects.toThrow(LLM_REACHED);
        expect(retrievalCalls).toBe(0);
    });

    it("flag ON + projectId + retrievalService + authenticated context → RAG branch returns without any LLM", async () => {
        process.env.PROJECT_RAG_ENABLED = "1";
        const calls = [];
        const retrievalService = async (args) => {
            calls.push(args);
            return okRetrieval();
        };
        const state = baseState({ projectId: "proj_r4" });
        const result = await runWithAuthenticatedContext(ctx, () =>
            knowledgeAgentNode(state, { configurable: { retrievalService, makeLlm: FALLTHROUGH_MAKE_LLM } }));

        expect(result.currentAgent).toBe(AGENT);
        expect(result.knowledgeResults).toContain("src/auth/loginUser.js");
        expect(calls).toHaveLength(1);
        // owner scope derived from the live request context
        expect(calls[0].scope).toEqual({ userId: 7, tenantId: "user:7" });
        expect(calls[0].projectId).toBe("proj_r4");
        expect(calls[0].mode).toBe("knowledge");
    });
});

describe("R4 source invariants (no new LLM/makeLlm sites)", () => {
    const source = fs.readFileSync(new URL("./chatGraph.js", import.meta.url), "utf8");

    it("still constructs exactly 1 ChatOpenAI and calls resolveMakeLlm(config)( at 8 sites", () => {
        expect(source.split("new ChatOpenAI(").length - 1).toBe(1);
        expect(source.split("resolveMakeLlm(config)(").length - 1).toBe(8);
    });

    it("wires retrievalService into config.configurable in chatWithGraphImpl", () => {
        expect(source).toContain("retrievalService: options?.deps?.services?.projectRetrieval || defaultProjectRetrieval");
    });

    it("exports the R4 knowledge node + helper for consumers", async () => {
        expect(typeof runKnowledgeProjectRagBranch).toBe("function");
        expect(typeof knowledgeAgentNode).toBe("function");
    });
});
