/**
 * Phase 7 / R4 — durable dual-write / dual-read canary orchestration
 * (roadmap R4 checklist #9).
 *
 * This module is the pure orchestration layer that sits on TOP of the durable
 * knowledge store for ordinary uploaded documents. It is a service: no HTTP,
 * no agent-graph edits, no routing decisions.
 *
 * Core ideas:
 *   - A pseudo-project `UPLOAD_DOC_PROJECT = "__uploads__"` namespaces every
 *     uploaded-document durable row. file_path is the sanitized file name,
 *     doc_type = 'upload'. Scope is (owner_user_id, tenant_id, UPLOAD_DOC_PROJECT).
 *   - `maybeDualWriteUpload` is the durable half of a dual write: the legacy
 *     /upload path already indexes into the in-memory faiss adapter; when the
 *     RAG_DURABLE_ENABLED flag is on, this function mirrors the same document
 *     into the durable DB (file-hash incremental revisions). Off → no work.
 *   - `dualReadUpload` compares the legacy memory reader against the durable
 *     reader. While the DURABLE_RAG_READ canary is OFF the legacy memory side
 *     still serves (rollback semantics); flipping the canary ON serves durable
 *     reads, and any durable miss/empty/error falls back to memory with a
 *     `note: 'canary-fallback'` (canary rollback = unset the env var).
 *   - Every side of a dual read records one owner-scoped telemetry row; when
 *     the canary is on, the served choice is recorded too (mode 'canary').
 *
 * Default-off safety: every read of a flag is at call time (never import time).
 * With the flags unset nothing is written, nothing is read from durable, and no
 * telemetry is produced — behaviour is byte-for-byte identical to legacy.
 *
 * The durable *reader* itself lives in the sibling module `retrieval.js`
 * (retrieveProjectCode / rebuildProjectIndex) which is loaded lazily via
 * dynamic import so this module never hard-requires it at import time — it may
 * not exist yet while the retrieval-agent (RA) work is still landing. The
 * legacy faiss memory reader (rag/index.js) is likewise imported lazily.
 */
import * as kstore from "./knowledgeStore.js";
import { durableRagEnabled, durableRagReadCanary } from "./flags.js";
import { recordKnowledgeQuery } from "./telemetry.js";
import { invalidateDurableStore } from "./vectorStoreAdapter.js";

/** Pseudo-project that scopes ALL durable rows for ordinary uploaded documents. */
export const UPLOAD_DOC_PROJECT = "__uploads__";

const MAX_CHUNK_EMBED_BATCH = 25;
const MAX_FILE_NAME_LENGTH = 200;
const DOC_FILE_TYPE = "upload";

// ────────────────────────── tiny flag-facing utils ──────────────────────────

/** Thin alias so upload-path callers read one function: durable uploads enabled? */
export function isDurableUploadPathEnabled() {
    return durableRagEnabled();
}

/** Canary snapshot for callers that want to branch without re-reading flags. */
export function canaryChoice() {
    return { enabled: durableRagEnabled(), readDurable: durableRagReadCanary() };
}

// ────────────────────────── file-name sanitization ──────────────────────────

/**
 * Reduce an uploaded file name to a safe, deterministic durable file_path:
 *   - basename across '/' and '\\' (strips ../, ..\, directory prefixes),
 *   - removes control characters,
 *   - lowercases the extension (stem case is preserved),
 *   - capped at MAX_FILE_NAME_LENGTH.
 * Empty / all-dots / over-long results fall back to `doc-<sha256 first 12>`.
 */
export function sanitizeDocFileName(name) {
    const raw = String(name ?? "");
    const segments = raw.split(/[\\/]+/);
    let base = segments[segments.length - 1] ?? "";
    // Strip control chars and trim (Windows also forbids trailing dots/spaces).
    base = Array.from(base).filter((ch) => { const cp = ch.codePointAt(0); return cp >= 0x20 && cp !== 0x7f; }).join("").trim().replace(/[. ]+$/, "");
    // Lowercase the extension, keep the stem as authored.
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
        base = base.slice(0, dot) + base.slice(dot).toLowerCase();
    }
    const fallback = () => `doc-${kstore.sha256Hex(raw).slice(0, 12)}`;
    if (!base || /^\.+$/.test(base)) return fallback();
    if (base.length > MAX_FILE_NAME_LENGTH) return fallback();
    return base;
}

// ────────────────────────── deterministic chunker ──────────────────────────

/**
 * Build the breakpoint index used to pick cut points. `pos` is the index just
 * after a run of newlines (so the newlines stay at the end of the previous
 * chunk); runs of two or more newlines mark a *paragraph* break.
 */
function buildBreakpoints(text) {
    const points = [];
    const re = /\n+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        points.push({ pos: m.index + m[0].length, para: m[0].length >= 2 });
    }
    return points;
}

/**
 * Deterministic offline chunker: paragraph + newline hybrid (no LangChain, no
 * network, no randomness). Splits on paragraph breaks (`\n\n+`) preferring the
 * break closest to `maxChars`, else on a single newline, else a hard slice.
 * Consecutive chunks overlap by ~`overlapChars` characters (exactly, whenever a
 * chunk is longer than the overlap) so a concept straddling a cut is retained.
 *
 * @param {string} text document text
 * @param {object} [opts]
 * @param {number} [opts.maxChars=600] hard ceiling per chunk
 * @param {number} [opts.overlapChars=120] re-carry between neighbours
 * @returns {{content: string}[]}
 */
export function splitDocChunks(text, { maxChars = 600, overlapChars = 120 } = {}) {
    const source = String(text ?? "");
    const length = source.length;
    if (length === 0) return [];
    const mChars = Math.max(1, Math.floor(Number(maxChars) || 600));
    let oChars = Math.floor(Number(overlapChars) || 0);
    oChars = Math.max(0, Math.min(oChars, mChars - 1));
    const breaks = buildBreakpoints(source);
    const chunks = [];
    let start = 0;
    while (start < length) {
        // Once the remaining text fits in a single chunk, take it all — never
        // leave a sliver behind (avoids degenerate repeated cuts on a tail that
        // contains one far paragraph break).
        if (length - start <= mChars) {
            chunks.push({ content: source.slice(start) });
            break;
        }
        const windowEnd = start + mChars; // < length here
        // Pick the last paragraph break in (start, windowEnd]; fall back to the
        // last newline break; else hard slice at windowEnd.
        let bestPara = -1;
        let bestAny = -1;
        for (let i = 0; i < breaks.length; i += 1) {
            const p = breaks[i];
            if (p.pos <= start) continue;
            if (p.pos > windowEnd) break;
            bestAny = p.pos;
            if (p.para) bestPara = p.pos;
        }
        let cut = windowEnd;
        if (bestPara !== -1) cut = bestPara;
        else if (bestAny !== -1) cut = bestAny;
        if (cut <= start) cut = windowEnd; // safety: guarantee forward progress
        chunks.push({ content: source.slice(start, cut) });
        // Overlap re-covers the tail of the chunk just emitted.
        start = Math.max(cut - oChars, start + 1);
    }
    return chunks;
}

// ────────────────────────── embedder plumbing ──────────────────────────

/**
 * Invoke an injectable embedder over a batch of strings. Accepts a callable
 * `(texts) => vectors`, a LangChain-style `embedDocuments(texts)`, or the RA
 * sibling seam `embed(texts)` (embedder.js). Never throws.
 */
async function runEmbedder(embedder, texts) {
    if (typeof embedder === "function") return embedder(texts);
    if (embedder && typeof embedder.embedDocuments === "function") {
        return embedder.embedDocuments(texts);
    }
    if (embedder && typeof embedder.embed === "function") {
        return embedder.embed(texts);
    }
    const err = new Error("embedder must expose embedDocuments(texts), embed(texts), or be callable");
    err.code = "EMBEDDER_UNSUPPORTED";
    throw err;
}

/**
 * Embed a list of chunk texts in ≤25 batches. Per-batch failures never abort
 * the caller: failed chunks keep a null vector (durable lexical retrieval
 * still works) and are counted in `errors`.
 * @returns {{ vectors: (number[]|null)[], errors: number }}
 */
async function embedChunkTextsInBatches(embedder, texts, { batchSize = MAX_CHUNK_EMBED_BATCH } = {}) {
    const vectors = new Array(texts.length).fill(null);
    let errors = 0;
    if (!embedder) return { vectors, errors };
    const batchSizeClamped = Math.max(1, Number(batchSize) | 0) || MAX_CHUNK_EMBED_BATCH;
    for (let i = 0; i < texts.length; i += batchSizeClamped) {
        const batch = texts.slice(i, i + batchSizeClamped);
        let result;
        try {
            result = await runEmbedder(embedder, batch);
        } catch {
            errors += batch.length;
            continue;
        }
        if (!Array.isArray(result)) {
            errors += batch.length;
            continue;
        }
        for (let j = 0; j < batch.length; j += 1) {
            const v = result[j];
            if (Array.isArray(v) && v.length > 0 && v.every((n) => Number.isFinite(Number(n)))) {
                vectors[i + j] = v.map(Number);
            } else {
                errors += 1;
            }
        }
    }
    return { vectors, errors };
}

// ────────────────────────── dual-write (durable half) ──────────────────────────

function resolveScope(scope, userId) {
    if (scope == null && userId != null) return Number(userId);
    return scope;
}

/**
 * Durable half of the upload dual write. With the flag off this is a no-op
 * returning `{ written: false, reason: 'disabled' }` BEFORE any scope/DB work,
 * so legacy behaviour is never changed.
 *
 * @param {object} args
 * @param {*} args.scope owner scope (number userId or { userId, tenantId })
 * @param {string} args.text decoded document text
 * @param {string} args.fileName original uploaded file name (sanitized here)
 * @param {number} [args.userId] fallback owner when scope is not passed
 * @param {string} [args.fileHash] content hash override (else sha256 of text)
 * @param {*} [args.embedder] embedder (function or { embedDocuments })
 * @param {object} [args.deps] { store?, invalidate? } injection points
 * @returns {Promise<object>}
 */
export async function maybeDualWriteUpload({
    scope, text, fileName, userId = null, fileHash = null,
    embedder = null, deps = {}, sourceSessionId = null, meta = {},
} = {}) {
    if (!durableRagEnabled()) return { written: false, reason: "disabled" };

    const effectiveScope = resolveScope(scope, userId);
    kstore.normalizeKnowledgeScope(effectiveScope); // fail fast w/ typed error
    const store = deps.store ?? kstore;

    const normalizedText = String(text ?? "");
    if (!normalizedText.trim()) {
        const err = new Error("durable upload requires non-empty document text");
        err.code = "DURABLE_UPLOAD_EMPTY";
        throw err;
    }
    const filePath = sanitizeDocFileName(fileName);
    const hash = fileHash || kstore.sha256Hex(normalizedText);
    const previous = store.getActiveDocumentByPath(effectiveScope, UPLOAD_DOC_PROJECT, filePath);
    if (previous && String(previous.file_hash) === String(hash)) {
        return {
            written: false,
            reason: "unchanged",
            documentId: previous.id,
            revision: previous.revision,
            chunkCount: store.getActiveChunks(effectiveScope, UPLOAD_DOC_PROJECT, { filePath }).length,
        };
    }

    const chunks = splitDocChunks(normalizedText).map((c, chunkIndex) => ({
        chunkIndex,
        content: c.content,
        contentHash: kstore.sha256Hex(c.content),
        embedding: null,
        tokenCount: 0,
        meta: {},
    }));

    let embeddingErrors = 0;
    if (embedder) {
        const { vectors, errors } = await embedChunkTextsInBatches(
            embedder,
            chunks.map((c) => c.content),
        );
        embeddingErrors = errors;
        for (let i = 0; i < chunks.length; i += 1) chunks[i].embedding = vectors[i];
    }

    const invalidate = deps.invalidate ?? invalidateDurableStore;
    const inserted = store.insertDocumentRevision({
        scope: effectiveScope,
        projectId: UPLOAD_DOC_PROJECT,
        filePath,
        fileName: filePath,
        docType: DOC_FILE_TYPE,
        fileHash: hash,
        sizeBytes: Buffer.byteLength(normalizedText, "utf8"),
        sourceSessionId,
        meta,
        chunks,
        previous,
    });
    try {
        invalidate({ scope: effectiveScope, projectId: UPLOAD_DOC_PROJECT });
    } catch {
        // Cache invalidation is best-effort; the durable rows are already committed.
    }
    return {
        written: true,
        reason: previous ? "updated" : "indexed",
        documentId: inserted.documentId,
        revision: inserted.revision,
        chunkCount: inserted.chunkCount,
        embeddingErrors,
    };
}

// ────────────────────────── dual-read ──────────────────────────

/** Default legacy-memory reader: the in-memory faiss facade, imported lazily. */
async function defaultMemoryReader(query, opts) {
    const mod = await import("./index.js");
    if (typeof mod.retrieveKnowledgeEvidence !== "function") {
        return { status: "empty", items: [] };
    }
    return mod.retrieveKnowledgeEvidence(query, opts);
}

let retrievalProbe = null; // { module } | 'missing' — cached across calls

/** Load retrieval.js lazily; returns null (durable absent) when not available. */
async function loadRetrievalModule() {
    if (retrievalProbe !== null) {
        return retrievalProbe === "missing" ? null : retrievalProbe.module;
    }
    try {
        const mod = await import("./retrieval.js");
        if (typeof mod.retrieveProjectCode !== "function") {
            retrievalProbe = "missing";
            return null;
        }
        retrievalProbe = { module: mod };
        return mod;
    } catch {
        // File not present yet (RA still landing) or not importable → durable absent.
        retrievalProbe = "missing";
        return null;
    }
}

/**
 * Default durable reader: retrieval.retrieveProjectCode scoped to the upload
 * pseudo-project, loaded lazily. retrieval.js is the shared retrieval service
 * (roadmap R4 #6/#7): it reads `deps.{ store, embedder, vectorStore }`, records
 * its own fused-read telemetry, and never throws (returns `status:'error'`).
 * Missing retrieval.js → caller sees durable `empty_store`.
 */
async function defaultDurableReader({ scope, projectId, query, deps, opts }) {
    const mod = await loadRetrievalModule();
    if (!mod) return { status: "empty_store", items: [] };
    const o = opts || {};
    const retrievalOpts = { ...o };
    const embedder = o.embedder ?? null;
    const vectorStore = o.vectorStore ?? null;
    delete retrievalOpts.embedder;
    delete retrievalOpts.vectorStore;
    return mod.retrieveProjectCode({
        scope,
        projectId,
        query,
        deps: { store: deps?.store ?? null, embedder, vectorStore },
        opts: retrievalOpts,
    });
}

function normalizeMemoryResult(raw) {
    const items = Array.isArray(raw?.items) ? raw.items : [];
    let status = raw?.status;
    if (status !== "ok" && status !== "no_match" && status !== "empty") status = "error";
    const emptyStore = status === "empty";
    if (status === "empty") status = "no_match"; // empty store ≡ no usable match
    return { status, emptyStore, itemsCount: items.length, items };
}

function normalizeDurableResult(raw) {
    if (!raw || typeof raw !== "object") {
        return { status: "empty_store", emptyStore: true, itemsCount: 0, items: [], text: null, metrics: null };
    }
    const items = Array.isArray(raw.items) ? raw.items : [];
    let status = ["ok", "no_match", "error", "empty_store"].includes(raw.status) ? raw.status : "error";
    if (status === "ok" && items.length === 0) status = "no_match"; // defensive
    return {
        status,
        emptyStore: status === "empty_store",
        itemsCount: items.length,
        items,
        errorCode: raw.errorCode ?? null,
        text: typeof raw.text === "string" ? raw.text : null,
        metrics: raw.metrics && typeof raw.metrics === "object" ? raw.metrics : null,
    };
}

function telemetryStatusFor(status) {
    if (status === "ok") return "hit";
    if (status === "error") return "error";
    return "no_match";
}

function synthesizeCitationText(items) {
    if (!items || items.length === 0) return null;
    return items
        .map((item, index) => {
            const source = item.source ?? item.filePath ?? item.fileName ?? `chunk-${index + 1}`;
            const content = item.content ?? "";
            return `[${index + 1}] ${source}:\n${content}`;
        })
        .join("\n\n");
}

/**
 * Dual-read compare for uploaded documents.
 *
 * With RAG_DURABLE_ENABLED off this behaves exactly like the legacy single
 * memory read: no durable attempt, no telemetry, `servedBy: 'memory'`.
 * When on, BOTH sides run and every side records one telemetry row
 * (mode 'dual-read'); with the DURABLE_RAG_READ canary on, the served choice
 * additionally records a mode 'canary' row and durable hits serve while durable
 * misses/empties/errors roll back to memory with `note: 'canary-fallback'`.
 *
 * @param {object} args
 * @param {*} args.scope owner scope (number userId or { userId, tenantId })
 * @param {string} args.query user query
 * @param {*} [args.embedder] optional query embedder forwarded to durable side
 * @param {object} [args.opts] retrieval/legacy options (topK, returnK, ...)
 * @param {object} [args.deps] { memoryReader?, durableReader?, store? }
 * @returns {Promise<object>}
 */
export async function dualReadUpload({
    scope, query, embedder = null, opts = {}, deps = {},
} = {}) {
    const enabled = durableRagEnabled();
    const { ownerUserId } = kstore.normalizeKnowledgeScope(scope);
    const readCanary = durableRagReadCanary();

    const memoryReader = deps.memoryReader ?? defaultMemoryReader;
    const memoryOpts = { ...opts };
    delete memoryOpts.embedder;
    memoryOpts.userId = ownerUserId; // legacy reader keys on userId only

    const runMemory = async () => {
        const t0 = Date.now();
        try {
            const raw = await memoryReader(query, memoryOpts);
            return { ...normalizeMemoryResult(raw), latencyMs: Date.now() - t0 };
        } catch (err) {
            return {
                status: "error", emptyStore: false, itemsCount: 0, items: [],
                latencyMs: Date.now() - t0, errorCode: err?.code ?? "MEMORY_READ_ERROR",
            };
        }
    };

    if (!enabled) {
        const memory = await runMemory();
        return {
            servedBy: "memory",
            canary: false,
            enabled: false,
            note: null,
            memory: {
                status: memory.status,
                itemsCount: memory.itemsCount,
                emptyStore: Boolean(memory.emptyStore),
                latencyMs: memory.latencyMs,
            },
            durable: null,
            agree: null,
            items: memory.items,
            text: null,
            metrics: { mode: "memory", servedBy: "memory", latencyMs: memory.latencyMs },
        };
    }

    const runDurable = async () => {
        const t0 = Date.now();
        const reader = deps.durableReader ?? defaultDurableReader;
        try {
            const raw = await reader({
                scope,
                projectId: UPLOAD_DOC_PROJECT,
                query,
                deps,
                opts: { embedder, ...opts },
            });
            return { ...normalizeDurableResult(raw), latencyMs: Date.now() - t0 };
        } catch (err) {
            return {
                status: "error", emptyStore: false, itemsCount: 0, items: [], text: null, metrics: null,
                latencyMs: Date.now() - t0, errorCode: err?.code ?? "DURABLE_READ_ERROR",
            };
        }
    };

    const [memory, durable] = await Promise.all([runMemory(), runDurable()]);

    // Always record one owner-scoped telemetry row per side while enabled.
    recordKnowledgeQuery({
        scope, projectId: UPLOAD_DOC_PROJECT, mode: "dual-read",
        status: telemetryStatusFor(memory.status), source: "memory",
        items: memory.itemsCount, latencyMs: memory.latencyMs, query,
    });
    recordKnowledgeQuery({
        scope, projectId: UPLOAD_DOC_PROJECT, mode: "dual-read",
        status: telemetryStatusFor(durable.status), source: "durable",
        items: durable.itemsCount, latencyMs: durable.latencyMs, query,
    });

    const memoryHasItems = memory.itemsCount > 0;
    const durableHasItems = durable.itemsCount > 0;
    const serveDurable = readCanary && durableHasItems;
    const servedBy = serveDurable ? "durable" : "memory";
    const note = readCanary && !durableHasItems && servedBy === "memory" ? "canary-fallback" : null;

    if (readCanary) {
        const servedHasItems = servedBy === "durable" ? durableHasItems : memoryHasItems;
        recordKnowledgeQuery({
            scope, projectId: UPLOAD_DOC_PROJECT, mode: "canary",
            status: servedHasItems ? "hit" : "no_match",
            source: servedBy, items: servedBy === "durable" ? durable.itemsCount : memory.itemsCount,
            latencyMs: servedBy === "durable" ? durable.latencyMs : memory.latencyMs,
            query,
        });
    }

    const servedItems = servedBy === "durable" ? durable.items : memory.items;
    const text = servedBy === "durable"
        ? (durable.text ?? synthesizeCitationText(durable.items))
        : null;
    const metrics = servedBy === "durable" ? durable.metrics : null;

    return {
        servedBy,
        canary: readCanary,
        enabled: true,
        note,
        memory: {
            status: memory.status,
            itemsCount: memory.itemsCount,
            emptyStore: Boolean(memory.emptyStore),
            latencyMs: memory.latencyMs,
        },
        durable: {
            status: durable.status,
            itemsCount: durable.itemsCount,
            emptyStore: Boolean(durable.emptyStore),
            errorCode: durable.errorCode ?? null,
            latencyMs: durable.latencyMs,
        },
        agree: memoryHasItems === durableHasItems,
        items: servedItems,
        text,
        metrics,
    };
}

// ────────────────────────── rebuild / rollback ──────────────────────────

/**
 * Rebuild the durable embedding index for the upload pseudo-project (rollback /
 * recovery path): re-embed every ACTIVE chunk already stored by an earlier
 * offline ingest (embedding NULL) and persist the vectors back through the
 * knowledge store, then invalidate the in-memory vector cache.
 *
 * Requires an embedder exposing `embed(texts)` — otherwise it is a read-only
 * no-op summary (`{ requiresEmbedder: true }`).
 *
 * Prefers reusing the sibling indexer.rebuildProjectIndex (roadmap R4 #5)
 * scoped to UPLOAD_DOC_PROJECT — no duplicated logic. (The contract pointed at
 * retrieval.js, but the export actually landed in indexer.js.) The local
 * implementation below is the fallback for when that sibling has not landed.
 *
 * @param {object} args
 * @param {*} args.scope owner scope (number userId or { userId, tenantId })
 * @param {*} [args.embedder] embedder exposing embed(texts)
 * @param {object} [args.opts] { batchSize? | batchEmbedSize? }
 * @returns {Promise<object>}
 */
export async function rebuildUploadProject({ scope, embedder = null, opts = {} } = {}) {
    const indexer = await loadIndexerModule();
    if (indexer && typeof indexer.rebuildProjectIndex === "function") {
        const result = await indexer.rebuildProjectIndex({
            scope,
            projectId: UPLOAD_DOC_PROJECT,
            embedder,
            opts,
        });
        return {
            requiresEmbedder: Boolean(result?.requiresEmbedder),
            embedded: Number(result?.embedded || 0),
            total: Number(result?.total || 0),
            embeddingErrors: Array.isArray(result?.errors) ? result.errors.length : Number(result?.embeddingErrors || 0),
            errors: result?.errors ?? null,
        };
    }
    return rebuildUploadProjectLocal({ scope, embedder, opts });
}

/** Dynamic-load indexer.js (RA sibling); returns null when it has not landed. */
async function loadIndexerModule() {
    try {
        const mod = await import("./indexer.js");
        if (typeof mod.rebuildProjectIndex === "function") return mod;
        return null;
    } catch {
        return null;
    }
}

/** Fallback local re-embed (only used before indexer.js lands). */
async function rebuildUploadProjectLocal({ scope, embedder = null, opts = {} } = {}) {
    const store = kstore;
    const active = store.getActiveChunks(scope, UPLOAD_DOC_PROJECT, { limit: 100000 });
    const total = active.length;
    if (!embedder) {
        return { requiresEmbedder: true, embedded: 0, total, embeddingErrors: 0 };
    }
    if (total === 0) {
        // Nothing to embed; still invalidate to drop any stale in-memory index.
        try { invalidateDurableStore({ scope, projectId: UPLOAD_DOC_PROJECT }); } catch { /* best-effort */ }
        return { requiresEmbedder: false, embedded: 0, total: 0, embeddingErrors: 0 };
    }

    const batchSize = Math.max(1, Number(opts.batchSize) | 0) || MAX_CHUNK_EMBED_BATCH;
    let embedded = 0;
    let embeddingErrors = 0;
    for (let i = 0; i < active.length; i += batchSize) {
        const batch = active.slice(i, i + batchSize);
        let vectors;
        try {
            vectors = await embedChunkTextsInBatches(
                embedder,
                batch.map((row) => String(row.content ?? "")),
                { batchSize },
            );
        } catch {
            embeddingErrors += batch.length;
            continue;
        }
        embeddingErrors += vectors.errors;
        const withEmbedding = [];
        for (let j = 0; j < batch.length; j += 1) {
            const v = vectors.vectors[j];
            if (Array.isArray(v) && v.length > 0) {
                withEmbedding.push({ id: batch[j].id, embedding: v });
            }
        }
        if (withEmbedding.length > 0) {
            embedded += store.fillChunkEmbeddings(scope, withEmbedding);
        }
    }
    try { invalidateDurableStore({ scope, projectId: UPLOAD_DOC_PROJECT }); } catch { /* best-effort */ }
    return { requiresEmbedder: false, embedded, total, embeddingErrors };
}

export default {
    UPLOAD_DOC_PROJECT,
    sanitizeDocFileName,
    isDurableUploadPathEnabled,
    canaryChoice,
    splitDocChunks,
    maybeDualWriteUpload,
    dualReadUpload,
    rebuildUploadProject,
};
