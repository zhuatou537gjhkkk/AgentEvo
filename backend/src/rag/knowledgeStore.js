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
 *     array, so the vector index is rebuilt lazily from this same DB after a
 *     restart (`DurableVectorStore.loadProject`). No separate faiss file.
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
 * Replace one file's active revision with a new revision inside a single
 * transaction. `previous` (optional) is the current active row: it is marked
 * stale together with all its chunks, and `revision = previous.revision + 1`.
 * @param {object} opts { scope, projectId, filePath, fileName, docType, fileHash,
 *   sizeBytes, sourceRunId, sourceCommit, meta, chunks: [{ chunkIndex, startLine,
 *   endLine, content, contentHash, symbols, tokenCount, embedding }] , previous }
 * @returns {{ documentId, revision, chunkCount }}
 */
export function insertDocumentRevision(opts) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(opts.scope);
    const projectId = requireKnowledgeProject(opts.projectId);
    const filePath = String(opts.filePath || "");
    if (!filePath) throw new Error("insertDocumentRevision requires filePath");
    const revision = opts.previous ? Number(opts.previous.revision || 1) + 1 : 1;
    const documentId = opts.documentId || newDocumentId();

    const upsertDoc = db.transaction(() => {
        if (opts.previous) {
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `).run(
            documentId, ownerUserId, tenantId, projectId,
            String(opts.docType || "project_file"), filePath,
            String(opts.fileName || filePath),
            String(opts.fileHash || ""), Math.max(0, Number(opts.sizeBytes) | 0),
            revision, opts.previous ? String(opts.previous.id) : null,
            opts.sourceRunId ? String(opts.sourceRunId) : null,
            opts.sourceSessionId == null ? null : Number(opts.sourceSessionId),
            opts.sourceCommit ? String(opts.sourceCommit) : null,
            JSON.stringify(opts.meta || {}),
        );
        const chunks = Array.isArray(opts.chunks) ? opts.chunks : [];
        const insertChunk = db.prepare(`
            INSERT INTO knowledge_chunks
            (document_id, owner_user_id, tenant_id, project_id, chunk_index, start_line,
             end_line, content, content_hash, symbols, token_count, stale, embedding, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `);
        for (const chunk of chunks) {
            insertChunk.run(
                documentId, ownerUserId, tenantId, projectId,
                Number(chunk.chunkIndex) | 0,
                chunk.startLine == null ? null : Number(chunk.startLine) | 0,
                chunk.endLine == null ? null : Number(chunk.endLine) | 0,
                String(chunk.content || ""),
                String(chunk.contentHash || ""),
                String(chunk.symbols || ""),
                Number(chunk.tokenCount) | 0,
                chunk.embedding == null ? null : JSON.stringify(chunk.embedding),
                JSON.stringify(chunk.meta || {}),
            );
        }
        return chunks.length;
    });
    const chunkCount = upsertDoc();
    return { documentId, revision, chunkCount };
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
        db.prepare(`
            UPDATE knowledge_documents SET status = 'stale', updated_at = CURRENT_TIMESTAMP,
                meta = json_set(meta, '$.staleReason', ?)
            WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'active'
        `).run(reason ? String(reason).slice(0, 200) : null, String(documentId), ownerUserId, tenantId);
        db.prepare(`UPDATE knowledge_chunks SET stale = 1 WHERE document_id = ? AND owner_user_id = ? AND tenant_id = ?`)
            .run(String(documentId), ownerUserId, tenantId);
    });
    tx();
    return true;
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
        return { documents: del.changes, chunks: 0, prior: docs.length };
    });
    return tx();
}

// ────────────────────────── chunks ──────────────────────────

const CHUNK_SELECT = `
    SELECT kc.*, kd.file_path, kd.file_name, kd.doc_type, kd.source_commit, kd.source_run_id, kd.revision AS doc_revision
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
`;

function mapChunk(row) {
    if (!row) return row;
    let embedding = null;
    if (row.embedding != null) {
        try { embedding = JSON.parse(row.embedding); } catch { embedding = null; }
    }
    return { ...row, embedding };
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
              AND kd.status = 'active' AND kd.file_path = ?
            ORDER BY kd.file_path ASC, kc.chunk_index ASC LIMIT ? OFFSET ?
        `).all(ownerUserId, tenantId, p, String(filePath), lim, off);
    } else {
        rows = db.prepare(`
            ${CHUNK_SELECT}
            WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ? AND kc.stale = 0
              AND kd.status = 'active'
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
export function getEmbeddedActiveChunks(scope, projectId, { limit = 100000 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const p = requireKnowledgeProject(projectId);
    const rows = db.prepare(`
        ${CHUNK_SELECT}
        WHERE kc.owner_user_id = ? AND kc.tenant_id = ? AND kc.project_id = ? AND kc.stale = 0
          AND kd.status = 'active' AND kc.embedding IS NOT NULL
        ORDER BY kc.id ASC LIMIT ?
    `).all(ownerUserId, tenantId, p, Math.max(1, Number(limit) | 0));
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
    const tx = db.transaction(() => {
        let updated = 0;
        for (const row of rows) {
            if (!row.id || row.embedding == null) continue;
            const res = update.run(JSON.stringify(row.embedding), Number(row.id), ownerUserId, tenantId);
            updated += res.changes;
        }
        return updated;
    });
    return tx();
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
    normalizeKnowledgeScope, requireKnowledgeProject, sha256Hex, newDocumentId,
    getActiveDocumentByPath, getLatestDocumentByPath, getDocumentById, listActiveDocuments,
    insertDocumentRevision, markDocumentStale, deleteProject,
    getActiveChunks, getChunksByDocument, getEmbeddedActiveChunks, fillChunkEmbeddings,
    countDocuments, countChunks,
};
