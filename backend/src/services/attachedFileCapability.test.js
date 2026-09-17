import { describe, expect, it } from "vitest";
import { createAttachedFileReadTool } from "./chatGraph.js";

function descriptor(path = "src/chatGraph.js") {
    const calls = [];
    return {
        descriptor: {
            path,
            commit: "abcdef1234567890",
            read: async ({ startLine, maxLines }) => {
                calls.push({ startLine, maxLines });
                return {
                    data: {
                        startLine,
                        endLine: startLine + maxLines - 1,
                        lines: Array.from({ length: maxLines }, (_, i) => `line ${startLine + i}`),
                    },
                };
            },
        },
        calls,
    };
}

describe("attached whole-file capability", () => {
    it("only reads an explicitly attached path and returns range provenance", async () => {
        const { descriptor: file, calls } = descriptor();
        const tool = createAttachedFileReadTool([file]);
        const body = await tool.invoke({ path: "src/chatGraph.js", start_line: 2401, max_lines: 2 });
        expect(calls).toEqual([{ startLine: 2401, maxLines: 2 }]);
        expect(body).toContain("[repo src/chatGraph.js:2401-2402 @ abcdef123456]");
        expect(body).toContain("line 2402");

        const denied = await tool.invoke({ path: "src/other.js", start_line: 1, max_lines: 1 });
        expect(denied).toContain("ATTACHED_FILE_NOT_ALLOWED");
        expect(calls).toHaveLength(1);
    });

    it("supports non-streaming tool invocation with complete structured args", async () => {
        const { descriptor: file, calls } = descriptor();
        const tool = createAttachedFileReadTool([file]);
        const output = await tool.invoke({ path: "src/chatGraph.js", start_line: 2401, max_lines: 2 });
        expect(calls).toEqual([{ startLine: 2401, maxLines: 2 }]);
        expect(output).toContain("[repo src/chatGraph.js:2401-2402 @ abcdef123456]");
    });

    it("caps each page and the aggregate read budget", async () => {
        const { descriptor: file, calls } = descriptor();
        const tool = createAttachedFileReadTool([file]);
        await expect(tool.invoke({ path: "src/chatGraph.js", start_line: 1, max_lines: 401 })).rejects.toThrow("expected schema");

        for (let i = 0; i < 5; i += 1) {
            await tool.invoke({ path: "src/chatGraph.js", start_line: i * 400 + 1, max_lines: 400 });
        }
        expect(calls).toHaveLength(5);
        const exhausted = await tool.invoke({ path: "src/chatGraph.js", start_line: 2001, max_lines: 1 });
        expect(exhausted).toContain("ATTACHED_FILE_BUDGET_EXHAUSTED");
    });
});
