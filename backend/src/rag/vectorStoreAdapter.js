/**
 * Phase 7 / R4 — VectorStoreAdapter (roadmap R4 checklist #3).
 *
 * A single storage contract shared by every RAG read/write path so consumers
 * never import a concrete vector engine:
 *
 *   { name, addVectors(rows), similaritySearch(queryVector, k, filter),
 *     removeByDocument(documentId), clear(projectId), stats(), invalidate() }
 *
 * Three adapters are provided under the same facade:
 *   - DurableVectorStore — per (owner,tenant,project) cosine index whose vectors
 *     are persisted in knowledge_chunks.embedding (JSON float arrays) and
 *     rebuilt lazily from the same DB after a restart (roadmap R4 DoD:
 *     "索引重启后可用"). Add/remove only mutate the in-memory cache; every
 *     vector's durable copy is written by the knowledge store first.
 *   - InMemoryVectorStore — plain in-memory cosine store used as the reference /
 *     unit-test adapter and as the "memory adapter" side of dual-read compares.
 *   - FaissVectorStore — persistent per-scope faiss-node IndexFlatIP derived
 *     index. It L2-normalizes vectors and hydrates every label through SQLite;
 *     FlatIP is exact but exhaustive O(N), not an ANN/HNSW implementation.
 *
 * Both are deterministic, network-free, and do NOT embed text: embedding
 * inference is the caller's (embedder) job, keeping storage pure. Scores are
 * cosine similarity in [-1, 1]; retrieval layers map to their own 0..1 score.
 */
import {
    normalizeKnowledgeScope,
    requireKnowledgeProject,
    getEmbeddedActiveChunks,
    getKnowledgeIndexGeneration,
} from "./knowledgeStore.js";
import {
    FaissVectorStore,
    getFaissVectorStore,
    invalidateFaissStore,
    clearFaissStoreCache,
} from "./faissVectorStore.js";
import { ragFaissReadEnabled } from "./flags.js";

export const VECTOR_STORE_CONTRACT = Object.freeze([
    "name", "addVectors", "similaritySearch", "removeByDocument", "clear", "stats", "invalidate",
]);

export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]) || 0;
        const y = Number(b[i]) || 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function toVectorArray(v) {
    if (!Array.isArray(v)) return null;
    return v.map((n) => Number(n) || 0);
}

function assertVector(queryVector) {
    const v = toVectorArray(queryVector);
    if (!v || v.length === 0) throw new Error("similaritySearch requires a non-empty query vector");
    return v;
}

function cosineTopK(entries, queryVector, k, filter = null) {
    const scored = [];
    for (const entry of entries) {
        if (filter && typeof filter === "function" && !filter(entry)) continue;
        const score = cosineSimilarity(queryVector, entry.vector);
        scored.push({ ...entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, k | 0)).map(({ vector, ...rest }) => rest);
}

// ────────────────────────── durable adapter ──────────────────────────

const storeCache = new Map();
const MAX_CACHED_STORES = 64;
function pruneStoreCache() {
    while (storeCache.size > MAX_CACHED_STORES) {
        storeCache.delete(storeCache.keys().next().value);
    }
}
function projectKey(scope, projectId) {
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    return `${ownerUserId}:${tenantId}:${projectId}`;
}

/**
 * DB-backed per-project cosine index. Loads active embedded chunks lazily from
 * the knowledge store (so a fresh process rebuilds on first search), then keeps
 * an incremental in-memory cache. The generation check is the cross-process
 * coherence path; invalidate() remains a local fast path for same-process
 * callers and is not required for correctness.
 */
export class DurableVectorStore {
    constructor({ scope, projectId, store = null, lazy = true } = {}) {
        const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
        this.ownerUserId = ownerUserId;
        this.tenantId = tenantId;
        this.projectId = requireKnowledgeProject(projectId);
        this.name = "durable";
        // store: a module exposing getEmbeddedActiveChunks(scope, projectId, opts)
        this.store = store || { getEmbeddedActiveChunks };
        this.lazy = lazy !== false;
        this.entries = [];
        this.loaded = false;
        this.generation = -1;
        this._version = 0;
    }

    _readGeneration() {
        const reader = this.store.getKnowledgeIndexGeneration || getKnowledgeIndexGeneration;
        try {
            return Number(reader(
                { ownerUserId: this.ownerUserId, tenantId: this.tenantId },
                this.projectId,
            ) || 0);
        } catch {
            // A custom unit-test store may only implement the old vector read
            // seam. Its local behavior remains valid without generation rows.
            return this.generation < 0 ? 0 : this.generation;
        }
    }

    _loadFromDurable(generation) {
        const reader = this.store.getEmbeddedActiveChunks || getEmbeddedActiveChunks;
        const rows = [];
        let afterId = null;
        const pageSize = 1000;
        while (true) {
            const page = reader(
                { ownerUserId: this.ownerUserId, tenantId: this.tenantId },
                this.projectId,
                { afterId, limit: pageSize },
            ) || [];
            if (!Array.isArray(page) || page.length === 0) break;
            rows.push(...page);
            const ids = page.map((row) => Number(row?.id)).filter((id) => Number.isSafeInteger(id));
            const lastId = ids.length ? Math.max(...ids) : afterId;
            if (lastId == null || lastId === afterId || page.length < pageSize) break;
            afterId = lastId;
        }
        this.entries = (rows || [])
            .filter((row) => Array.isArray(row.embedding) && row.embedding.length > 0)
            .map((row) => ({
                chunkId: row.id,
                documentId: row.document_id,
                filePath: row.file_path,
                fileName: row.file_name,
                chunkIndex: row.chunk_index,
                chunkLevel: row.chunk_level || "leaf",
                parentChunkId: row.parent_chunk_id ?? null,
                pageStart: row.page_start ?? null,
                pageEnd: row.page_end ?? null,
                headingPath: row.headingPath || [],
                startLine: row.start_line,
                endLine: row.end_line,
                content: row.content,
                symbols: String(row.symbols || ""),
                vector: toVectorArray(row.embedding),
            }))
            .filter((entry) => entry.vector && entry.vector.length > 0);
        // Build the replacement array completely before publishing it. A
        // concurrent query therefore sees either the old or the new snapshot.
        this.loaded = true;
        this.generation = generation;
        this._version += 1;
    }

    _ensureLoaded() {
        const generation = this._readGeneration();
        if (this.loaded && this.generation === generation) return;
        this._loadFromDurable(generation);
    }

    invalidate() {
        this.loaded = false;
        this.entries = [];
        this.generation = -1;
        this._version += 1;
    }

    /**
     * rows: [{ id?, chunkId, vector, ...metadata }] persisted by the caller.
     * Only present in-memory rows are appended — durable copy is the DB's job.
     */
    addVectors(rows = []) {
        this._ensureLoaded();
        const added = [];
        const seen = new Set(this.entries.map((e) => e.chunkId));
        for (const row of rows) {
            const vector = toVectorArray(row.vector ?? row.embedding);
            if (!vector || vector.length === 0) continue;
            const chunkId = row.chunkId ?? row.id;
            if (chunkId == null) continue;
            if (seen.has(chunkId)) continue;
            seen.add(chunkId);
            this.entries.push({
                chunkId,
                documentId: row.documentId ?? row.document_id,
                filePath: row.filePath ?? row.file_path,
                fileName: row.fileName ?? row.file_name,
                chunkIndex: row.chunkIndex ?? row.chunk_index,
                chunkLevel: row.chunkLevel ?? row.chunk_level ?? "leaf",
                parentChunkId: row.parentChunkId ?? row.parent_chunk_id ?? null,
                pageStart: row.pageStart ?? row.page_start ?? null,
                pageEnd: row.pageEnd ?? row.page_end ?? null,
                headingPath: row.headingPath || [],
                startLine: row.startLine ?? row.start_line,
                endLine: row.endLine ?? row.end_line,
                content: row.content,
                symbols: String(row.symbols || ""),
                vector,
            });
            added.push(chunkId);
        }
        this._version += 1;
        return added;
    }

    removeByDocument(documentId) {
        if (documentId == null) return 0;
        this._ensureLoaded();
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => String(e.documentId) !== String(documentId));
        const removed = before - this.entries.length;
        if (removed > 0) this._version += 1;
        return removed;
    }

    /** Search by a query vector over the current project's active embedded chunks. */
    similaritySearch(queryVector, k = 5, filter = null) {
        this._ensureLoaded();
        return cosineTopK(this.entries, assertVector(queryVector), k, filter);
    }

    clear() {
        this.entries = [];
        this.loaded = true;
        this._version += 1;
        return true;
    }

    stats() {
        this._ensureLoaded();
        const dims = this.entries.map((e) => e.vector.length);
        return {
            name: this.name,
            projectId: this.projectId,
            chunkCount: this.entries.length,
            loaded: this.loaded,
            generation: this.generation,
            version: this._version,
            dimension: dims.length ? Math.min(...dims) : 0,
            hasEmbeddings: dims.length > 0,
        };
    }
}

/**
 * Facade cache: one live DurableVectorStore per (owner,tenant,project) process
 * cache entry, so indexer + retrieval + dual-read share the same in-memory state
 * and invalidate() after writes is observed everywhere.
 */
export function getDurableVectorStore({ scope, projectId, store = null }) {
    const key = projectKey(scope, projectId);
    if (!storeCache.has(key)) {
        storeCache.set(key, new DurableVectorStore({ scope, projectId, store }));
        pruneStoreCache();
    }
    return storeCache.get(key);
}

export function invalidateDurableStore({ scope, projectId }) {
    const key = projectKey(scope, projectId);
    const cached = storeCache.get(key);
    if (cached) cached.invalidate();
    return Boolean(cached);
}

export function clearDurableStoreCache() {
    storeCache.clear();
}

/**
 * Select the durable vector reader at call time. The default remains the
 * SQLite-backed JavaScript cosine adapter; enabling FAISS is an explicit
 * server-side canary and never changes the legacy LangChain adapter.
 */
export function getConfiguredVectorStore({ scope, projectId, store = null } = {}) {
    if (ragFaissReadEnabled()) {
        return getFaissVectorStore({ scope, projectId, store });
    }
    return getDurableVectorStore({ scope, projectId, store });
}

// ────────────────────────── in-memory (reference/memory adapter) ──────────────────────────

/** Deterministic in-memory cosine adapter — also the "memory adapter" in dual-read. */
export class InMemoryVectorStore {
    constructor({ scope = null, projectId = null } = {}) {
        const normalized = scope ? normalizeKnowledgeScope(scope) : null;
        this.ownerUserId = normalized?.ownerUserId || null;
        this.tenantId = normalized?.tenantId || null;
        this.projectId = projectId == null ? null : String(projectId);
        this.name = "memory";
        this.entries = [];
        this._version = 0;
    }

    addVectors(rows = []) {
        const added = [];
        for (const row of rows) {
            const vector = toVectorArray(row.vector ?? row.embedding);
            if (!vector || vector.length === 0) continue;
            this.entries.push({
                chunkId: row.chunkId ?? row.id,
                documentId: row.documentId ?? row.document_id,
                filePath: row.filePath ?? row.file_path,
                fileName: row.fileName ?? row.file_name,
                chunkIndex: row.chunkIndex ?? row.chunk_index,
                chunkLevel: row.chunkLevel ?? row.chunk_level ?? "leaf",
                parentChunkId: row.parentChunkId ?? row.parent_chunk_id ?? null,
                pageStart: row.pageStart ?? row.page_start ?? null,
                pageEnd: row.pageEnd ?? row.page_end ?? null,
                headingPath: row.headingPath || [],
                startLine: row.startLine ?? row.start_line,
                endLine: row.endLine ?? row.end_line,
                content: row.content,
                symbols: String(row.symbols || ""),
                vector,
            });
            added.push(this.entries.length - 1);
        }
        this._version += 1;
        return added;
    }

    similaritySearch(queryVector, k = 5, filter = null) {
        return cosineTopK(this.entries, assertVector(queryVector), k, filter);
    }

    removeByDocument(documentId) {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => String(e.documentId) !== String(documentId));
        const removed = before - this.entries.length;
        if (removed > 0) this._version += 1;
        return removed;
    }

    clear() {
        this.entries = [];
        this._version += 1;
        return true;
    }

    stats() {
        const dims = this.entries.map((e) => e.vector.length);
        return {
            name: this.name,
            projectId: this.projectId,
            chunkCount: this.entries.length,
            loaded: true,
            version: this._version,
            dimension: dims.length ? Math.min(...dims) : 0,
            hasEmbeddings: dims.length > 0,
        };
    }
}

/**
 * Factory (roadmap R4 #3 facade): `kind: "durable"` returns the shared DB-backed
 * store; `kind: "faiss"` returns the shared persistent derived index; and
 * `kind: "memory"` returns a fresh in-memory reference store.
 */
export function createVectorStoreAdapter({ kind = "durable", scope = null, projectId = null, store = null } = {}) {
    if (kind === "memory") return new InMemoryVectorStore({ scope, projectId });
    if (kind === "durable") return getDurableVectorStore({ scope, projectId, store });
    if (kind === "faiss") return getFaissVectorStore({ scope, projectId, store });
    throw new Error(`unknown vector store adapter kind: ${kind}`);
}

export { FaissVectorStore, getFaissVectorStore, invalidateFaissStore, clearFaissStoreCache };

export default {
    VECTOR_STORE_CONTRACT, cosineSimilarity, toVectorArray,
    DurableVectorStore, FaissVectorStore, InMemoryVectorStore,
    getDurableVectorStore, getFaissVectorStore, getConfiguredVectorStore,
    invalidateFaissStore, clearFaissStoreCache,
    invalidateDurableStore, clearDurableStoreCache, createVectorStoreAdapter,
};
