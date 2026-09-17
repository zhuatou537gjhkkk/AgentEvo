/**
 * Durable SQLite-backed FAISS adapter for project and uploaded-document RAG.
 *
 * SQLite remains the source of truth. This module stores only a derived
 * IndexFlatIP file and an ordered chunk-id mapping; text, citations, and all
 * authorization-sensitive metadata are hydrated from SQLite after search.
 * FlatIP is FAISS's exact inner-product implementation (after L2
 * normalization, inner product == cosine similarity). It is still exhaustive
 * O(N) search; HNSW/IVF/other ANN structures are deliberately a later phase.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
    normalizeKnowledgeScope,
    requireKnowledgeProject,
    getEmbeddedActiveChunks,
    getActiveChunksByIds,
    getKnowledgeIndexGeneration,
} from "./knowledgeStore.js";

export const FAISS_SCHEMA_VERSION = 1;
export const FAISS_ENGINE = "faiss-node";
export const FAISS_METRIC = "IndexFlatIP";
export const FAISS_PAGE_SIZE = 512;
export const FAISS_MAX_PAGE_SIZE = 2000;
export const FAISS_ADD_BATCH_SIZE = 256;
export const FAISS_DEFAULT_MAX_CANDIDATES = 4096;

const require = createRequire(import.meta.url);
const storeCache = new Map();
const MAX_CACHED_STORES = 64;

function boundedInteger(value, fallback, max, minimum = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(minimum, Math.min(max, Math.trunc(n)));
}

function canonicalScope(scope, projectId) {
    const normalized = normalizeKnowledgeScope(scope);
    const project = requireKnowledgeProject(projectId);
    return { ...normalized, projectId: project };
}

export function scopeHashFor(scope, projectId) {
    const value = canonicalScope(scope, projectId);
    return crypto.createHash("sha256")
        .update(JSON.stringify([value.ownerUserId, value.tenantId, value.projectId]))
        .digest("hex");
}

/** Resolve only a server-configured root; raw scope/project values never enter a path. */
export function resolveFaissIndexRoot({ indexRoot = null, root = null } = {}) {
    const configured = indexRoot ?? root ?? process.env.RAG_FAISS_INDEX_ROOT;
    const storageRoot = process.env.KNOWLEDGE_INGEST_STORAGE_ROOT
        || path.join(process.cwd(), "tmp", "knowledge-ingest");
    return path.resolve(String(configured || path.join(storageRoot, "faiss-indexes")));
}

export function getFaissScopeDirectory({ scope, projectId, indexRoot = null, root = null } = {}) {
    return path.join(
        resolveFaissIndexRoot({ indexRoot, root }),
        scopeHashFor(scope, projectId),
    );
}

export function getFaissManifestPath({ scope, projectId, indexRoot = null, root = null } = {}) {
    return path.join(getFaissScopeDirectory({ scope, projectId, indexRoot, root }), "current.manifest.json");
}

export function getFaissGenerationPath({ scope, projectId, generation, indexRoot = null, root = null } = {}) {
    const generationNumber = Number(generation);
    if (!Number.isSafeInteger(generationNumber) || generationNumber < 0) {
        throw createFaissError("FAISS_GENERATION_INVALID");
    }
    return path.join(
        getFaissScopeDirectory({ scope, projectId, indexRoot, root }),
        `generation-${generationNumber}.faiss`,
    );
}

export function createFaissError(code, cause = null) {
    const error = new Error(String(code));
    error.code = String(code);
    if (cause) error.cause = cause;
    return error;
}

const SAFE_FAISS_CODES = new Set([
    "FAISS_NATIVE_UNAVAILABLE",
    "FAISS_GENERATION_INVALID",
    "FAISS_MANIFEST_MISSING",
    "FAISS_MANIFEST_INVALID",
    "FAISS_CHECKSUM_MISMATCH",
    "FAISS_INDEX_LOAD_FAILED",
    "FAISS_INDEX_BUILD_FAILED",
    "FAISS_INDEX_WRITE_FAILED",
    "FAISS_MAPPING_MISMATCH",
    "FAISS_DIMENSION_MISMATCH",
    "FAISS_QUERY_INVALID",
    "FAISS_SEARCH_FAILED",
    "FAISS_HYDRATE_FAILED",
    "FAISS_HYDRATE_UNAVAILABLE",
    "FAISS_CANDIDATE_LIMIT",
]);

export function safeFaissErrorCode(error, fallback = "FAISS_INDEX_UNAVAILABLE") {
    const code = String(error?.code || "").toUpperCase();
    return SAFE_FAISS_CODES.has(code) ? code : fallback;
}

function parseEmbedding(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Return a new normalized vector and reject malformed/zero vectors. */
export function normalizeFaissVector(vector, expectedDimension = null) {
    const source = parseEmbedding(vector);
    if (!source || source.length === 0) return null;
    if (expectedDimension != null && source.length !== expectedDimension) {
        throw createFaissError("FAISS_DIMENSION_MISMATCH");
    }
    if (!source.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
    const values = [...source];
    let normSquared = 0;
    for (const value of values) normSquared += value * value;
    if (!Number.isFinite(normSquared) || normSquared <= 0) return null;
    const norm = Math.sqrt(normSquared);
    return values.map((value) => value / norm);
}

function checksumFile(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isSafeChunkId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

const MANIFEST_KEYS = new Set([
    "schemaVersion",
    "engine",
    "metric",
    "scopeHash",
    "generation",
    "dimension",
    "chunkCount",
    "chunkIds",
    "indexChecksum",
    "createdAt",
]);

function validateManifest(manifest, { scopeHash, generation } = {}) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        return { valid: false, code: "FAISS_MANIFEST_INVALID" };
    }
    const keys = Object.keys(manifest);
    if (keys.length !== MANIFEST_KEYS.size || keys.some((key) => !MANIFEST_KEYS.has(key))) {
        return { valid: false, code: "FAISS_MANIFEST_INVALID" };
    }
    if (manifest.schemaVersion !== FAISS_SCHEMA_VERSION
        || manifest.engine !== FAISS_ENGINE
        || manifest.metric !== FAISS_METRIC
        || manifest.scopeHash !== scopeHash
        || manifest.generation !== generation
        || !Number.isSafeInteger(manifest.dimension)
        || manifest.dimension < 0
        || !Number.isSafeInteger(manifest.chunkCount)
        || manifest.chunkCount < 0
        || !Array.isArray(manifest.chunkIds)
        || manifest.chunkIds.length !== manifest.chunkCount
        || typeof manifest.indexChecksum !== "string"
        || typeof manifest.createdAt !== "string") {
        return { valid: false, code: "FAISS_MANIFEST_INVALID" };
    }
    if (manifest.chunkCount === 0 && (manifest.dimension !== 0 || manifest.indexChecksum !== "")) {
        return { valid: false, code: "FAISS_MANIFEST_INVALID" };
    }
    if (manifest.chunkCount > 0
        && (manifest.dimension <= 0 || !/^[a-f0-9]{64}$/.test(manifest.indexChecksum))) {
        return { valid: false, code: "FAISS_MANIFEST_INVALID" };
    }
    const ids = manifest.chunkIds.map(Number);
    if (ids.some((id) => !isSafeChunkId(id) || !Number.isInteger(id)) || new Set(ids).size !== ids.length) {
        return { valid: false, code: "FAISS_MAPPING_MISMATCH" };
    }
    return { valid: true, manifest: { ...manifest, chunkIds: ids } };
}

function readManifest(filePath) {
    if (!fs.existsSync(filePath)) return { manifest: null, code: "FAISS_MANIFEST_MISSING" };
    try {
        return { manifest: JSON.parse(fs.readFileSync(filePath, "utf8")), code: null };
    } catch {
        return { manifest: null, code: "FAISS_MANIFEST_INVALID" };
    }
}

function resolveIndexClass(faissModule) {
    const mod = faissModule?.default || faissModule;
    if (!mod || typeof mod.IndexFlatIP !== "function") {
        throw createFaissError("FAISS_NATIVE_UNAVAILABLE");
    }
    return mod.IndexFlatIP;
}

function loadFaissModule(injected) {
    if (injected) return injected;
    try {
        return require("faiss-node");
    } catch (error) {
        throw createFaissError("FAISS_NATIVE_UNAVAILABLE", error);
    }
}

function indexDimension(index) {
    try {
        return Number(typeof index.getDimension === "function" ? index.getDimension() : index.dimension);
    } catch {
        return 0;
    }
}

function indexCount(index) {
    try {
        return Number(typeof index.ntotal === "function" ? index.ntotal() : index.ntotal);
    } catch {
        return -1;
    }
}

function indexSearch(index, query, candidateK) {
    try {
        const result = index.search(query, candidateK);
        const distances = Array.isArray(result?.distances) ? result.distances : [];
        const labels = Array.isArray(result?.labels) ? result.labels : [];
        return { distances, labels };
    } catch (error) {
        throw createFaissError("FAISS_SEARCH_FAILED", error);
    }
}

function addToIndex(index, vectors) {
    if (!vectors.length) return;
    const flat = [];
    for (const vector of vectors) flat.push(...vector);
    try {
        index.add(flat);
    } catch (error) {
        throw createFaissError("FAISS_INDEX_BUILD_FAILED", error);
    }
}

function makeTempPath(directory, prefix, suffix) {
    return path.join(directory, `.${prefix}-${process.pid}-${crypto.randomUUID()}${suffix}`);
}

function publishAtomic(tempPath, targetPath) {
    const backupPath = `${targetPath}.backup-${process.pid}-${crypto.randomUUID()}`;
    let movedOld = false;
    try {
        if (fs.existsSync(targetPath)) {
            fs.renameSync(targetPath, backupPath);
            movedOld = true;
        }
        fs.renameSync(tempPath, targetPath);
        if (movedOld) fs.rmSync(backupPath, { force: true });
    } catch (error) {
        try {
            if (!fs.existsSync(targetPath) && movedOld && fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, targetPath);
            }
        } catch {
            // The original is best-effort restored; the caller still receives
            // a safe code and retrieval falls back to SQLite linear search.
        }
        throw error;
    } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    }
}

function cleanupOldGenerationFiles(directory, currentGeneration) {
    if (!fs.existsSync(directory)) return;
    let names = [];
    try {
        names = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    const pattern = /^generation-(\d+)\.faiss$/;
    for (const entry of names) {
        if (!entry.isFile()) continue;
        const match = pattern.exec(entry.name);
        if (!match || Number(match[1]) === currentGeneration) continue;
        const candidate = path.join(directory, entry.name);
        try {
            fs.rmSync(candidate, { force: true });
        } catch {
            // Cleanup is never allowed to make an already-published index fail.
        }
    }
}

function metadataFromRow(row, score = null) {
    return {
        chunkId: row.id ?? row.chunkId,
        documentId: row.document_id ?? row.documentId ?? null,
        filePath: row.file_path ?? row.filePath ?? null,
        fileName: row.file_name ?? row.fileName ?? null,
        chunkIndex: row.chunk_index ?? row.chunkIndex ?? null,
        chunkLevel: row.chunk_level ?? row.chunkLevel ?? "leaf",
        parentChunkId: row.parent_chunk_id ?? row.parentChunkId ?? null,
        pageStart: row.page_start ?? row.pageStart ?? null,
        pageEnd: row.page_end ?? row.pageEnd ?? null,
        headingPath: row.headingPath ?? row.heading_path ?? [],
        startLine: row.start_line ?? row.startLine ?? null,
        endLine: row.end_line ?? row.endLine ?? null,
        content: row.content ?? "",
        symbols: row.symbols ?? "",
        commit: row.source_commit ?? row.sourceCommit ?? null,
        sourceRunId: row.source_run_id ?? row.sourceRunId ?? null,
        revision: row.doc_revision ?? row.revision ?? null,
        score,
    };
}

function normalizeGeneration(value) {
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation < 0) return 0;
    return generation;
}

function pruneCache() {
    while (storeCache.size > MAX_CACHED_STORES) {
        storeCache.delete(storeCache.keys().next().value);
    }
}

/**
 * Persistent per-scope FAISS adapter. All public search results are hydrated
 * from the injected/default knowledge store and are filtered again by SQL.
 */
export class FaissVectorStore {
    constructor({
        scope,
        projectId,
        store = null,
        indexRoot = null,
        root = null,
        faissModule = null,
        pageSize = FAISS_PAGE_SIZE,
        maxCandidateK = FAISS_DEFAULT_MAX_CANDIDATES,
        lazy = true,
    } = {}) {
        const normalized = canonicalScope(scope, projectId);
        this.ownerUserId = normalized.ownerUserId;
        this.tenantId = normalized.tenantId;
        this.projectId = normalized.projectId;
        this.scopeHash = scopeHashFor(normalized, normalized.projectId);
        this.name = "faiss";
        this.store = store || {
            getEmbeddedActiveChunks,
            getActiveChunksByIds,
            getKnowledgeIndexGeneration,
        };
        this.indexRoot = resolveFaissIndexRoot({ indexRoot, root });
        this.faissModule = faissModule;
        this.pageSize = boundedInteger(pageSize, FAISS_PAGE_SIZE, FAISS_MAX_PAGE_SIZE);
        this.maxCandidateK = boundedInteger(maxCandidateK, FAISS_DEFAULT_MAX_CANDIDATES, 1000000);
        this.lazy = lazy !== false;
        this.loaded = false;
        this.index = null;
        this.chunkIds = [];
        this.dimension = 0;
        this.generation = -1;
        this.manifest = null;
        this.loadLatencyMs = 0;
        this.buildLatencyMs = 0;
        this.lastErrorCode = null;
    }

    get scope() {
        return { ownerUserId: this.ownerUserId, tenantId: this.tenantId };
    }

    _readGeneration() {
        const reader = this.store.getKnowledgeIndexGeneration || getKnowledgeIndexGeneration;
        try {
            return normalizeGeneration(reader(this.scope, this.projectId));
        } catch {
            return this.generation < 0 ? 0 : this.generation;
        }
    }

    _directory() {
        return getFaissScopeDirectory({ scope: this.scope, projectId: this.projectId, indexRoot: this.indexRoot });
    }

    _manifestPath() {
        return path.join(this._directory(), "current.manifest.json");
    }

    _generationPath(generation) {
        return path.join(this._directory(), `generation-${generation}.faiss`);
    }

    _setLoaded({ index, chunkIds, dimension, generation, manifest }) {
        this.index = index;
        this.chunkIds = [...chunkIds];
        this.dimension = dimension;
        this.generation = generation;
        this.manifest = manifest;
        this.loaded = true;
        this.lastErrorCode = null;
    }

    _loadPersisted(generation) {
        const started = Date.now();
        const { manifest, code: readCode } = readManifest(this._manifestPath());
        if (!manifest) return { ok: false, code: readCode || "FAISS_MANIFEST_MISSING" };
        const validated = validateManifest(manifest, { scopeHash: this.scopeHash, generation });
        if (!validated.valid) return { ok: false, code: validated.code };
        const current = validated.manifest;
        if (current.chunkCount === 0) {
            this._setLoaded({ index: null, chunkIds: [], dimension: 0, generation, manifest: current });
            this.loadLatencyMs = Date.now() - started;
            return { ok: true, stats: this.stats({ ensure: false }) };
        }
        const indexPath = this._generationPath(generation);
        if (!fs.existsSync(indexPath)) return { ok: false, code: "FAISS_INDEX_LOAD_FAILED" };
        try {
            if (checksumFile(indexPath) !== current.indexChecksum) {
                return { ok: false, code: "FAISS_CHECKSUM_MISMATCH" };
            }
            const IndexFlatIP = resolveIndexClass(this.faissModule ? loadFaissModule(this.faissModule) : loadFaissModule());
            if (typeof IndexFlatIP.read !== "function") throw createFaissError("FAISS_INDEX_LOAD_FAILED");
            const index = IndexFlatIP.read(indexPath);
            if (indexCount(index) !== current.chunkCount || indexDimension(index) !== current.dimension) {
                return { ok: false, code: "FAISS_MAPPING_MISMATCH" };
            }
            this._setLoaded({
                index,
                chunkIds: current.chunkIds,
                dimension: current.dimension,
                generation,
                manifest: current,
            });
            this.loadLatencyMs = Date.now() - started;
            return { ok: true, stats: this.stats({ ensure: false }) };
        } catch (error) {
            return { ok: false, code: safeFaissErrorCode(error, "FAISS_INDEX_LOAD_FAILED") };
        }
    }

    *_readEmbeddedPages() {
        const reader = this.store.getEmbeddedActiveChunks || getEmbeddedActiveChunks;
        let afterId = null;
        let expectedDimension = null;
        while (true) {
            const page = reader(this.scope, this.projectId, { afterId, limit: this.pageSize }) || [];
            if (!Array.isArray(page) || page.length === 0) break;
            let lastId = afterId;
            for (const row of page) {
                const id = Number(row?.id);
                if (!isSafeChunkId(id)) continue;
                if (lastId == null || id > lastId) lastId = id;
                const level = row?.chunk_level ?? row?.chunkLevel ?? "leaf";
                if (Number(row?.stale || 0) !== 0 || String(level) !== "leaf") continue;
                const embedding = parseEmbedding(row?.embedding);
                let vector;
                try {
                    vector = normalizeFaissVector(embedding, expectedDimension);
                } catch (error) {
                    if (error?.code === "FAISS_DIMENSION_MISMATCH") throw error;
                    vector = null;
                }
                if (!vector) continue;
                expectedDimension ||= vector.length;
                yield { id, vector };
            }
            if (lastId == null || lastId === afterId || page.length < this.pageSize) break;
            afterId = lastId;
        }
    }

    _buildIndexFromSQLite(generation) {
        let index;
        let dimension = 0;
        const chunkIds = [];
        let batch = [];
        try {
            for (const row of this._readEmbeddedPages()) {
                if (!index) {
                    dimension = row.vector.length;
                    const IndexFlatIP = resolveIndexClass(loadFaissModule(this.faissModule));
                    index = new IndexFlatIP(dimension);
                }
                batch.push(row.vector);
                chunkIds.push(row.id);
                if (batch.length >= FAISS_ADD_BATCH_SIZE) {
                    addToIndex(index, batch);
                    batch = [];
                }
            }
            if (index && batch.length > 0) addToIndex(index, batch);
        } catch (error) {
            throw createFaissError(safeFaissErrorCode(error, "FAISS_NATIVE_UNAVAILABLE"), error);
        }
        if (!index) return { index: null, chunkIds: [], dimension: 0, generation };
        if (indexCount(index) !== chunkIds.length || indexDimension(index) !== dimension) {
            throw createFaissError("FAISS_MAPPING_MISMATCH");
        }
        return { index, chunkIds, dimension, generation };
    }

    _writePublishedIndex(built) {
        const directory = this._directory();
        fs.mkdirSync(directory, { recursive: true });
        const manifestPath = this._manifestPath();
        const generationPath = this._generationPath(built.generation);
        let indexChecksum = "";
        let tempIndexPath = null;
        try {
            if (built.index) {
                tempIndexPath = makeTempPath(directory, `generation-${built.generation}`, ".faiss.tmp");
                built.index.write(tempIndexPath);
                const IndexFlatIP = resolveIndexClass(loadFaissModule(this.faissModule));
                if (typeof IndexFlatIP.read !== "function") throw createFaissError("FAISS_INDEX_WRITE_FAILED");
                const verification = IndexFlatIP.read(tempIndexPath);
                if (indexCount(verification) !== built.chunkIds.length
                    || indexDimension(verification) !== built.dimension) {
                    throw createFaissError("FAISS_MAPPING_MISMATCH");
                }
                indexChecksum = checksumFile(tempIndexPath);
                publishAtomic(tempIndexPath, generationPath);
                tempIndexPath = null;
            }
            const manifest = {
                schemaVersion: FAISS_SCHEMA_VERSION,
                engine: FAISS_ENGINE,
                metric: FAISS_METRIC,
                scopeHash: this.scopeHash,
                generation: built.generation,
                dimension: built.dimension,
                chunkCount: built.chunkIds.length,
                chunkIds: [...built.chunkIds],
                indexChecksum,
                createdAt: new Date().toISOString(),
            };
            const validated = validateManifest(manifest, { scopeHash: this.scopeHash, generation: built.generation });
            if (!validated.valid) throw createFaissError(validated.code);
            const tempManifestPath = makeTempPath(directory, "current-manifest", ".json.tmp");
            fs.writeFileSync(tempManifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" });
            try {
                publishAtomic(tempManifestPath, manifestPath);
            } finally {
                if (fs.existsSync(tempManifestPath)) fs.rmSync(tempManifestPath, { force: true });
            }
            if (!built.index && fs.existsSync(generationPath)) fs.rmSync(generationPath, { force: true });
            cleanupOldGenerationFiles(directory, built.generation);
            return manifest;
        } catch (error) {
            throw createFaissError(safeFaissErrorCode(error, "FAISS_INDEX_WRITE_FAILED"), error);
        } finally {
            if (tempIndexPath && fs.existsSync(tempIndexPath)) fs.rmSync(tempIndexPath, { force: true });
        }
    }

    /** Build once from SQLite JSON embeddings; no embedding provider is called. */
    buildIndex({ generation = null } = {}) {
        const started = Date.now();
        const targetGeneration = generation == null ? this._readGeneration() : normalizeGeneration(generation);
        try {
            const built = this._buildIndexFromSQLite(targetGeneration);
            const manifest = this._writePublishedIndex(built);
            this._setLoaded({
                index: built.index,
                chunkIds: built.chunkIds,
                dimension: built.dimension,
                generation: targetGeneration,
                manifest,
            });
            this.buildLatencyMs = Date.now() - started;
            this.lastErrorCode = null;
            return this.stats({ ensure: false });
        } catch (error) {
            this.buildLatencyMs = Date.now() - started;
            this.lastErrorCode = safeFaissErrorCode(error, "FAISS_INDEX_BUILD_FAILED");
            throw createFaissError(this.lastErrorCode, error);
        }
    }

    ensureIndex() {
        const generation = this._readGeneration();
        if (this.loaded && this.generation === generation) return this.stats({ ensure: false });
        const loaded = this._loadPersisted(generation);
        if (loaded.ok) return loaded.stats;
        try {
            return this.buildIndex({ generation });
        } catch (error) {
            this.lastErrorCode = safeFaissErrorCode(error, loaded.code || "FAISS_INDEX_BUILD_FAILED");
            throw error;
        }
    }

    invalidate() {
        this.loaded = false;
        this.index = null;
        this.chunkIds = [];
        this.dimension = 0;
        this.generation = -1;
        this.manifest = null;
        return true;
    }

    addVectors() {
        // Durable FAISS is rebuilt from SQLite after the caller commits. This
        // method intentionally does not create a second mutable source of truth.
        return [];
    }

    removeByDocument() {
        return 0;
    }

    clear() {
        this.invalidate();
        return true;
    }

    _hydrate(ids) {
        const reader = this.store.getActiveChunksByIds || getActiveChunksByIds;
        if (typeof reader !== "function") throw createFaissError("FAISS_HYDRATE_UNAVAILABLE");
        try {
            const rows = reader(this.scope, this.projectId, ids) || [];
            const byId = new Map();
            for (const row of rows) {
                const id = Number(row?.id ?? row?.chunkId);
                if (!isSafeChunkId(id)) continue;
                // The SQL method performs these checks; repeat cheap checks at
                // the adapter boundary for custom stores and defense in depth.
                if (Number(row?.owner_user_id ?? row?.ownerUserId) !== this.ownerUserId) continue;
                if (String(row?.tenant_id ?? row?.tenantId) !== this.tenantId) continue;
                if (String(row?.project_id ?? row?.projectId) !== this.projectId) continue;
                if (Number(row?.stale || 0) !== 0) continue;
                if (String(row?.status ?? row?.document_status ?? "active") !== "active") continue;
                if (String(row?.chunk_level ?? row?.chunkLevel ?? "leaf") !== "leaf") continue;
                byId.set(id, row);
            }
            return byId;
        } catch (error) {
            throw createFaissError("FAISS_HYDRATE_FAILED", error);
        }
    }

    similaritySearch(queryVector, k = 5, filter = null) {
        const stats = this.ensureIndex();
        if (!this.index || stats.chunkCount === 0) return [];
        const query = normalizeFaissVector(queryVector, this.dimension);
        if (!query) throw createFaissError("FAISS_QUERY_INVALID");
        const requested = Math.max(1, Number(k) | 0);
        const total = indexCount(this.index);
        const safeMaximum = Math.min(total, Math.max(requested, this.maxCandidateK));
        let candidateK = Math.min(total, Math.max(requested, 8));
        while (true) {
            const { distances, labels } = indexSearch(this.index, query, candidateK);
            const candidateIds = [];
            for (let i = 0; i < labels.length; i += 1) {
                const label = Number(labels[i]);
                if (!Number.isSafeInteger(label) || label < 0 || label >= this.chunkIds.length) continue;
                candidateIds.push(this.chunkIds[label]);
            }
            const rowsById = this._hydrate(candidateIds);
            const hits = [];
            const seen = new Set();
            for (let i = 0; i < candidateIds.length; i += 1) {
                const id = Number(candidateIds[i]);
                if (seen.has(id)) continue;
                const row = rowsById.get(id);
                if (!row) continue;
                const item = metadataFromRow(row, Number(distances[i]) || 0);
                if (filter && typeof filter === "function" && !filter(item)) continue;
                seen.add(id);
                hits.push(item);
            }
            hits.sort((a, b) => Number(b.score) - Number(a.score) || Number(a.chunkId) - Number(b.chunkId));
            if (hits.length >= requested || candidateK >= total) return hits.slice(0, requested);
            if (candidateK >= safeMaximum) throw createFaissError("FAISS_CANDIDATE_LIMIT");
            candidateK = Math.min(total, Math.max(candidateK + 1, candidateK * 2));
        }
    }

    stats({ ensure = true } = {}) {
        if (ensure && !this.loaded) this.ensureIndex();
        return {
            name: this.name,
            projectId: this.projectId,
            scopeHash: this.scopeHash,
            chunkCount: this.chunkIds.length,
            loaded: this.loaded,
            generation: this.generation,
            dimension: this.dimension,
            hasEmbeddings: this.chunkIds.length > 0,
            loadLatencyMs: this.loadLatencyMs,
            buildLatencyMs: this.buildLatencyMs,
            lastErrorCode: this.lastErrorCode,
        };
    }
}

export function getFaissVectorStore({ scope, projectId, store = null, indexRoot = null, root = null, faissModule = null, ...options } = {}) {
    const normalizedRoot = resolveFaissIndexRoot({ indexRoot, root });
    const key = `${normalizedRoot}:${scopeHashFor(scope, projectId)}`;
    const cached = storeCache.get(key);
    if (!cached || (store && cached.store !== store) || (faissModule && cached.faissModule !== faissModule)) {
        storeCache.set(key, new FaissVectorStore({
            scope,
            projectId,
            store,
            indexRoot: normalizedRoot,
            faissModule,
            ...options,
        }));
        pruneCache();
    }
    return storeCache.get(key);
}

export function invalidateFaissStore({ scope, projectId, indexRoot = null, root = null } = {}) {
    const key = `${resolveFaissIndexRoot({ indexRoot, root })}:${scopeHashFor(scope, projectId)}`;
    const cached = storeCache.get(key);
    if (!cached) return false;
    cached.invalidate();
    return true;
}

export function clearFaissStoreCache() {
    storeCache.clear();
}

export default {
    FAISS_SCHEMA_VERSION,
    FAISS_ENGINE,
    FAISS_METRIC,
    normalizeFaissVector,
    scopeHashFor,
    resolveFaissIndexRoot,
    getFaissScopeDirectory,
    getFaissManifestPath,
    getFaissGenerationPath,
    createFaissError,
    safeFaissErrorCode,
    FaissVectorStore,
    getFaissVectorStore,
    invalidateFaissStore,
    clearFaissStoreCache,
};
