import { describe, expect, it } from "vitest";
import { canonicalChatRequest, canonicalRepoContext } from "./app.js";

describe("canonical chat request repository context", () => {
    const base = { session_id: 1, message: "读取项目", plan_mode: true };

    it("distinguishes different repository attachments", () => {
        const a = canonicalChatRequest({
            ...base,
            repo_context: { projectId: "p1", refs: [{ path: "src/a.js", startLine: 1, endLine: 5 }] },
        }, null);
        const b = canonicalChatRequest({
            ...base,
            repo_context: { projectId: "p2", refs: [{ path: "src/a.js", startLine: 1, endLine: 5 }] },
        }, null);
        expect(a).not.toBe(b);
    });

    it("canonicalizes ref ordering", () => {
        const a = canonicalRepoContext({ projectId: "p1", refs: [
            { path: "b.js", startLine: 2, endLine: 3 },
            { path: "a.js", mode: "whole_file" },
        ] });
        const b = canonicalRepoContext({ projectId: "p1", refs: [
            { path: "a.js", mode: "whole_file" },
            { path: "b.js", startLine: 2, endLine: 3 },
        ] });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
