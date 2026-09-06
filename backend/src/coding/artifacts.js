/**
 * Phase 7 / R2 — CodingArtifactService: durable, owner-scoped artifact ledger.
 *
 * Every workspace mutation leaves an artifact row: kind (file.write/file.create/
 * file.delete/file.patch), the rel path, the before/after sha256 digests, and a
 * server-decided storage reference. The artifact rows are the durable proof that
 * survives worktree teardown (digests, not file bytes); the disposable worktree
 * itself is the live store. Full file content is deliberately NOT persisted —
 * only digests + small metadata, so a secret accidentally written by the model
 * into a file never lands in the DB.
 */
import db, { initDB } from "../db/index.js";
import { codingError, newId, requireCodingScope, sanitizeStored } from "./util.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

const ARTIFACT_KINDS = new Set([
    "file.write", "file.create", "file.delete", "file.patch",
    "command.output",
]);

export class CodingArtifactService {
    record(scope, { runId = null, actionId = null, kind, path = null, digest = null, sizeBytes = null, storageRef = null, meta = {} } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "artifact");
        const cleanKind = String(kind || "");
        if (!ARTIFACT_KINDS.has(cleanKind)) {
            throw codingError("INVALID_ARTIFACT_KIND", `unsupported artifact kind: ${cleanKind}`, 400);
        }
        if (runId == null && actionId == null) {
            throw codingError("INVALID_ARTIFACT", "artifact needs a run or action scope", 400);
        }
        const id = newId("art_");
        const metaJson = sanitizeStored(meta ?? {});
        const cleanRef = String(storageRef || "").slice(0, 2048);
        db.prepare(
            `INSERT INTO coding_artifacts
                (id, owner_user_id, tenant_id, run_id, action_id, kind, path, digest, size_bytes, storage_ref, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id, userId, tenantId,
            runId ? String(runId).slice(0, 128) : null,
            actionId ? String(actionId).slice(0, 128) : null,
            cleanKind,
            path ? String(path).slice(0, 1024) : null,
            digest ? String(digest).slice(0, 64) : null,
            sizeBytes == null ? null : Math.max(0, Number(sizeBytes) | 0),
            cleanRef,
            metaJson,
        );
        return this.get(scope, id);
    }

    get(scope, artifactId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "artifact");
        return toArtifact(db.prepare(
            "SELECT * FROM coding_artifacts WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(artifactId), userId, tenantId));
    }

    listForRun(scope, runId, { limit = 500 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "artifact");
        const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 500));
        return db.prepare(
            `SELECT * FROM coding_artifacts
             WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?
             ORDER BY created_at ASC LIMIT ?`,
        ).all(String(runId), userId, tenantId, safeLimit).map(toArtifact);
    }

    listForAction(scope, actionId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "artifact");
        return db.prepare(
            `SELECT * FROM coding_artifacts
             WHERE action_id = ? AND owner_user_id = ? AND tenant_id = ?
             ORDER BY created_at ASC`,
        ).all(String(actionId), userId, tenantId).map(toArtifact);
    }
}

function toArtifact(row) {
    if (!row) return null;
    return {
        id: row.id,
        runId: row.run_id,
        actionId: row.action_id,
        kind: row.kind,
        path: row.path,
        digest: row.digest,
        sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
        storageRef: row.storage_ref,
        meta: (() => { try { return JSON.parse(row.meta); } catch { return {}; } })(),
        createdAt: row.created_at,
    };
}

export const defaultArtifactService = new CodingArtifactService();
export default defaultArtifactService;
