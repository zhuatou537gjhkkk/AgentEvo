/**
 * Phase 7 / R4 — file-hash incremental project indexer (roadmap R4 checklist
 * #5).
 *
 * A project snapshot is a list of { path, text } files. Each file's content is
 * hashed (sha256Hex) and compared against the single *active* document row the
 * store keeps per path:
 *   - same hash            → unchanged (no new revision);
 *   - different / absent   → chunked (splitCodeByLines) → chunk rows carry
 *     start/end lines, extracted symbols, content hash and token estimate; a
 *     new document revision is inserted and, when a previous active revision
 *     exists, the store marks it + its chunks stale in the same transaction
 *     (DoD: "stale chunk 可检测");
 *   - authoritativeSnapshot → a path absent from the snapshot marks its active
 *     doc stale (file deleted).
 *
 * Embedding is OPTIONAL and additive: if an embedder is supplied, chunk
 * contents are embedded in batches and the vectors are persisted next to the
 * chunk row (the DB is the single source of truth — this indexer never writes
 * the vector adapter directly). If an embedding batch fails, those chunks are
 * still indexed lexical-only and the failure is counted in `embeddingErrors`.
 * After writes the durable adapter cache is invalidated so the next search
 * lazily rebuilds from the same DB (DoD: "索引重启后可用").
 *
 * The store write for each file is individually guarded: a throwing file lands
 * in `errors` and indexing of the remaining files continues.
 */
import { sha256Hex } from "./knowledgeStore.js";
import { splitCodeByLines, extractSymbols } from "./codeChunk.js";
import { classifyError } from "../services/resilience.js";
import { invalidateDurableStore } from "./vectorStoreAdapter.js";
import { getFaissVectorStore, safeFaissErrorCode } from "./faissVectorStore.js";
import { ragFaissEnabled } from "./flags.js";
import {
    getActiveDocumentByPath,
    listActiveDocuments,
    insertDocumentRevision,
    markDocumentStale,
    getActiveChunks,
    fillChunkEmbeddings,
} from "./knowledgeStore.js";

const DEFAULT_STORE = {
    getActiveDocumentByPath,
    listActiveDocuments,
    insertDocumentRevision,
    markDocumentStale,
    getActiveChunks,
    fillChunkEmbeddings,
};

function faissSummary(store) {
    try {
        const stats = typeof store?.stats === "function" ? store.stats({ ensure: false }) : {};
        return {
            status: "ready",
            generation: Number.isSafeInteger(Number(stats?.generation)) ? Number(stats.generation) : null,
            chunkCount: Math.max(0, Number(stats?.chunkCount) || 0),
            buildLatencyMs: Math.max(0, Number(stats?.buildLatencyMs) || 0),
        };
    } catch {
        return { status: "ready", generation: null, chunkCount: 0, buildLatencyMs: 0 };
    }
}

/** FAISS is derived work: a failure is recorded safely and never fails ingest. */
function maybeBuildFaiss({ scope, projectId, storeRef, vectorStore, summary }) {
    if (!ragFaissEnabled() && !vectorStore) return;
    const faissStore = vectorStore?.name === "faiss"
        ? vectorStore
        : getFaissVectorStore({ scope, projectId, store: storeRef });
    if (typeof faissStore?.ensureIndex !== "function" && typeof faissStore?.buildIndex !== "function") return;
    try {
        if (typeof faissStore.ensureIndex === "function") faissStore.ensureIndex();
        else faissStore.buildIndex();
        summary.faiss = faissSummary(faissStore);
    } catch (error) {
        summary.faiss = {
            status: "fallback",
            fallbackCode: safeFaissErrorCode(error),
        };
    }
}

function pathBasename(filePath) {
    const parts = String(filePath ?? "").split(/[\\/]+/);
    return parts[parts.length - 1] || "";
}

function dedupeFiles(files) {
    const byPath = new Map();
    for (const f of files || []) {
        if (!f || f.path == null) continue;
        byPath.set(String(f.path), f);
    }
    return [...byPath.values()];
}

function makeChunkRows(chunks) {
    return chunks.map((chunk, index) => {
        const content = String(chunk.content ?? "");
        const symbols = extractSymbols(content);
        return {
            chunkIndex: index,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content,
            contentHash: sha256Hex(content),
            symbols: symbols.join(" "),
            tokenCount: content.length > 0 ? Math.max(1, Math.ceil(content.length / 4)) : 0,
            embedding: null,
        };
    });
}

/**
 * Diff a snapshot of files against the store's active documents.
 * Pure-ish synchronous planner, exported for tests.
 * @param {object} args { scope, projectId, files, store? }
 * @returns {{unchanged:{path:string,fileHash:string}[],
 *   toIndex:{path:string,text:string,fileHash:string,activeDoc?:object}[],
 *   deletedActive:object[]}} deletedActive = active doc rows whose path is
 *   absent from the snapshot (caller decides whether to mark stale).
 */
export function planFileChanges({ scope, projectId, files, store = null } = {}) {
    const storeRef = store || DEFAULT_STORE;
    const snapshot = new Map();
    for (const f of dedupeFiles(files)) {
        snapshot.set(String(f.path), { path: String(f.path), text: f.text });
    }
    const activeByPath = new Map();
    const activeDocs = storeRef.listActiveDocuments(scope, projectId, { limit: 100000 }) || [];
    for (const doc of activeDocs) {
        const existing = activeByPath.get(doc.file_path);
        if (!existing || Number(doc.revision) > Number(existing.revision)) {
            activeByPath.set(doc.file_path, doc);
        }
    }

    const unchanged = [];
    const toIndex = [];
    for (const [path, file] of snapshot) {
        const fileHash = sha256Hex(file.text);
        const activeDoc = activeByPath.get(path);
        if (activeDoc && String(activeDoc.file_hash) === fileHash) {
            unchanged.push({ path, fileHash });
            continue;
        }
        toIndex.push({ path, text: file.text, fileHash, activeDoc: activeDoc || null });
    }
    const deletedActive = [];
    for (const [path, doc] of activeByPath) {
        if (!snapshot.has(path)) deletedActive.push(doc);
    }
    // deterministic ordering for repeatable plans
    unchanged.sort((a, b) => a.path.localeCompare(b.path));
    toIndex.sort((a, b) => a.path.localeCompare(b.path));
    deletedActive.sort((a, b) => String(a.file_path).localeCompare(String(b.file_path)));
    return { unchanged, toIndex, deletedActive };
}

/**
 * Index a project file snapshot.
 * @param {object} args { scope, projectId, files, sourceRunId?, sourceCommit?,
 *   store?, embedder?, vectorStore?, opts? }
 *   opts: { authoritativeSnapshot = false, reportOnly = false,
 *   batchEmbedSize = 25 }.
 * @returns {{scanned:number, unchanged:number, indexed:number, updated:number,
 *   deleted:number, chunkCount:number, embeddingErrors:number,
 *   errors:{path:string,errorCode:string,message:string}[]}}
 */
export async function indexProjectSnapshot({ scope, projectId, files, sourceRunId = null, sourceCommit = null, store = null, embedder = null, vectorStore = null, opts = {} } = {}) {
    const storeRef = store || DEFAULT_STORE;
    const o = opts || {};
    const authoritative = Boolean(o.authoritativeSnapshot);
    const reportOnly = Boolean(o.reportOnly);
    const batchSize = Math.max(1, Number(o.batchEmbedSize) || 25);

    const plan = planFileChanges({ scope, projectId, files, store: storeRef });
    const summary = {
        scanned: dedupeFiles(files).length,
        unchanged: plan.unchanged.length,
        indexed: 0,
        updated: 0,
        deleted: 0,
        chunkCount: 0,
        embeddingErrors: 0,
        errors: [],
        faiss: { status: "disabled" },
    };

    if (reportOnly) {
        for (const entry of plan.toIndex) {
            if (entry.activeDoc) summary.updated += 1;
            else summary.indexed += 1;
        }
        return summary;
    }

    for (const entry of plan.toIndex) {
        const { path, text, fileHash, activeDoc } = entry;
        try {
            const chunkRows = makeChunkRows(splitCodeByLines(text));
            if (embedder && typeof embedder.embed === "function") {
                for (let start = 0; start < chunkRows.length; start += batchSize) {
                    const batch = chunkRows.slice(start, start + batchSize);
                    const texts = batch.map((c) => c.content);
                    try {
                        const vectors = await embedder.embed(texts);
                        if (!Array.isArray(vectors)) {
                            throw new Error("embedder returned non-array");
                        }
                        batch.forEach((c, index) => {
                            const v = vectors[index];
                            if (Array.isArray(v) && v.length > 0) c.embedding = v;
                        });
                    } catch (err) {
                        // lexical-only still usable for this batch
                        summary.embeddingErrors += batch.length;
                    }
                }
            }
            const inserted = storeRef.insertDocumentRevision({
                scope,
                projectId,
                filePath: path,
                fileName: pathBasename(path),
                docType: "project_file",
                fileHash,
                sizeBytes: Buffer.byteLength(String(text ?? ""), "utf8"),
                sourceRunId,
                sourceCommit,
                meta: {},
                chunks: chunkRows,
                previous: activeDoc || null,
            });
            if (activeDoc) summary.updated += 1;
            else summary.indexed += 1;
            summary.chunkCount += inserted.chunkCount;
        } catch (err) {
            const classified = classifyError(err);
            summary.errors.push({
                path,
                errorCode: classified.code || "INDEX_ERROR",
                message: String(err?.message || err || "index error").slice(0, 300),
            });
        }
    }

    let deletedCount = 0;
    if (authoritative) {
        for (const doc of plan.deletedActive) {
            try {
                if (storeRef.markDocumentStale(scope, doc.id, { reason: "file-absent-in-snapshot" })) {
                    deletedCount += 1;
                }
            } catch (err) {
                summary.errors.push({
                    path: doc.file_path,
                    errorCode: classifyError(err).code || "STALE_ERROR",
                    message: String(err?.message || "markDocumentStale failed").slice(0, 300),
                });
            }
        }
    }
    summary.deleted = deletedCount;

    if (summary.indexed + summary.updated + summary.deleted > 0 || plan.toIndex.length > 0) {
        invalidateDurableStore({ scope, projectId });
    }
    maybeBuildFaiss({ scope, projectId, storeRef, vectorStore, summary });
    return summary;
}

/**
 * Offline / rollback-adjacent path: re-embed all ACTIVE chunks from the DB
 * regardless of current embeddings. Requires an embedder.
 * @returns {{requiresEmbedder:boolean, embedded:number, total:number,
 *   errors:{chunkId:number,errorCode:string,message:string}[]}}
 */
export async function rebuildProjectIndex({ scope, projectId, store = null, embedder = null, vectorStore = null, opts = {} } = {}) {
    const storeRef = store || DEFAULT_STORE;
    const batchSize = Math.max(1, Number(opts?.batchEmbedSize) || 25);
    const rows = storeRef.getActiveChunks(scope, projectId, { limit: 100000 }) || [];
    const total = rows.length;
    if (!embedder || typeof embedder.embed !== "function") {
        return { requiresEmbedder: true, embedded: 0, total, errors: [] };
    }
    const errors = [];
    const rowsWithEmbedding = [];
    for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize);
        const texts = batch.map((r) => String(r.content ?? ""));
        try {
            const vectors = await embedder.embed(texts);
            batch.forEach((r, index) => {
                const v = vectors[index];
                if (Array.isArray(v) && v.length > 0 && r.id != null) {
                    rowsWithEmbedding.push({ id: r.id, embedding: v });
                }
            });
        } catch (err) {
            const classified = classifyError(err);
            for (const r of batch) {
                errors.push({ chunkId: r.id, errorCode: classified.code || "EMBED_ERROR", message: String(err?.message || "embed failed").slice(0, 300) });
            }
        }
    }
    let embedded = 0;
    if (rowsWithEmbedding.length > 0) {
        embedded = storeRef.fillChunkEmbeddings(scope, rowsWithEmbedding) || 0;
        invalidateDurableStore({ scope, projectId });
    }
    const summary = { requiresEmbedder: false, embedded, total, errors };
    maybeBuildFaiss({ scope, projectId, storeRef, vectorStore, summary });
    return summary;
}

export default { planFileChanges, indexProjectSnapshot, rebuildProjectIndex };
