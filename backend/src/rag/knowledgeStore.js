/**
 * Phase 7 / R4 — durable knowledge store (better-sqlite3, sync).
 *
 * Rows live in the additive owner/tenant/project-scoped tables created by
 * `db.initDB()` (knowledge_documents / knowledge_chunks). The store is the only
 * writer for those tables: it performs whole-document revision replacement and
 * staleness in single transactions so a crash never leaves a half-updated
 * document. Scope is server-authenticated only — every statement filters by
 * `owner_user_id AND tenant_id`, so cross-user/cross-tenant reads always return
 * empty.
 *
 * Design notes (roadmap R4 #4/#5):
 *   - file-hash incremental index: a file's path has exactly one *active*
 *     document row (the newest revision whose content hash matched at ingest).
 *     When a file changes, the caller passes the previous active row; this store
 *     marks it stale and inserts a new revision (old chunks keep text/vectors
 *     for forensic rebuild, `stale=1` hides them from active reads).
 *   - durable vectors: each chunk row stores its embedding as a JSON float
 *     array, so both the linear adapter and the derived FAISS index can be
 *     rebuilt from this same DB after a restart. No embedding provider is
 *     needed for either rebuild.
 *   - chunk rows are denormalized with owner/tenant/project for filter safety.
 *
 * No secret / provider-raw data ever reaches a row; content is bounded by the
 * indexer before it calls in.
 */
import crypto from "node:crypto";
import db, { initDB } from "../db/index.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

export function normalizeKnowledgeScope(scope) {
    let userId = null;
    let tenantId = null;
    if (scope && typeof scope === "object") {
        userId = Number(scope.userId ?? scope.ownerUserId ?? scope.id);
        tenantId = scope.tenantId ? String(scope.tenantId) : null;
    } else {
        userId = Number(scope);
    }
    if (!Number.isInteger(userId) || userId <= 0) {
        const err = new Error("knowledge store requires an authenticated owner scope");
        err.code = "KNOWLEDGE_SCOPE_REQUIRED";
        throw err;
    }
    return { ownerUserId: userId, tenantId: tenantId || `user:${userId}` };
}

export function requireKnowledgeProject(projectId) {
    const p = String(projectId || "").trim();
    if (!p) {
        const err = new Error("knowledge store requires a project_id");
        err.code = "KNOWLEDGE_PROJECT_REQUIRED";
        throw err;
    }
    return p;
}

export function sha256Hex(text) {
    return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

export function newDocumentId() {
    return `kd_${crypto.randomUUID()}`;
}

/**
 * Cross-process cache coherence marker. A missing row is generation zero, so
 * merely reading a new project never writes to the database.
 */
export function getKnowledgeIndexGeneration(scope, projectId) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    return Number(db.prepare(`
        SELECT generation FROM knowledge_index_generations
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ?
    `).get(ownerUserId, tenantId, p)?.generation || 0);
}

function bumpKnowledgeIndexGenerationInTransaction({ ownerUserId, tenantId, projectId }) {
    db.prepare(`
        INSERT INTO knowledge_index_generations
            (owner_user_id, tenant_id, project_id, generation, updated_at)
        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(owner_user_id, tenant_id, project_id)
        DO UPDATE SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    `).run(ownerUserId, tenantId, requireKnowledgeProject(projectId));
}

// ────────────────────────── documents ──────────────────────────

/**
 * Return the active (newest, non-stale) document row for a project file path.
 * @returns {object|undefined}
 */
export function getActiveDocumentByPath(scope, projectId, filePath) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    return db.prepare(`
        SELECT * FROM knowledge_documents
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND file_path = ? AND status = 'active'
        ORDER BY revision DESC LIMIT 1
    `).get(ownerUserId, tenantId, p, String(filePath));
}

export function getLatestDocumentByPath(scope, projectId, filePath) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    return db.prepare(`
        SELECT * FROM knowledge_documents
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND file_path = ?
        ORDER BY revision DESC LIMIT 1
    `).get(ownerUserId, tenantId, p, String(filePath));
}

export function getDocumentById(scope, documentId) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    return db.prepare(`
        SELECT * FROM knowledge_documents
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
    `).get(String(documentId), ownerUserId, tenantId);
}

export function listActiveDocuments(scope, projectId, { limit = 500, offset = 0, filePath = null } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    if (filePath != null) {
        return db.prepare(`
            SELECT * FROM knowledge_documents
            WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND file_path = ? AND status = 'active'
            ORDER BY file_path ASC LIMIT ? OFFSET ?
        `).all(ownerUserId, tenantId, p, String(filePath), Math.max(1, Number(limit) | 0), Math.max(0, Number(offset) | 0));
    }
    return db.prepare(`
        SELECT * FROM knowledge_documents
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND status = 'active'
        ORDER BY file_path ASC LIMIT ? OFFSET ?
    `).all(ownerUserId, tenantId, p, Math.max(1, Number(limit) | 0), Math.max(0, Number(offset) | 0));
}

/**
 * Insert one file revision. The default `status='active'` preserves the R4
 * replacement behavior. K4 passes `status='indexing'` to stage a new revision
 * while the previous active revision remains readable until activation.
 */
export function insertDocumentRevision(opts) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(opts.scope);
    const projectId = requireKnowledgeProject(opts.projectId);
    const filePath = String(opts.filePath || "");
    if (!filePath) throw new Error("insertDocumentRevision requires filePath");
    const latest = getLatestDocumentByPath({ ownerUserId, tenantId }, projectId, filePath);
    const revision = Math.max(
        Number(opts.previous?.revision || 0),
        Number(latest?.revision || 0),
    ) + 1;
    const documentId = opts.documentId || newDocumentId();
    const status = String(opts.status || "active");
    if (!["indexing", "active", "failed", "stale"].includes(status)) {
        const error = new Error("invalid knowledge document status");
        error.code = "KNOWLEDGE_DOCUMENT_STATUS_INVALID";
        throw error;
    }

    const upsertDoc = db.transaction(() => {
        if (opts.previous && status === "active") {
            db.prepare(`
                UPDATE knowledge_documents
                SET status = 'stale', updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'active'
            `).run(String(opts.previous.id), ownerUserId, tenantId);
            db.prepare(`
                UPDATE knowledge_chunks SET stale = 1
                WHERE document_id = ? AND owner_user_id = ? AND tenant_id = ?
            `).run(String(opts.previous.id), ownerUserId, tenantId);
        }
        db.prepare(`
            INSERT INTO knowledge_documents
            (id, owner_user_id, tenant_id, project_id, doc_type, file_path, file_name,
             file_hash, size_bytes, status, revision, revision_of, source_run_id,
             source_session_id, source_commit, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            documentId, ownerUserId, tenantId, projectId,
            String(opts.docType || "project_file"), filePath,
            String(opts.fileName || filePath),
            String(opts.fileHash || ""), Math.max(0, Number(opts.sizeBytes) | 0),
            status, revision, opts.previous ? String(opts.previous.id) : null,
            opts.sourceRunId ? String(opts.sourceRunId) : null,
            opts.sourceSessionId == null ? null : Number(opts.sourceSessionId),
            opts.sourceCommit ? String(opts.sourceCommit) : null,
            JSON.stringify(opts.meta || {}),
        );
        const chunks = Array.isArray(opts.chunks) ? opts.chunks : [];
        const insertChunk = db.prepare(`
            INSERT INTO knowledge_chunks
            (document_id, owner_user_id, tenant_id, project_id, chunk_index, start_line,
             end_line, page_start, page_end, heading_path, chunk_level, parent_chunk_id,
             content, content_hash, symbols, token_count, stale, embedding, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `);
        const parentIds = new Map();
        const orderedChunks = [
            ...chunks.filter((chunk) => String(chunk.chunkLevel || "leaf") === "parent"),
            ...chunks.filter((chunk) => String(chunk.chunkLevel || "leaf") !== "parent"),
        ];
        for (const chunk of orderedChunks) {
            const chunkLevel = String(chunk.chunkLevel || "leaf");
            const headingPath = Array.isArray(chunk.headingPath)
                ? chunk.headingPath
                : Array.isArray(chunk.meta?.headingPath) ? chunk.meta.headingPath : [];
            const parentId = chunkLevel === "parent"
                ? null
                : (chunk.parentChunkId ?? parentIds.get(String(chunk.parentKey || "")) ?? null);
            insertChunk.run(
                documentId, ownerUserId, tenantId, projectId,
                Number(chunk.chunkIndex) | 0,
                chunk.startLine == null ? null : Number(chunk.startLine) | 0,
                chunk.endLine == null ? null : Number(chunk.endLine) | 0,
                chunk.pageStart == null ? null : Number(chunk.pageStart) | 0,
                chunk.pageEnd == null ? null : Number(chunk.pageEnd) | 0,
                JSON.stringify(headingPath),
                chunkLevel,
                parentId == null ? null : Number(parentId),
                String(chunk.content || ""),
                String(chunk.contentHash || ""),
                String(chunk.symbols || ""),
                Number(chunk.tokenCount) | 0,
                chunk.embedding == null ? null : JSON.stringify(chunk.embedding),
                JSON.stringify({ ...(chunk.meta || {}), parentKey: chunk.parentKey || null }),
            );
            if (chunkLevel === "parent" && chunk.parentKey) {
                const insertedId = db.prepare("SELECT last_insert_rowid() AS id").get()?.id;
                parentIds.set(String(chunk.parentKey), Number(insertedId));
            }
        }
        if (status === "active") {
            bumpKnowledgeIndexGenerationInTransaction({ ownerUserId, tenantId, projectId });
        }
        return chunks.length;
    });
    const chunkCount = upsertDoc();
    return { documentId, revision, chunkCount };
}

/** Activate a staged K4 revision only after all chunks have been written. */
export function activateDocumentRevision(scope, documentId, { previousDocumentId = null } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const target = getDocumentById(scope, documentId);
    if (!target || target.status !== "indexing") return false;
    const tx = db.transaction(() => {
        if (previousDocumentId) {
            db.prepare(`
                UPDATE knowledge_documents SET status = 'stale', updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'active'
            `).run(String(previousDocumentId), ownerUserId, tenantId);
            db.prepare(`
                UPDATE knowledge_chunks SET stale = 1
                WHERE document_id = ? AND owner_user_id = ? AND tenant_id = ?
            `).run(String(previousDocumentId), ownerUserId, tenantId);
        }
        const activated = db.prepare(`
            UPDATE knowledge_documents SET status = 'active', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'indexing'
        `).run(String(documentId), ownerUserId, tenantId);
        if (activated.changes > 0) {
            bumpKnowledgeIndexGenerationInTransaction({
                ownerUserId,
                tenantId,
                projectId: target.project_id,
            });
        }
        return activated.changes > 0;
    });
    return tx();
}

/** Mark an incomplete staged revision failed without touching old active data. */
export function failDocumentRevision(scope, documentId, { reason = "indexing-failed" } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const result = db.prepare(`
        UPDATE knowledge_documents SET status = 'failed', updated_at = CURRENT_TIMESTAMP,
            meta = json_set(meta, '$.failureReason', ?)
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'indexing'
    `).run(String(reason).slice(0, 200), String(documentId), ownerUserId, tenantId);
    return result.changes > 0;
}

/**
 * Mark a document (and its chunks) stale. Used for rollback / file deletion.
 * @returns {boolean} true if an active row was affected
 */
export function markDocumentStale(scope, documentId, { reason = null } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const doc = getDocumentById(scope, documentId);
    if (!doc || doc.status !== "active") return false;
    const tx = db.transaction(() => {
        const changed = db.prepare(`
            UPDATE knowledge_documents SET status = 'stale', updated_at = CURRENT_TIMESTAMP,
                meta = json_set(meta, '$.staleReason', ?)
            WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'active'
        `).run(reason ? String(reason).slice(0, 200) : null, String(documentId), ownerUserId, tenantId);
        db.prepare(`UPDATE knowledge_chunks SET stale = 1 WHERE document_id = ? AND owner_user_id = ? AND tenant_id = ?`)
            .run(String(documentId), ownerUserId, tenantId);
        if (changed.changes > 0) {
            bumpKnowledgeIndexGenerationInTransaction({ ownerUserId, tenantId, projectId: doc.project_id });
        }
        return changed.changes > 0;
    });
    return tx();
}

/** Hard-delete a project's rows (rollback path). Returns deleted doc count. */
export function deleteProject(scope, projectId) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    const tx = db.transaction(() => {
        const docs = db.prepare(`
            SELECT id FROM knowledge_documents
            WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ?
        `).all(ownerUserId, tenantId, p);
        db.prepare(`DELETE FROM knowledge_chunks WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ?`)
            .run(ownerUserId, tenantId, p);
        const del = db.prepare(`DELETE FROM knowledge_documents WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ?`)
            .run(ownerUserId, tenantId, p);
        if (del.changes > 0 || docs.length > 0) {
            bumpKnowledgeIndexGenerationInTransaction({ ownerUserId, tenantId, projectId: p });
        }
        return { documents: del.changes, chunks: 0, prior: docs.length };
    });
    return tx();
}

// ────────────────────────── chunks ──────────────────────────

const CHUNK_SELECT = `
    SELECT kc.*, kd.file_path, kd.file_name, kd.doc_type, kd.status AS document_status,
        kd.source_commit, kd.source_run_id, kd.revision AS doc_revision
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
`;

function mapChunk(row) {
    if (!row) return row;
    let embedding = null;
    let headingPath = [];
    if (row.embedding != null) {
        try { embedding = JSON.parse(row.embedding); } catch { embedding = null; }
    }
    if (row.heading_path != null) {
        try {
            const parsed = JSON.parse(row.heading_path);
            headingPath = Array.isArray(parsed) ? parsed : [];
        } catch { headingPath = []; }
    }
    return { ...row, embedding, headingPath };
}

/**
 * Active chunks for a project (with document path/commit joined), most recent
 * revision first. Backbone for lexical + hybrid retrieval.
 */
export function getActiveChunks(scope, projectId, { filePath = null, limit = 2000, offset = 0 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    const lim = Math.max(1, Number(limit) | 0);
    const off = Math.max(0, Number(offset) | 0);
    let rows;
    if (filePath != null) {
        rows = db.prepare(`
            ${CHUNK_SELECT}
            WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ? AND kc.stale = 0
              AND kd.status = 'active' AND (kc.chunk_level IS NULL OR kc.chunk_level = 'leaf') AND kd.file_path = ?
            ORDER BY kd.file_path ASC, kc.chunk_index ASC LIMIT ? OFFSET ?
        `).all(ownerUserId, tenantId, p, String(filePath), lim, off);
    } else {
        rows = db.prepare(`
            ${CHUNK_SELECT}
            WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ? AND kc.stale = 0
              AND kd.status = 'active' AND (kc.chunk_level IS NULL OR kc.chunk_level = 'leaf')
            ORDER BY kd.file_path ASC, kc.chunk_index ASC LIMIT ? OFFSET ?
        `).all(ownerUserId, tenantId, p, lim, off);
    }
    return rows.map(mapChunk);
}

export function getChunksByDocument(scope, documentId, { activeOnly = true } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const extra = activeOnly ? "AND kc.stale = 0" : "";
    const rows = db.prepare(`
        ${CHUNK_SELECT}
        WHERE kc.document_id = ? AND kc.owner_user_id = ? AND kc.tenant_id = ? ${extra}
        ORDER BY kc.chunk_index ASC
    `).all(String(documentId), ownerUserId, tenantId);
    return rows.map(mapChunk);
}

/**
 * Active chunks that carry a persisted embedding for a project — the source of
 * truth used to rebuild the in-memory vector index after a restart.
 */
const MAX_EMBEDDED_PAGE_SIZE = 2000;

/**
 * Stable, bounded source read for vector-index construction. `afterId` is an
 * exclusive SQLite row id cursor; callers must append pages in the returned
 * order so FAISS labels remain aligned with chunkIds.
 */
export function getEmbeddedActiveChunks(scope, projectId, { afterId = null, limit = 512 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    const lim = Math.max(1, Math.min(MAX_EMBEDDED_PAGE_SIZE, Number(limit) | 0));
    const cursor = afterId == null ? null : Number(afterId);
    const rows = cursor != null && Number.isSafeInteger(cursor) && cursor >= 0
        ? db.prepare(`
            ${CHUNK_SELECT}
            WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ?
              AND kc.id > ? AND kc.stale = 0 AND kd.status = 'active'
              AND kc.chunk_level = 'leaf' AND kc.embedding IS NOT NULL
            ORDER BY kc.id ASC LIMIT ?
        `).all(ownerUserId, tenantId, p, cursor, lim)
        : db.prepare(`
            ${CHUNK_SELECT}
            WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ?
              AND kc.stale = 0 AND kd.status = 'active'
              AND kc.chunk_level = 'leaf' AND kc.embedding IS NOT NULL
            ORDER BY kc.id ASC LIMIT ?
        `).all(ownerUserId, tenantId, p, lim);
    return rows.map(mapChunk);
}

/**
 * Hydrate FAISS labels through the authoritative DB. The repeated scope,
 * active-document, stale, and leaf predicates are intentional: a derived
 * index can be old or tampered with and must never widen read permissions.
 */
export function getActiveChunksByIds(scope, projectId, chunkIds = []) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    const ids = [...new Set((Array.isArray(chunkIds) ? chunkIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 10000);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
        ${CHUNK_SELECT}
        WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ?
          AND kc.id IN (${placeholders}) AND kc.stale = 0
          AND kd.status = 'active' AND kc.chunk_level = 'leaf'
    `).all(ownerUserId, tenantId, p, ...ids);
    return rows.map(mapChunk);
}

/** Persist embeddings for chunks that were inserted without them (idempotent). */
export function fillChunkEmbeddings(scope, rows = []) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const update = db.prepare(`
        UPDATE knowledge_chunks SET embedding = ?
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
    `);
    const projectLookup = db.prepare(`
        SELECT project_id FROM knowledge_chunks
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
    `);
    const tx = db.transaction(() => {
        let updated = 0;
        const projects = new Set();
        for (const row of rows) {
            if (!row.id || row.embedding == null) continue;
            const res = update.run(JSON.stringify(row.embedding), Number(row.id), ownerUserId, tenantId);
            if (res.changes > 0) {
                updated += res.changes;
                const projectId = row.project_id || row.projectId
                    || projectLookup.get(Number(row.id), ownerUserId, tenantId)?.project_id;
                if (projectId) projects.add(requireKnowledgeProject(projectId));
            }
        }
        for (const projectId of projects) {
            bumpKnowledgeIndexGenerationInTransaction({ ownerUserId, tenantId, projectId });
        }
        return { updated, projects: [...projects] };
    });
    return tx().updated;
}

/** Parent sections used for post-retrieval context expansion. */
export function getParentChunks(scope, documentId, { limit = 50 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const rows = db.prepare(`
        ${CHUNK_SELECT}
        WHERE kc.document_id = ? AND kc.owner_user_id = ? AND kc.tenant_id = ?
          AND kc.stale = 0 AND kc.chunk_level = 'parent' AND kd.status = 'active'
        ORDER BY kc.chunk_index ASC LIMIT ?
    `).all(String(documentId), ownerUserId, tenantId, Math.max(1, Number(limit) | 0));
    return rows.map(mapChunk);
}

// ────────────────────────── counts / telemetry ──────────────────────────

export function countDocuments(scope, projectId, { status = "active" } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    return Number(db.prepare(`
        SELECT COUNT(*) AS c FROM knowledge_documents
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND status = ?
    `).get(ownerUserId, tenantId, p, status)?.c || 0);
}

export function countChunks(scope, projectId, { active = true } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    return Number(db.prepare(`
        SELECT COUNT(*) AS c FROM knowledge_chunks
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? ${active ? "AND stale = 0" : ""}
    `).get(ownerUserId, tenantId, p)?.c || 0);
}

export default {
    normalizeKnowledgeScope, requireKnowledgeProject, sha256Hex, newDocumentId, getKnowledgeIndexGeneration,
    getActiveDocumentByPath, getLatestDocumentByPath, getDocumentById, listActiveDocuments,
    insertDocumentRevision, activateDocumentRevision, failDocumentRevision, markDocumentStale, deleteProject,
    getActiveChunks, getChunksByDocument, getParentChunks, getEmbeddedActiveChunks, getActiveChunksByIds, fillChunkEmbeddings,
    countDocuments, countChunks,
};
