import { describe, expect, it } from "vitest";
import { splitCodeByLines, extractSymbols, extractPathTerms, tokenizeQuery } from "./codeChunk.js";

/**
 * Phase 7 / R4 — codeChunk.js pure helpers (roadmap R4 #5/#6).
 * No DB / network: verifies deterministic line-window chunking (overlap
 * reconstructs original text), hard-slicing of oversized single lines, symbol
 * extraction dedupe/filter/cap, path terms, and CJK bigram query tokenization.
 */

function buildLines(count, prefix = "line") {
    return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")} payload-${i + 1}`);
}

describe("splitCodeByLines", () => {
    it("empty input → []", () => {
        expect(splitCodeByLines("")).toEqual([]);
        expect(splitCodeByLines(null)).toEqual([]);
        expect(splitCodeByLines(undefined)).toEqual([]);
    });

    it("overlapping windows cover all lines and each chunk preserves its original slice", () => {
        const lines = buildLines(180);
        const text = lines.join("\n");
        const chunks = splitCodeByLines(text, { maxLines: 40, overlapLines: 8 });

        expect(chunks.length).toBeGreaterThan(0);
        // consecutive windows overlap
        for (let i = 1; i < chunks.length; i += 1) {
            expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
        }
        // each chunk content is exactly its source lines joined by '\n'
        for (const c of chunks) {
            expect(c.content).toBe(lines.slice(c.startLine - 1, c.endLine).join("\n"));
            expect(c.content).not.toMatch(/\n$/); // no trailing newline preserved
        }
        // union of coverage reconstructs the whole file text exactly
        const rebuilt = [];
        let covered = 0;
        for (const c of chunks) {
            const from = Math.max(c.startLine, covered + 1);
            for (let ln = from; ln <= c.endLine; ln += 1) rebuilt.push(lines[ln - 1]);
            covered = Math.max(covered, c.endLine);
        }
        expect(rebuilt.join("\n")).toBe(text);
        expect(covered).toBe(180);
    });

    it("trailing newline is dropped but content is otherwise byte-preserving", () => {
        const text = "aaa\nbbb\nccc\n";
        const [chunk] = splitCodeByLines(text, { maxLines: 10, overlapLines: 2 });
        expect(chunk.content).toBe("aaa\nbbb\nccc");
        expect(chunk.startLine).toBe(1);
        expect(chunk.endLine).toBe(3);
    });

    it("huge single line is hard-sliced at maxChars with startLine===endLine", () => {
        const big = "x".repeat(15000);
        const text = ["function ok(){}", big, "function done(){}"].join("\n");
        const chunks = splitCodeByLines(text, { maxLines: 40, overlapLines: 8, maxChars: 4000 });

        const fragments = chunks.filter((c) => c.startLine === 2 && c.endLine === 2);
        expect(fragments.length).toBe(4);
        expect(fragments.map((f) => f.content.length)).toEqual([4000, 4000, 4000, 3000]);
        for (const f of fragments) {
            expect(f.content).not.toContain("\n");
            expect(f.startLine).toBe(2);
            expect(f.endLine).toBe(2);
        }
        // fragments concatenate back to the original oversized line
        expect(fragments.map((f) => f.content).join("")).toBe(big);
        // neighbouring windows are intact and ordered around the fragment
        const nonFragment = chunks.filter((c) => !(c.startLine === 2 && c.endLine === 2));
        expect(nonFragment.map((c) => c.content)).toEqual(["function ok(){}", "function done(){}"]);
        expect(chunks[0].endLine).toBe(1);
        expect(chunks[chunks.length - 1].startLine).toBe(3);
    });

    it("does not produce redundant tail windows", () => {
        const lines = buildLines(100);
        const text = lines.join("\n");
        const chunks = splitCodeByLines(text, { maxLines: 40, overlapLines: 8 });
        expect(chunks[chunks.length - 1].endLine).toBe(100);
        expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
            [1, 40],
            [33, 72],
            [65, 100],
        ]);
    });

    it("maxChars guard shrinks a window but never skips a line", () => {
        const lines = Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(3, "0")}-${"y".repeat(60)}`);
        const text = lines.join("\n");
        const chunks = splitCodeByLines(text, { maxLines: 40, overlapLines: 4, maxChars: 500 });
        for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500);
        const rebuilt = [];
        let covered = 0;
        for (const c of chunks) {
            const from = Math.max(c.startLine, covered + 1);
            for (let ln = from; ln <= c.endLine; ln += 1) rebuilt.push(lines[ln - 1]);
            covered = Math.max(covered, c.endLine);
        }
        expect(covered).toBe(50);
        expect(rebuilt.join("\n")).toBe(text);
    });
});

describe("extractSymbols", () => {
    it("dedupes, lowercases and sorts", () => {
        expect(extractSymbols("Foo foo FOO bar_baz qux")).toEqual(["bar_baz", "foo", "qux"]);
    });

    it("filters common keywords/connectors and too-short tokens", () => {
        expect(extractSymbols("function const return if myVar x it")).toEqual(["myvar"]);
    });

    it("caps at maxSymbols", () => {
        const many = ["alpha", "beta", "gamma", "delta", "epsilon"].join(" ");
        const symbols = extractSymbols(many, { maxSymbols: 3 });
        expect(symbols).toHaveLength(3);
    });

    it("keeps identifier-like tokens that share keyword substrings", () => {
        const symbols = extractSymbols("forEachAsync returnValue defaultExport");
        expect(symbols).toContain("foreachasync");
        expect(symbols).toContain("returnvalue");
    });
});

describe("extractPathTerms", () => {
    it("splits dirs/ext and always keeps the basename-minus-extension", () => {
        const terms = extractPathTerms("src/services/ChatService.js");
        expect(terms).toContain("chatservice");
        expect(terms).toContain("services");
        expect(terms).toContain("src");
        expect(terms).toContain("js");
        expect([...new Set(terms)]).toEqual(terms);
    });

    it("handles backslash paths", () => {
        expect(extractPathTerms("src\\util\\scan.ts")).toEqual(["scan", "src", "ts", "util"]);
    });

    it("keeps single-char basename token but drops short dir tokens", () => {
        expect(extractPathTerms("a.js")).toEqual(["a", "js"]);
    });

    it("empty path → []", () => {
        expect(extractPathTerms("")).toEqual([]);
    });
});

describe("tokenizeQuery", () => {
    it("extracts latin terms length >= 3 lowercased", () => {
        expect(tokenizeQuery("FindByID user42 ok").terms).toEqual(["findbyid", "user42"]);
    });

    it("builds overlapping CJK bigrams per contiguous run", () => {
        const { terms, cjk } = tokenizeQuery("持久化Code RAG检索");
        expect(terms).toEqual(["code", "rag"]);
        expect(cjk).toEqual(["持久", "久化", "检索"]);
    });

    it("single CJK char produces no bigram", () => {
        expect(tokenizeQuery("索")).toEqual({ terms: [], cjk: [] });
    });

    it("dedupes repeated bigrams deterministically", () => {
        expect(tokenizeQuery("检索 检索").cjk).toEqual(["检索"]);
    });

    it("pure latin returns empty cjk", () => {
        expect(tokenizeQuery("chat service").cjk).toEqual([]);
        expect(tokenizeQuery("chat service").terms).toEqual(["chat", "service"]);
    });
});
