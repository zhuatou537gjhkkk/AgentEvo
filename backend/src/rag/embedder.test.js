import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "./embedder.js";

/**
 * Phase 7 / R4 — embedder seam (roadmap R4 #6). Unit tests never construct the
 * OpenAI client — only the deterministic fake embedder is exercised here.
 */

function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("createFakeEmbedder", () => {
    it("same text → identical vector across calls and processes", async () => {
        const embedder = createFakeEmbedder();
        const v1 = await embedder.embedOne("export function loginUser(id) { return db.get(id); }");
        const v2 = await embedder.embedOne("export function loginUser(id) { return db.get(id); }");
        expect(v1).toEqual(v2);
        const again = createFakeEmbedder();
        expect(await again.embedOne("same text content")).toEqual(await embedder.embedOne("same text content"));
    });

    it("dimension matches the request and embed returns per-input vectors", async () => {
        const embedder = createFakeEmbedder({ dimension: 24 });
        expect(embedder.dimension).toBe(24);
        const vectors = await embedder.embed(["a", "b", "c"]);
        expect(vectors).toHaveLength(3);
        for (const v of vectors) expect(v).toHaveLength(24);
    });

    it("cosine of texts sharing n-grams is higher than unrelated", async () => {
        const embedder = createFakeEmbedder({ dimension: 128 });
        const query = await embedder.embedOne("retrieveDocumentById handler");
        const similar = await embedder.embedOne("async retrieveDocumentById(id) { ... }");
        const unrelated = await embedder.embedOne("banana muffin baking temperature celsius");
        expect(cosine(query, similar)).toBeGreaterThan(cosine(query, unrelated));
        expect(cosine(query, similar)).toBeGreaterThan(0.2);
    });

    it("embedOne equals embed([x])[0]", async () => {
        const embedder = createFakeEmbedder();
        const one = await embedder.embedOne("dispatch action reducer");
        const [many] = await embedder.embed(["dispatch action reducer"]);
        expect(one).toEqual(many);
    });

    it("hashDimension:false is deterministic and length varies with vocabulary", async () => {
        const embedder = createFakeEmbedder({ dimension: 16, hashDimension: false });
        const a = await embedder.embedOne("foo bar foo");
        const b = await embedder.embedOne("foo bar foo");
        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThan(0);
        // distinct feature set → shorter text has a different length
        const short = await embedder.embedOne("q");
        expect(short.length).not.toBe(a.length);
    });
});
