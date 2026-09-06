import { describe, expect, it, beforeEach, afterEach } from "vitest";
import db, { initDB } from "../db/index.js";
import {
    countDocuments,
    countChunks,
    listActiveDocuments,
    getActiveChunks,
    getEmbeddedActiveChunks,
} from "./knowledgeStore.js";
import { planFileChanges, indexProjectSnapshot, rebuildProjectIndex } from "./indexer.js";
import { createFakeEmbedder } from "./embedder.js";
import { lexicalSearch } from "./lexical.js";
import { clearDurableStoreCache, createVectorStoreAdapter } from "./vectorStoreAdapter.js";

/**
 * Phase 7 / R4 — indexer.js file-hash incremental index (roadmap R4 #5).
 *
 * Verifies first-snapshot indexing, hash-unchanged dedupe, revision supersede
 * (stale chunks), authoritative deletion, mid-way embedding failure degrading
 * to lexical-only, cross-owner isolation (DoD: "跨用户零泄漏") and restart
 * durability (DoD: "索引重启后可用") — a fresh durable adapter rebuilt lazily
 * from the same DB after clearDurableStoreCache() still retrieves the vectors.
 */

// better-sqlite3 defaults PRAGMA foreign_keys = ON → synthetic owners must be
// real users rows before knowledgeStore/telemetry accept them.
function ensureUser(id) {
    initDB();
    const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (existing) return Number(existing.id);
    const info = db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
        .run(id, `idx_owner_${id}`, "x");
    return Number(info.lastInsertRowid);
}

let userSeq = 15000;
function freshUser() {
    userSeq += 1;
    return ensureUser(userSeq);
}

const CODE_A = [
    "const MARKER_OLD = 'old';",
    "function compute() {",
    "  return MARKER_OLD + 1;",
    "}",
].join("\n");

const CODE_B = [
    "const MARKER_NEW = 'new';",
    "function compute() {",
    "  return MARKER_NEW + 2;",
    "}",
].join("\n");

beforeEach(() => clearDurableStoreCache());
afterEach(() => clearDurableStoreCache());

describe("indexProjectSnapshot / planFileChanges", () => {
    it("first snapshot indexes the file (active doc + chunks)", async () => {
        const user = freshUser();
        const project = "p-first";
        const summary = await indexProjectSnapshot({
            scope: user,
            projectId: project,
            files: [{ path: "src/app.js", text: CODE_A }],
            sourceRunId: "run-1",
            sourceCommit: "c1",
        });

        expect(summary.scanned).toBe(1);
        expect(summary.indexed).toBe(1);
        expect(summary.unchanged).toBe(0);
        expect(summary.chunkCount).toBeGreaterThanOrEqual(1);
        expect(summary.errors).toEqual([]);
        expect(countDocuments(user, project, { status: "active" })).toBe(1);
        expect(listActiveDocuments(user, project).map((d) => d.file_path)).toEqual(["src/app.js"]);
        expect(countChunks(user, project, { active: true })).toBeGreaterThanOrEqual(1);
    });

    it("identical hash re-scan is unchanged — no new revision, chunk count stable", async () => {
        const user = freshUser();
        const project = "p-unchanged";
        await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/app.js", text: CODE_A }] });
        const activeBefore = countChunks(user, project, { active: true });

        const summary = await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/app.js", text: CODE_A }] });

        expect(summary.unchanged).toBe(1);
        expect(summary.indexed).toBe(0);
        expect(summary.updated).toBe(0);
        expect(summary.chunkCount).toBe(0);
        expect(countDocuments(user, project, { status: "active" })).toBe(1);
        expect(countDocuments(user, project, { status: "stale" })).toBe(0);
        expect(countChunks(user, project, { active: true })).toBe(activeBefore);
    });

    it("modified file supersedes the previous revision (old doc + chunks stale)", async () => {
        const user = freshUser();
        const project = "p-modified";
        await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/app.js", text: CODE_A }] });

        const summary = await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/app.js", text: CODE_B }] });

        expect(summary.updated).toBe(1);
        expect(summary.indexed).toBe(0);
        expect(countDocuments(user, project, { status: "active" })).toBe(1);
        expect(countDocuments(user, project, { status: "stale" })).toBe(1);
        const active = getActiveChunks(user, project, { limit: 100 });
        expect(active.length).toBeGreaterThan(0);
        expect(active.some((c) => String(c.content).includes("MARKER_NEW"))).toBe(true);
        expect(active.some((c) => String(c.content).includes("MARKER_OLD"))).toBe(false);
    });

    it("authoritative snapshot marks absent files stale", async () => {
        const user = freshUser();
        const project = "p-delete";
        await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "a.js", text: "aaa" }, { path: "b.js", text: "bbb" }] });
        expect(countDocuments(user, project, { status: "active" })).toBe(2);

        const summary = await indexProjectSnapshot({
            scope: user,
            projectId: project,
            files: [{ path: "b.js", text: "bbb" }],
            opts: { authoritativeSnapshot: true },
        });

        expect(summary.deleted).toBe(1);
        expect(countDocuments(user, project, { status: "active" })).toBe(1);
        expect(countDocuments(user, project, { status: "stale" })).toBe(1);
        expect(listActiveDocuments(user, project).map((d) => d.file_path)).toEqual(["b.js"]);
    });

    it("empty files list → zeros, never throws", async () => {
        const user = freshUser();
        const summary = await indexProjectSnapshot({ scope: user, projectId: "p-empty", files: [] });
        expect(summary).toMatchObject({ scanned: 0, unchanged: 0, indexed: 0, updated: 0, deleted: 0, chunkCount: 0, embeddingErrors: 0 });
        expect(summary.errors).toEqual([]);
    });

    it("embedding failure mid-way still indexes chunks lexical-only (embeddingErrors>0)", async () => {
        const user = freshUser();
        const project = "p-embedfail";
        let calls = 0;
        const flakyEmbedder = {
            async embed(texts) {
                calls += 1;
                if (calls === 2) throw new Error("embedding batch down");
                const list = Array.isArray(texts) ? texts : [texts];
                return list.map((t) => simpleVec(String(t)));
            },
        };
        function simpleVec(text) {
            // deterministic small vector so a/ b index fine when it does not throw
            const v = new Array(16).fill(0);
            let h = 7;
            for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
            for (let i = 0; i < 16; i += 1) v[i] = Math.sin(i + (h % 13)) * 0.5;
            const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
            return v.map((x) => x / norm);
        }

        const summary = await indexProjectSnapshot({
            scope: user,
            projectId: project,
            files: [
                { path: "a.js", text: "const GOOD = 1;" },
                { path: "b.js", text: "const FROBNICATE = 2;" },
            ],
            embedder: flakyEmbedder,
        });

        expect(calls).toBe(2);
        expect(summary.embeddingErrors).toBe(1); // b.js batch failed
        expect(summary.errors).toEqual([]);
        expect(summary.indexed).toBe(2);
        expect(countDocuments(user, project, { status: "active" })).toBe(2);
        // only a.js chunks carry an embedding
        const embedded = getEmbeddedActiveChunks(user, project);
        expect(embedded.map((c) => c.file_path)).toEqual(["a.js"]);
        // b.js chunk is present and lexically usable despite no embedding
        const lex = lexicalSearch({ scope: user, projectId: project, query: "FROBNICATE" });
        expect(lex.status).toBe("ok");
        expect(lex.items.some((i) => String(i.content).includes("FROBNICATE"))).toBe(true);
    });

    it("cross-owner isolation: ALICE rows invisible to BOB", async () => {
        const alice = freshUser();
        const bob = freshUser();
        const project = "p-shared-isolation";
        await indexProjectSnapshot({ scope: alice, projectId: project, files: [{ path: "secret/x.js", text: "const SECRET = 1;" }] });

        expect(listActiveDocuments(alice, project)).toHaveLength(1);
        expect(listActiveDocuments(bob, project)).toEqual([]);
        expect(getActiveChunks(bob, project, { limit: 100 })).toEqual([]);
        expect(countDocuments(bob, project, { status: "active" })).toBe(0);
    });

    it("restart durability: fresh adapter re-loads persisted vectors from DB", async () => {
        const user = freshUser();
        const project = "p-durable";
        const embedder = createFakeEmbedder({ dimension: 32 });
        const code = [
            "class PersistentSearchEngine {",
            "  async loadIndex(files) {",
            "    for (const f of files) await this.cache.set(f);",
            "  }",
            "}",
        ].join("\n");
        await indexProjectSnapshot({
            scope: user,
            projectId: project,
            files: [{ path: "src/engine.js", text: code }],
            sourceCommit: "dur1",
            embedder,
        });

        // simulate process restart: drop the in-process adapter cache entirely
        clearDurableStoreCache();
        const adapter = createVectorStoreAdapter({ scope: user, projectId: project });
        const [queryVector] = await embedder.embed(["loadIndex PersistentSearchEngine"]);

        const hits = adapter.similaritySearch(queryVector, 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.filePath === "src/engine.js")).toBe(true);
        expect(adapter.stats().chunkCount).toBeGreaterThan(0);
    });
});

describe("rebuildProjectIndex", () => {
    it("requires an embedder when none given", async () => {
        const user = freshUser();
        const project = "p-rebuild-need";
        await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/a.js", text: "const A = 1;" }] });
        const result = await rebuildProjectIndex({ scope: user, projectId: project });
        expect(result.requiresEmbedder).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(1);
        expect(result.embedded).toBe(0);
    });

    it("re-embeds active chunks and stores vectors (idempotent rebuild)", async () => {
        const user = freshUser();
        const project = "p-rebuild";
        // index WITHOUT embedder first → active chunks have no vectors
        await indexProjectSnapshot({ scope: user, projectId: project, files: [{ path: "src/a.js", text: "const A = 1;" }] });
        expect(getEmbeddedActiveChunks(user, project)).toHaveLength(0);

        const embedder = createFakeEmbedder({ dimension: 16 });
        const result = await rebuildProjectIndex({ scope: user, projectId: project, embedder });
        expect(result.requiresEmbedder).toBe(false);
        expect(result.embedded).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThanOrEqual(1);
        expect(getEmbeddedActiveChunks(user, project).length).toBe(result.total);
    });
});
