/**
 * Phase 7 / R1 — RepoContextService unit tests.
 *
 * The service is the only seam that turns an attached `{projectId, refs}` into
 * file content for the main Graph. It must be owner-scoped (cross-owner ->
 * empty, no read), default-dark (workspace flag off -> empty, no read), bounded
 * by an independent token budget, provenance-carrying, and never allowed to
 * bypass the runner boundary (trust/open failures -> empty, never a throw).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoContextService, REPO_CONTEXT_LIMITS } from "./repoContext.js";

const SCOPE_A = { userId: 7, tenantId: "user:7" };
const SCOPE_B = { userId: 8, tenantId: "user:8" };

function makeStubs({ owned = true, openThrows = false } = {}) {
    const projects = {
        get(scope, id) {
            if (id !== "proj_1") return null;
            if (owned && scope.userId !== 7) return null; // cross-owner hidden
            return { id: "proj_1", name: "svc", status: "trusted", trusted: true, rootPath: "/x" };
        },
    };
    const runner = {
        async open(project) {
            if (openThrows) throw Object.assign(new Error("not trusted"), { code: "PROJECT_NOT_TRUSTED" });
            return { isRepo: true, isRepoTopLevel: true, commit: "c".repeat(40), capabilities: { write: false, exec: false } };
        },
        async invoke(project, op, args) {
            if (op !== "read_file") throw new Error("unexpected op");
            const start = args.start_line || 1;
            const max = args.max_lines || 1;
            const lines = Array.from({ length: max }, (_, i) => `line ${start + i} of file ${args.path}`);
            return { ok: true, op, data: { lines } };
        },
    };
    return { projects, runner };
}

describe("RepoContextService", () => {
    let service;
    beforeEach(() => { process.env.CODING_WORKSPACE_ENABLED = "true"; });
    afterEach(() => { delete process.env.CODING_WORKSPACE_ENABLED; });

    it("is default-dark: no packets and no reads when the workspace flag is off", async () => {
        delete process.env.CODING_WORKSPACE_ENABLED;
        service = new RepoContextService(makeStubs());
        const result = await service.resolve(SCOPE_A, { projectId: "proj_1", refs: [{ path: "src/a.js", startLine: 1, endLine: 3 }] });
        expect(result).toEqual({ packets: [], omitted: 0, enabled: false, commit: null });
    });

    it("returns empty for an absent/unknown or cross-owner project (no leak)", async () => {
        service = new RepoContextService(makeStubs());
        const missing = await service.resolve(SCOPE_A, { projectId: "proj_nope", refs: [{ path: "a", startLine: 1, endLine: 1 }] });
        expect(missing.packets).toEqual([]);

        const crossOwner = await service.resolve(SCOPE_B, { projectId: "proj_1", refs: [{ path: "a", startLine: 1, endLine: 1 }] });
        expect(crossOwner.packets).toEqual([]);
        expect(crossOwner.omitted).toBe(0);
    });

    it("returns empty (never throws) when the runner refuses the project", async () => {
        service = new RepoContextService(makeStubs({ openThrows: true }));
        const result = await service.resolve(SCOPE_A, { projectId: "proj_1", refs: [{ path: "a", startLine: 1, endLine: 1 }] });
        expect(result.enabled).toBe(true);
        expect(result.packets).toEqual([]);
    });

    it("builds provenance-carrying, untrusted repo packets", async () => {
        service = new RepoContextService(makeStubs());
        const result = await service.resolve(SCOPE_A, {
            projectId: "proj_1",
            refs: [{ path: "src/a.js", startLine: 1, endLine: 3 }],
        });
        expect(result.packets).toHaveLength(1);
        const packet = result.packets[0];
        expect(packet.metadata.type).toBe("repo");
        expect(packet.metadata.untrusted).toBe(true);
        expect(packet.metadata.projectId).toBe("proj_1");
        expect(packet.metadata.commit).toBe("c".repeat(40));
        expect(packet.metadata.provenance.path).toBe("src/a.js");
        expect(packet.metadata.provenance.startLine).toBe(1);
        expect(packet.content).toContain("[repo src/a.js:1-3 @ cccccccccccc]");
        expect(packet.content).toContain("line 1 of file src/a.js");
        expect(packet.tokenCount).toBeGreaterThan(0);
    });

    it("skips invalid/oversized refs and counts them as omitted", async () => {
        service = new RepoContextService(makeStubs());
        const result = await service.resolve(SCOPE_A, {
            projectId: "proj_1",
            refs: [
                { path: "", startLine: 1, endLine: 3 },                 // no path
                { path: "a.js", startLine: 9, endLine: 2 },             // inverted range
                { path: "huge.js", startLine: 1, endLine: REPO_CONTEXT_LIMITS.maxLinesPerRef + 50 }, // oversized
                { path: "good.js", startLine: 1, endLine: 2 },          // fine
            ],
        });
        expect(result.omitted).toBe(3);
        expect(result.packets).toHaveLength(1);
        expect(result.packets[0].content).toContain("[repo good.js:1-2 @");
    });

    it("enforces an independent token budget across many refs", async () => {
        // Tight budget so a single big ref must be partially included.
        service = new RepoContextService({ ...makeStubs(), budgetTokens: 220 });
        const result = await service.resolve(SCOPE_A, {
            projectId: "proj_1",
            refs: [{ path: "big.js", startLine: 1, endLine: 200 }],
        });
        expect(result.packets).toHaveLength(1);
        const tokens = result.packets.reduce((s, p) => s + p.tokenCount, 0);
        expect(tokens).toBeLessThanOrEqual(220);
        // 200 lines of "line N of file big.js" cannot fit in 220 tokens -> partial
        expect(result.packets[0].content.split("\n").length).toBeLessThan(200);
    });

    it("returns a metadata-only scoped reader for whole-file refs", async () => {
        service = new RepoContextService(makeStubs());
        const result = await service.resolve(SCOPE_A, {
            projectId: "proj_1",
            refs: [{ path: "src/chatGraph.js", mode: "whole_file" }],
        });
        expect(result.packets).toEqual([]);
        expect(result.wholeFiles).toHaveLength(1);
        expect(result.wholeFiles[0]).toMatchObject({
            projectId: "proj_1",
            path: "src/chatGraph.js",
            metadata: { type: "repo_capability", selection: "whole_file" },
        });
        const page = await result.wholeFiles[0].read({ startLine: 401, maxLines: 2 });
        expect(page.data.lines).toEqual([
            "line 401 of file src/chatGraph.js",
            "line 402 of file src/chatGraph.js",
        ]);
    });

    it("rejects unknown attachment modes without reading", async () => {
        service = new RepoContextService(makeStubs());
        const result = await service.resolve(SCOPE_A, {
            projectId: "proj_1",
            refs: [{ path: "a.js", mode: "all_files" }],
        });
        expect(result.omitted).toBe(1);
        expect(result.packets).toEqual([]);
        expect(result.wholeFiles).toBeUndefined();
    });

    it("caps the number of refs honored per request", async () => {
        service = new RepoContextService(makeStubs());
        const refs = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.js`, startLine: 1, endLine: 1 }));
        const result = await service.resolve(SCOPE_A, { projectId: "proj_1", refs });
        expect(result.packets.length).toBeLessThanOrEqual(REPO_CONTEXT_LIMITS.maxRefs);
    });
});
