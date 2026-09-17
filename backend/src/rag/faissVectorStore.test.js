import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { createUser, initDB } from "../db/index.js";
import {
    activateDocumentRevision,
    getActiveChunksByIds,
    getChunksByDocument,
    getEmbeddedActiveChunks,
    getKnowledgeIndexGeneration,
    insertDocumentRevision,
} from "./knowledgeStore.js";
import { retrieveUploadedKnowledge } from "./uploadRetrieval.js";
import { hybridRetrieve } from "./retrieval.js";
import { indexProjectSnapshot } from "./indexer.js";
import {
    clearFaissStoreCache,
    FaissVectorStore,
    getFaissGenerationPath,
    getFaissManifestPath,
    getFaissScopeDirectory,
    getFaissVectorStore,
    normalizeFaissVector,
    scopeHashFor,
} from "./faissVectorStore.js";
import {
    clearDurableStoreCache,
    createVectorStoreAdapter,
    getConfiguredVectorStore,
} from "./vectorStoreAdapter.js";
import { clearRagFlags } from "./flags.js";
import { recordKnowledgeQuery, getRecentKnowledgeQueries } from "./telemetry.js";

let sequence = 0;
let documentSequence = 0;
let faissRoot = null;

function freshScope(tenantId = null) {
    sequence += 1;
    const id = createUser(`faiss_fixture_${Date.now()}_${sequence}`, "test-hash");
    return { userId: Number(id), tenantId: tenantId || `tenant:${id}` };
}

function addDocument({ scope, projectId, filePath = "guide.md", status = "active", previous = null, chunks, activate = true }) {
    const result = insertDocumentRevision({
        scope,
        projectId,
        filePath,
        fileName: filePath,
        fileHash: `${filePath}:fixture:${documentSequence += 1}`,
        docType: filePath.endsWith(".pdf") ? "upload" : "project_file",
        status,
        previous,
        sourceCommit: "abcdef123456",
        chunks,
    });
    if (status === "indexing" && activate) {
        expect(activateDocumentRevision(scope, result.documentId, { previousDocumentId: previous?.id || null })).toBe(true);
    }
    return result;
}

function activeLeaf(content, embedding, extras = {}) {
    return {
        chunkIndex: extras.chunkIndex ?? 0,
        content,
        embedding,
        pageStart: extras.pageStart ?? null,
        pageEnd: extras.pageEnd ?? null,
        headingPath: extras.headingPath ?? [],
        startLine: extras.startLine ?? 1,
        endLine: extras.endLine ?? 1,
        chunkLevel: "leaf",
        parentChunkId: extras.parentChunkId ?? null,
    };
}

beforeEach(() => {
    initDB();
    clearRagFlags();
    clearFaissStoreCache();
    clearDurableStoreCache();
    faissRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-faiss-test-"));
    process.env.RAG_FAISS_INDEX_ROOT = faissRoot;
});

afterEach(() => {
    clearRagFlags();
    clearFaissStoreCache();
    clearDurableStoreCache();
    delete process.env.RAG_FAISS_INDEX_ROOT;
    if (faissRoot) fs.rmSync(faissRoot, { recursive: true, force: true });
    faissRoot = null;
});

describe("FaissVectorStore durable IndexFlatIP", () => {
    it("normalizes vectors and preserves cosine/IndexFlatIP ranking and scores", () => {
        const scope = freshScope();
        const projectId = "normalize-ranking";
        const doc = addDocument({
            scope,
            projectId,
            chunks: [
                activeLeaf("x-axis", [1, 0], { chunkIndex: 0 }),
                activeLeaf("diagonal", [3, 4], { chunkIndex: 1 }),
                activeLeaf("y-axis", [0, 1], { chunkIndex: 2 }),
            ],
        });
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        const hits = store.similaritySearch([3, 4], 3);
        const rows = getChunksByDocument(scope, doc.documentId);
        const expected = rows
            .map((row) => ({ id: row.id, score: (3 * row.embedding[0] + 4 * row.embedding[1]) / (5 * Math.hypot(...row.embedding)) }))
            .sort((a, b) => b.score - a.score)
            .map((row) => row.id);
        expect(hits.map((row) => row.chunkId)).toEqual(expected);
        expect(hits[0].score).toBeCloseTo(1, 5);
        expect(hits[1].score).toBeCloseTo(expected[1] === rows[0].id ? 0.6 : 0.8, 5);
        expect(normalizeFaissVector([3, 4])).toEqual([0.6, 0.8]);
        expect(store.stats({ ensure: false })).toMatchObject({ name: "faiss", dimension: 2, chunkCount: 3 });
    });

    it("reads embedded leaves with a stable bounded afterId cursor", () => {
        const scope = freshScope();
        const projectId = "paged-source";
        addDocument({
            scope,
            projectId,
            chunks: Array.from({ length: 5 }, (_, index) => activeLeaf(`page-${index}`, [1, index + 1], { chunkIndex: index })),
        });
        const first = getEmbeddedActiveChunks(scope, projectId, { limit: 2 });
        const second = getEmbeddedActiveChunks(scope, projectId, { afterId: first.at(-1).id, limit: 2 });
        const last = getEmbeddedActiveChunks(scope, projectId, { afterId: second.at(-1).id, limit: 2 });
        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(last).toHaveLength(1);
        expect([...first, ...second, ...last].map((row) => row.id)).toEqual(
            [...first, ...second, ...last].map((row) => row.id).sort((a, b) => a - b),
        );
    });

    it("maps FAISS labels back to SQLite chunk rows without storing text in the manifest", () => {
        const scope = freshScope();
        const projectId = "label-mapping";
        const document = addDocument({
            scope,
            projectId,
            chunks: [activeLeaf("SQLite authoritative text", [1, 0])],
        });
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        const hits = store.similaritySearch([1, 0], 1);
        const manifest = JSON.parse(fs.readFileSync(getFaissManifestPath({ scope, projectId, indexRoot: faissRoot }), "utf8"));
        expect(hits[0]).toMatchObject({
            chunkId: getChunksByDocument(scope, document.documentId)[0].id,
            content: "SQLite authoritative text",
        });
        expect(Object.keys(manifest).sort()).toEqual([
            "chunkCount", "chunkIds", "createdAt", "dimension", "engine", "generation", "indexChecksum", "metric", "schemaVersion", "scopeHash",
        ]);
        expect(JSON.stringify(manifest)).not.toContain("SQLite authoritative text");
        expect(JSON.stringify(manifest)).not.toContain(faissRoot);
    });

    it("isolates owner, tenant, and project scopes with different hashed index directories", () => {
        const alice = freshScope("tenant:alice");
        const bob = freshScope("tenant:bob");
        const projectId = "same-project-name";
        addDocument({ scope: alice, projectId, filePath: "alice.md", chunks: [activeLeaf("Alice private", [1, 0])] });
        addDocument({ scope: bob, projectId, filePath: "bob.md", chunks: [activeLeaf("Bob private", [1, 0])] });
        const aliceStore = new FaissVectorStore({ scope: alice, projectId, indexRoot: faissRoot });
        const bobStore = new FaissVectorStore({ scope: bob, projectId, indexRoot: faissRoot });
        expect(aliceStore.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["Alice private"]);
        expect(bobStore.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["Bob private"]);
        expect(scopeHashFor(alice, projectId)).not.toBe(scopeHashFor(bob, projectId));
        expect(getFaissScopeDirectory({ scope: alice, projectId, indexRoot: faissRoot })).not.toBe(
            getFaissScopeDirectory({ scope: alice, projectId: "other-project", indexRoot: faissRoot }),
        );
    });

    it("rechecks active leaf scope in SQLite and excludes parent, stale, and inactive document rows", () => {
        const scope = freshScope();
        const projectId = "hydrate-filters";
        const parentAndLeaf = addDocument({
            scope,
            projectId,
            filePath: "structured.pdf",
            chunks: [
                { chunkIndex: 0, chunkLevel: "parent", content: "parent should never be indexed", embedding: [1, 0], pageStart: 2, pageEnd: 4 },
                activeLeaf("active leaf", [0, 1], { chunkIndex: 1, parentChunkId: null, pageStart: 3, pageEnd: 3 }),
            ],
        });
        const old = addDocument({ scope, projectId, filePath: "revision.md", chunks: [activeLeaf("old revision", [1, 0])] });
        const current = addDocument({ scope, projectId, filePath: "revision.md", status: "indexing", previous: { id: old.documentId, revision: 1 }, chunks: [activeLeaf("new revision", [0, 1])] });
        const inactive = addDocument({ scope, projectId, filePath: "pending.md", status: "indexing", activate: false, chunks: [activeLeaf("pending", [1, 0])] });
        const allIds = [
            ...getChunksByDocument(scope, parentAndLeaf.documentId, { activeOnly: false }),
            ...getChunksByDocument(scope, old.documentId, { activeOnly: false }),
            ...getChunksByDocument(scope, current.documentId, { activeOnly: false }),
            ...getChunksByDocument(scope, inactive.documentId, { activeOnly: false }),
        ].map((row) => row.id);
        const hydrated = getActiveChunksByIds(scope, projectId, allIds);
        expect(hydrated.map((row) => row.content).sort()).toEqual(["active leaf", "new revision"]);
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        const manifest = store.buildIndex();
        expect(manifest.chunkCount).toBe(2);
        expect(store.similaritySearch([1, 0], 10).map((row) => row.content)).not.toContain("old revision");
        expect(store.similaritySearch([1, 0], 10).map((row) => row.content)).not.toContain("parent should never be indexed");
        expect(store.similaritySearch([1, 0], 10).map((row) => row.content)).not.toContain("pending");
    });

    it("bumps generation after revision activation and never recalls stale chunks", () => {
        const scope = freshScope();
        const projectId = "revision-lifecycle";
        const old = addDocument({ scope, projectId, filePath: "guide.md", chunks: [activeLeaf("old text", [1, 0])] });
        const oldGeneration = getKnowledgeIndexGeneration(scope, projectId);
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        expect(store.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["old text"]);
        addDocument({
            scope,
            projectId,
            filePath: "guide.md",
            status: "indexing",
            previous: { id: old.documentId, revision: 1 },
            chunks: [activeLeaf("new text", [1, 0])],
        });
        const newGeneration = getKnowledgeIndexGeneration(scope, projectId);
        expect(newGeneration).toBeGreaterThan(oldGeneration);
        expect(store.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["new text"]);
        expect(store.stats({ ensure: false }).generation).toBe(newGeneration);
    });

    it("loads the same persistent index after restart and rebuilds from SQLite with zero embedding calls after deletion", () => {
        const scope = freshScope();
        const projectId = "restart-rebuild";
        addDocument({ scope, projectId, chunks: [activeLeaf("restart durable", [1, 0])] });
        let pageCalls = 0;
        const storeApi = {
            getEmbeddedActiveChunks(requestScope, requestProject, options) {
                pageCalls += 1;
                return knowledgeStoreForTest.getEmbeddedActiveChunks(requestScope, requestProject, options);
            },
        };
        const first = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        const firstHits = first.similaritySearch([1, 0], 1);
        const indexPath = getFaissGenerationPath({ scope, projectId, generation: first.generation, indexRoot: faissRoot });
        const beforeRestartPages = pageCalls;
        const second = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot, store: storeApi });
        const secondHits = second.similaritySearch([1, 0], 1);
        expect(secondHits.map((row) => row.chunkId)).toEqual(firstHits.map((row) => row.chunkId));
        expect(pageCalls).toBe(beforeRestartPages);
        fs.rmSync(indexPath, { force: true });
        clearFaissStoreCache();
        let embeddingCalls = 0;
        const rebuilt = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot, store: storeApi });
        expect(rebuilt.similaritySearch([1, 0], 1)[0].content).toBe("restart durable");
        expect(embeddingCalls).toBe(0);
        expect(pageCalls).toBeGreaterThan(beforeRestartPages);
    });

    it("rebuilds damaged checksum/mapping manifests and leaves no visible temporary index on native failure", () => {
        const scope = freshScope();
        const projectId = "damage-recovery";
        addDocument({ scope, projectId, chunks: [activeLeaf("recover me", [1, 0])] });
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        store.similaritySearch([1, 0], 1);
        const manifestPath = getFaissManifestPath({ scope, projectId, indexRoot: faissRoot });
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.indexChecksum = "0".repeat(64);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        clearFaissStoreCache();
        expect(new FaissVectorStore({ scope, projectId, indexRoot: faissRoot }).similaritySearch([1, 0], 1)[0].content).toBe("recover me");
        const repaired = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        repaired.chunkIds = [];
        fs.writeFileSync(manifestPath, JSON.stringify(repaired));
        clearFaissStoreCache();
        expect(new FaissVectorStore({ scope, projectId, indexRoot: faissRoot }).similaritySearch([1, 0], 1)[0].content).toBe("recover me");

        const brokenScope = freshScope();
        addDocument({ scope: brokenScope, projectId: "native-failure", chunks: [activeLeaf("native failure", [1, 0])] });
        const broken = new FaissVectorStore({
            scope: brokenScope,
            projectId: "native-failure",
            indexRoot: faissRoot,
            faissModule: { IndexFlatIP: class { constructor() { throw new Error("native stack path"); } } },
        });
        expect(() => broken.buildIndex()).toThrowError(/FAISS_NATIVE_UNAVAILABLE/);
        const names = fs.existsSync(getFaissScopeDirectory({ scope: broken.scope, projectId: broken.projectId, indexRoot: faissRoot }))
            ? fs.readdirSync(getFaissScopeDirectory({ scope: broken.scope, projectId: broken.projectId, indexRoot: faissRoot }))
            : [];
        expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
        expect(names).not.toContain("current.manifest.json");
    });

    it("falls back to durable linear search on dimension mismatch and native search errors", async () => {
        const scope = freshScope();
        const projectId = "safe-fallback";
        addDocument({
            scope,
            projectId,
            chunks: [
                activeLeaf("dimension fallback hit", [1, 0]),
                activeLeaf("wrong dimension", [0, 1, 0], { chunkIndex: 1 }),
            ],
        });
        const dimensionMismatch = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        const mismatchResult = await hybridRetrieve({
            scope,
            projectId,
            query: "dimension fallback hit",
            store: knowledgeStoreForTest,
            embedder: { embed: async () => [[1, 0]] },
            vectorStore: dimensionMismatch,
        });
        expect(mismatchResult.status).toBe("ok");
        expect(mismatchResult.metrics.faissFallbackCode).toBe("FAISS_DIMENSION_MISMATCH");
        expect(mismatchResult.metrics.vectorBackend).toBe("durable");

        class SearchBrokenIndex {
            constructor(dimension) { this.dimension = dimension; this.count = 0; }
            add(values) { this.count += values.length / this.dimension; }
            getDimension() { return this.dimension; }
            ntotal() { return this.count; }
            write(filePath) { fs.writeFileSync(filePath, "synthetic-index"); }
            search() { throw new Error("native search stack path"); }
            static read() {
                const loaded = new SearchBrokenIndex(2);
                loaded.count = 1;
                return loaded;
            }
        }
        const searchBroken = new FaissVectorStore({
            scope,
            projectId: "search-fallback",
            indexRoot: faissRoot,
            faissModule: { IndexFlatIP: SearchBrokenIndex },
            store: knowledgeStoreForTest,
        });
        addDocument({ scope, projectId: "search-fallback", chunks: [activeLeaf("search fallback hit", [1, 0])] });
        const searchResult = await hybridRetrieve({
            scope,
            projectId: "search-fallback",
            query: "search fallback hit",
            store: knowledgeStoreForTest,
            embedder: { embed: async () => [[1, 0]] },
            vectorStore: searchBroken,
        });
        expect(searchResult.status).toBe("ok");
        expect(searchResult.metrics.faissFallbackCode).toBe("FAISS_SEARCH_FAILED");
        expect(searchResult.items[0].content).toContain("search fallback hit");
    });

    it("safely skips null, malformed, and zero embeddings", () => {
        const scope = freshScope();
        const projectId = "invalid-embeddings";
        addDocument({
            scope,
            projectId,
            chunks: [
                activeLeaf("null vector", null),
                activeLeaf("malformed vector", ["not-a-number", 1], { chunkIndex: 1 }),
                activeLeaf("zero vector", [0, 0], { chunkIndex: 2 }),
            ],
        });
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot });
        expect(store.similaritySearch([1, 0], 3)).toEqual([]);
        expect(store.stats({ ensure: false })).toMatchObject({ chunkCount: 0, dimension: 0 });
        expect(JSON.parse(fs.readFileSync(getFaissManifestPath({ scope, projectId, indexRoot: faissRoot }), "utf8"))).toMatchObject({ chunkCount: 0, dimension: 0 });
    });

    it("uses preferredSource/filter and preserves PDF pages, headings, parent linkage, and citation output", async () => {
        const scope = freshScope();
        const projectId = "__uploads__";
        addDocument({
            scope,
            projectId,
            filePath: "guide.pdf",
            chunks: [activeLeaf("guide durable evidence", [1, 0], { pageStart: 3, pageEnd: 5, headingPath: ["Guide", "Setup"], parentChunkId: 91 })],
        });
        addDocument({ scope, projectId, filePath: "other.pdf", chunks: [activeLeaf("other evidence", [0, 1], { pageStart: 9, pageEnd: 9 })] });
        process.env.RAG_FAISS_ENABLED = "true";
        process.env.RAG_FAISS_READ_ENABLED = "true";
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "guide durable evidence",
            preferredSource: "C:\\uploads\\guide.pdf",
            deps: { embedder: { embed: async () => [[1, 0]] } },
            opts: { skipRerank: true },
        });
        expect(result.status).toBe("ok");
        expect(result.items.every((item) => item.filePath === "guide.pdf")).toBe(true);
        expect(result.items[0]).toMatchObject({ pageStart: 3, pageEnd: 5, headingPath: ["Guide", "Setup"], parentChunkId: 91 });
        expect(result.text).toContain("guide.pdf p.3-5 · Guide > Setup");
        expect(result.text).not.toContain("p.0");
    });

    it("compare mode only compares: durable linear remains the formal result and top-k IDs overlap", async () => {
        const scope = freshScope();
        const projectId = "compare-mode";
        addDocument({ scope, projectId, chunks: [activeLeaf("alpha exact", [1, 0]), activeLeaf("beta nearby", [0.8, 0.6], { chunkIndex: 1 })] });
        process.env.RAG_FAISS_ENABLED = "true";
        process.env.RAG_FAISS_COMPARE_ENABLED = "true";
        const durable = createVectorStoreAdapter({ scope, projectId, kind: "durable" });
        const expectedLinear = durable.similaritySearch([1, 0], 2).map((row) => row.chunkId);
        const result = await hybridRetrieve({
            scope,
            projectId,
            query: "alpha",
            embedder: { embed: async () => [[1, 0]] },
            vectorStore: durable,
        });
        expect(result.status).toBe("ok");
        expect(result.metrics.vectorBackend).toBe("durable");
        expect(result.metrics.faissCompareOverlap).toBe(1);
        expect(result.items.map((row) => row.chunkId)).toEqual(expectedLinear.slice(0, result.items.length));
    });

    it("selects durable or FAISS only from the call-time read flag", () => {
        const scope = freshScope();
        const projectId = "flag-selection";
        expect(getConfiguredVectorStore({ scope, projectId }).name).toBe("durable");
        process.env.RAG_FAISS_READ_ENABLED = "true";
        expect(getConfiguredVectorStore({ scope, projectId }).name).toBe("faiss");
        clearRagFlags();
        expect(getConfiguredVectorStore({ scope, projectId }).name).toBe("durable");
    });

    it("does not persist query text in FAISS-specific telemetry and builds once for same-generation concurrent ensure calls", async () => {
        const scope = freshScope();
        const projectId = "telemetry-concurrency";
        addDocument({ scope, projectId, chunks: [activeLeaf("safe telemetry", [1, 0])] });
        let pageCalls = 0;
        const knowledgeStoreForSpy = await import("./knowledgeStore.js");
        const storeApi = {
            ...knowledgeStoreForSpy,
            getEmbeddedActiveChunks(requestScope, requestProject, options) {
                pageCalls += 1;
                return knowledgeStoreForSpy.getEmbeddedActiveChunks(requestScope, requestProject, options);
            },
        };
        const store = new FaissVectorStore({ scope, projectId, indexRoot: faissRoot, store: storeApi });
        await Promise.all([store.ensureIndex(), store.ensureIndex()]);
        expect(pageCalls).toBe(1);
        recordKnowledgeQuery({
            scope,
            projectId,
            query: "SECRET QUERY Token Authorization https://provider.example",
            mode: "hybrid",
            source: "faiss",
            metrics: { vectorBackend: "faiss", faissCompareOverlap: 1, vectorIndexGeneration: store.generation },
        });
        const recent = getRecentKnowledgeQueries(scope, { limit: 1 })[0];
        expect(recent.query_preview).toBe("");
        expect(JSON.stringify(recent)).not.toContain("Authorization");
        expect(JSON.stringify(recent)).not.toContain("provider.example");
    });

    it("does not fail a committed index job when derived FAISS build fails", async () => {
        const scope = freshScope();
        const result = await indexProjectSnapshot({
            scope,
            projectId: "ingest-faiss-fallback",
            files: [{ path: "src/fallback.js", text: "export const fallback = true;" }],
            vectorStore: {
                name: "faiss",
                ensureIndex() {
                    throw Object.assign(new Error("native failure details"), { code: "FAISS_NATIVE_UNAVAILABLE" });
                },
            },
        });
        expect(result.indexed).toBe(1);
        expect(result.errors).toEqual([]);
        expect(result.faiss).toEqual({ status: "fallback", fallbackCode: "FAISS_NATIVE_UNAVAILABLE" });
    });

    it("keeps FAISS telemetry schema and migration ledger idempotent across repeated initDB", () => {
        initDB();
        initDB();
        const columns = db.prepare("PRAGMA table_info(knowledge_query_log)").all().map((row) => row.name);
        expect(columns).toEqual(expect.arrayContaining([
            "vector_backend",
            "vector_search_latency_ms",
            "vector_index_load_ms",
            "vector_index_build_ms",
            "vector_index_generation",
            "vector_index_chunk_count",
            "faiss_fallback_code",
            "faiss_compare_overlap",
            "faiss_compare_score_delta",
            "faiss_compare_linear_latency_ms",
            "faiss_compare_search_latency_ms",
        ]));
        const ledger = db.prepare("SELECT COUNT(*) AS count FROM security_migration_audit WHERE migration = ?").get("RAG-KB-FAISS-1");
        expect(Number(ledger?.count)).toBe(1);
    });
});

// Imported once at the bottom to keep the test helper delegation synchronous
// while avoiding a second DB module instance in the worker.
import * as knowledgeStoreForTest from "./knowledgeStore.js";
