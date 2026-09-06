import { afterEach, describe, expect, it } from "vitest";
import { CodeAgentService } from "./codingAgent.js";
import { clearCodingFlags } from "./flags.js";

/**
 * Phase 7 / R4 (roadmap #8) — code_agent reuse of the SHARED project-code
 * retrieval (constructor seam + decider ctx). A NEW file so the existing
 * codingAgent.test.js contract stays untouched.
 *
 * The seam is a strict NO-OP by default: ctx.retrievalEnabled is true ONLY when
 * a `retrieval` service was injected into the CodeAgentService constructor AND
 * CODING_RAG_REUSE_ENABLED is on. The production singleton (constructed with no
 * deps) always exposes retrieval:null / retrievalEnabled:false and behaves
 * byte-for-byte as before. ctx.projectId is derived from the session scope
 * (scope.projectId > session.project.id) exactly as the R4 spec demands.
 */

// Real service dependencies (runRunner/runService/approvals) are not exercised:
// the decider returns {type:"done"} immediately, so only the ctx plumbing runs.
function makeService({ retrieval = null } = {}) {
    return new CodeAgentService({ retrieval });
}

async function runOnce(service, project = { id: "proj_r4" }, scopeProjectId = null) {
    const captured = [];
    const scope = { userId: 7, tenantId: "user:7" };
    if (scopeProjectId) scope.projectId = scopeProjectId;
    const session = service.begin(scope, {
        run: { id: "run_r4" },
        project,
        goal: "refactor auth to a service layer",
        decide: async (ctx) => {
            captured.push(ctx);
            return { type: "done", summary: "ok" };
        },
    });
    const snapshot = await service.run(session);
    expect(snapshot.phase).toBe("done");
    expect(captured).toHaveLength(1);
    return captured[0];
}

afterEach(() => {
    clearCodingFlags();
});

describe("R4 code_agent shared-retrieval seam", () => {
    it("default service (no retrieval injected) exposes retrieval:null + retrievalEnabled:false even with the flag ON", async () => {
        process.env.CODING_RAG_REUSE_ENABLED = "1";
        const ctx = await runOnce(makeService());
        expect(ctx).toMatchObject({
            goal: "refactor auth to a service layer",
            projectId: "proj_r4",
            retrieval: null,
            retrievalEnabled: false,
        });
    });

    it("retrieval injected but flag OFF → retrievalEnabled:false, retrieval still surfaced", async () => {
        const retrieval = async () => ({ status: "no_match", items: [] });
        const ctx = await runOnce(makeService({ retrieval }));
        expect(ctx.retrieval).toBe(retrieval);
        expect(ctx.retrievalEnabled).toBe(false);
        expect(ctx.projectId).toBe("proj_r4");
    });

    it("retrieval injected + CODING_RAG_REUSE_ENABLED → retrievalEnabled:true", async () => {
        process.env.CODING_RAG_REUSE_ENABLED = "1";
        const retrieval = async () => ({ status: "ok", items: [] });
        const ctx = await runOnce(makeService({ retrieval }));
        expect(ctx.retrieval).toBe(retrieval);
        expect(ctx.retrievalEnabled).toBe(true);
        expect(ctx.projectId).toBe("proj_r4");
        // goal/steps/turn/stepIndex legacy keys are preserved for existing deciders
        expect(ctx.stepIndex).toBe(0);
        expect(ctx.turn).toBe(1);
        expect(Array.isArray(ctx.steps)).toBe(true);
    });

    it("scope.projectId wins over session.project.id for ctx.projectId", async () => {
        process.env.CODING_RAG_REUSE_ENABLED = "1";
        const ctx = await runOnce(makeService({ retrieval: async () => ({ status: "no_match", items: [] }) }), { id: "proj_db" }, "proj_scope_9");
        expect(ctx.projectId).toBe("proj_scope_9");
    });
});
