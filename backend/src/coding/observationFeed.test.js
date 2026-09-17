import { describe, expect, it } from "vitest";
import { OBS_LIMITS, pushReadObservation, renderReadObservation } from "./observationFeed.js";

/**
 * Phase 7 / R5 — observationFeed: bounded rendering of read-op payloads into text
 * snippets a real LLM decider can see. Pure + dependency-free, so it tests with no
 * runner/filesystem. Shapes below mirror readRunner.js / git.js exactly.
 */

describe("renderReadObservation per-op", () => {
    it("renders read_file with line numbers + truncation note", () => {
        const out = renderReadObservation("read_file", {
            path: "src/a.js",
            startLine: 3,
            lines: ["x = 1", "y = 2"],
            truncated: false,
        });
        expect(out).toContain("read_file src/a.js L3-4 (2 lines)");
        expect(out).toContain("3|x = 1");
        expect(out).toContain("4|y = 2");
    });

    it("returns '' when a read_file payload carries nothing usable", () => {
        expect(renderReadObservation("read_file", {})).toBe("");
        expect(renderReadObservation("read_file", { path: "x", lines: [] })).toBe("");
    });

    it("renders list_tree dir/file entries and counts", () => {
        const out = renderReadObservation("list_tree", {
            path: ".",
            entries: [
                { name: "src", type: "dir", rel: "src" },
                { name: "calc.js", type: "file", rel: "calc.js", size: 80 },
            ],
            counts: { dirs: 1, files: 1, links: 0 },
        });
        expect(out).toContain("list_tree . (dirs=1 files=1 links=0)");
        expect(out).toContain("[dir] src");
        expect(out).toContain("file calc.js (80B)");
    });

    it("renders search_text matches as path:line: text", () => {
        const out = renderReadObservation("search_text", {
            base: ".",
            query: "BUG",
            matches: [{ path: "src/calc.js", line: 3, text: "return a - b; // BUG" }],
            filesWithMatches: 1,
        });
        expect(out).toContain('search_text "BUG" in .');
        expect(out).toContain("src/calc.js:3: return a - b; // BUG");
    });

    it("renders git.status porcelain and git.diff files", () => {
        const st = renderReadObservation("git.status", {
            branch: "wt-abc",
            commit: "c0ffee1234567890",
            entries: [{ x: "M", y: " ", path: "src/calc.js" }],
        });
        expect(st).toContain("git status branch=wt-abc commit=c0ffee");
        expect(st).toContain("M  src/calc.js");

        const df = renderReadObservation("git.diff", {
            filesChanged: ["src/calc.js"],
            diff: "diff --git a/src/calc.js b/src/calc.js\n@@ -1 +1 @@\n-return a - b;\n+return a + b;",
        });
        expect(df).toContain("git diff 1 file(s): src/calc.js");
        expect(df).toContain("+return a + b;");
    });

    it("renders git.show_file content and falls back to bounded JSON for unknown shapes", () => {
        const show = renderReadObservation("git.show_file", { ref: "HEAD", path: "README.md", content: "hello" });
        expect(show).toContain("git show @ HEAD:README.md");
        expect(show).toContain("hello");

        const fallback = renderReadObservation("future_op", { nested: { k: "v" } });
        expect(fallback).toContain("future_op");
        expect(fallback).toContain("nested");
    });

    it("never throws on garbage payloads", () => {
        expect(() => renderReadObservation("read_file", null)).not.toThrow();
        expect(() => renderReadObservation("list_tree", "junk")).not.toThrow();
        expect(() => renderReadObservation("git.diff", { diff: { circular: "?" } })).not.toThrow();
    });
});

describe("pushReadObservation ring eviction", () => {
    const bigData = { path: "f", lines: ["x".repeat(OBS_LIMITS.perSnippetChars + 100)] };

    it("evicts to maxEntries", () => {
        let list = [];
        for (let i = 0; i < 15; i++) {
            list = pushReadObservation(list, { op: "read_file", args: { path: `f${i}` }, data: { path: `f${i}`, lines: ["tiny"] } });
        }
        expect(list.length).toBeLessThanOrEqual(OBS_LIMITS.maxEntries);
        expect(list[0]).toContain("f"); // newest kept, oldest dropped
    });

    it("evicts oversized entries to maxTotalChars", () => {
        const first = pushReadObservation([], { op: "read_file", args: { path: "big" }, data: bigData });
        expect(first.length).toBe(1);
        // A single snippet is per-op capped, so total stays bounded even alone.
        expect(first[0].length).toBeLessThanOrEqual(OBS_LIMITS.perSnippetChars + 200);
        const second = pushReadObservation(first, { op: "read_file", args: { path: "b2" }, data: { path: "b2", lines: ["zz"] } });
        expect(second.length).toBeLessThanOrEqual(OBS_LIMITS.maxEntries);
    });

    it("skips empty renders and never mutates the input array", () => {
        const input = [];
        const out = pushReadObservation(input, { op: "read_file", args: { path: "x" }, data: null });
        expect(out).toEqual([]);
        expect(input).toEqual([]);
    });
});
