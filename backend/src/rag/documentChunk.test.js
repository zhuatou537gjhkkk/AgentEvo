import { describe, expect, it } from "vitest";
import { chunkParsedDocument, chunkStats } from "./documentChunk.js";

function parsed(blocks) {
    return { blocks };
}

function block(type, text, headingPath = [], page = null) {
    return { type, text, headingPath, page };
}

describe("K4 structure-aware document chunks", () => {
    it("creates parent sections and leaf chunks with stable lineage", () => {
        const rows = chunkParsedDocument(parsed([
            block("heading", "Authentication", ["Authentication"], 1),
            block("paragraph", "Use the session cookie for browser requests.", ["Authentication"], 1),
            block("paragraph", "Rotate credentials after a suspected leak.", ["Authentication"], 2),
        ]));

        const stats = chunkStats(rows);
        expect(stats.parents).toBe(1);
        expect(stats.leaves).toBeGreaterThanOrEqual(1);
        const parent = rows.find((row) => row.chunkLevel === "parent");
        const leaves = rows.filter((row) => row.chunkLevel === "leaf");
        expect(parent.parentKey).toBeTruthy();
        expect(leaves.every((row) => row.parentKey === parent.parentKey)).toBe(true);
        expect(leaves.every((row) => Array.isArray(row.headingPath))).toBe(true);
        expect(parent.pageStart).toBe(1);
        expect(parent.pageEnd).toBe(2);
    });

    it("keeps table/code/equation metadata and bounds oversized content", () => {
        const longTable = ["name | value", ...Array.from({ length: 1200 }, (_, i) => `row-${i} | ${"x".repeat(12)}`)].join("\n");
        const rows = chunkParsedDocument(parsed([
            block("table", longTable, ["Reference"], 3),
            block("equation", "E = mc^2", ["Reference"], 3),
            block("code", "```js\nconst answer = 42;\n```", ["Reference"], 3),
        ]));
        const leaves = rows.filter((row) => row.chunkLevel === "leaf");
        expect(leaves.length).toBeGreaterThan(1);
        expect(Math.max(...leaves.map((row) => row.tokenCount))).toBeLessThanOrEqual(900);
        expect(leaves.some((row) => row.meta.blockTypes.includes("table"))).toBe(true);
        expect(leaves.some((row) => row.meta.blockTypes.includes("equation"))).toBe(true);
        expect(leaves.some((row) => row.meta.blockTypes.includes("code"))).toBe(true);
        expect(leaves.every((row) => row.pageStart === 3 && row.pageEnd === 3)).toBe(true);
    });

    it("does not create duplicate leaf rows when one block spans parent windows", () => {
        const text = Array.from({ length: 9000 }, (_, i) => `sentence-${i} keeps the same section context.`).join(" ");
        const rows = chunkParsedDocument(parsed([block("paragraph", text, ["Long"])]));
        const leaves = rows.filter((row) => row.chunkLevel === "leaf");
        expect(new Set(leaves.map((row) => `${row.parentKey}:${row.contentHash}`)).size).toBe(leaves.length);
        expect(rows.filter((row) => row.chunkLevel === "parent").length).toBeGreaterThan(1);
    });
});
