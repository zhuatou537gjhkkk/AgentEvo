/**
 * CodingProjectService — owner-scoped registration + trust for project roots.
 *
 * R0 keeps project *records* only: no filesystem access, no canonical realpath
 * resolution (that is R1 workspace path security). A project becomes trusted by
 * explicit server-side action (registrar), never by project selection, model
 * intent, or Skill/MCP discovery. Lifecycle:
 *   registered ⇄ trusted → archived | revoked (terminal).
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

const ALLOWED_STATUS = new Set(["registered", "trusted", "archived", "revoked"]);
const TERMINAL_STATUS = new Set(["archived", "revoked"]);

function toProject(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        status: row.status,
        trusted: Number(row.trusted) === 1,
        trustedAt: row.trusted_at,
        meta: (() => { try { return JSON.parse(row.meta); } catch { return {}; } })(),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function cleanMeta(meta) {
    if (meta == null) return "{}";
    return sanitizeStored(meta);
}

export class CodingProjectService {
    register(scope, { name, rootPath, meta } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "project");
        const cleanName = String(name || "").trim();
        const cleanRoot = String(rootPath || "").trim();
        if (!cleanName || cleanName.length > 120) {
            throw codingError("INVALID_PROJECT", "project name is required (<=120 chars)", 400);
        }
        if (!cleanRoot || cleanRoot.length > 2048 || cleanRoot.includes("\0")) {
            throw codingError("INVALID_PROJECT", "project root path is required", 400);
        }
        const id = newId("proj_");
        const metaJson = cleanMeta(meta ?? {});
        try {
            db.prepare(
                `INSERT INTO coding_projects
                    (id, owner_user_id, tenant_id, name, root_path, status, trusted, meta)
                 VALUES (?, ?, ?, ?, ?, 'registered', 0, ?)`,
            ).run(id, userId, tenantId, cleanName, cleanRoot, metaJson);
        } catch (error) {
            if (String(error?.message || "").includes("UNIQUE")) {
                throw codingError("DUPLICATE_PROJECT", "a project already exists at this root", 409);
            }
            throw error;
        }
        return this.get(scope, id);
    }

    get(scope, projectId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "project");
        return toProject(db.prepare(
            "SELECT * FROM coding_projects WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(projectId), userId, tenantId));
    }

    list(scope, { status = null, limit = 100 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "project");
        const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
        const filter = status && ALLOWED_STATUS.has(String(status));
        const rows = filter
            ? db.prepare(
                "SELECT * FROM coding_projects WHERE owner_user_id = ? AND tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
            ).all(userId, tenantId, String(status), safeLimit)
            : db.prepare(
                "SELECT * FROM coding_projects WHERE owner_user_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?",
            ).all(userId, tenantId, safeLimit);
        return rows.map(toProject);
    }

    /**
     * Update trust/lifecycle. Server-decided only:
     *  - trusted=1 promotes status to `trusted`; trusted=0 demotes `trusted`→`registered`;
     *  - an explicit non-terminal status forces the matching trust bit;
     *  - archived/revoked are terminal: they force trusted=0 and cannot be revived.
     *
     * `trusted` and a non-terminal `status` must agree; when both are supplied the
     * caller's intent is resolved to a consistent pair (terminal status always wins
     * on the trust bit). A terminal project accepts only another terminal status
     * (or cosmetic name edits) — never re-trusting, never silent revival.
     */
    update(scope, projectId, { name = null, status = null, trusted = null } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "project");
        const id = String(projectId);
        const existing = db.prepare(
            "SELECT * FROM coding_projects WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(id, userId, tenantId);
        if (!existing) return null;

        const existingTerminal = TERMINAL_STATUS.has(existing.status);
        const explicitStatus = status == null ? null : String(status);
        if (explicitStatus !== null && !ALLOWED_STATUS.has(explicitStatus)) {
            throw codingError("INVALID_PROJECT_STATUS", `unsupported project status: ${status}`, 400);
        }
        const explicitTrusted = trusted == null ? null : (trusted ? 1 : 0);
        const wantsTerminal = explicitStatus !== null && TERMINAL_STATUS.has(explicitStatus);

        // No revive: a terminal project cannot be promoted/re-trusted or sent to a
        // non-terminal status; only another terminal status (or a cosmetic rename).
        if (existingTerminal && (explicitTrusted === 1 || (explicitStatus !== null && !wantsTerminal))) {
            throw codingError("PROJECT_TERMINAL", `project is already ${existing.status}`, 409);
        }

        let nextStatus = existing.status;
        if (explicitStatus !== null) nextStatus = explicitStatus;
        let nextTrusted = Number(existing.trusted);
        if (explicitTrusted !== null) nextTrusted = explicitTrusted;

        if (TERMINAL_STATUS.has(nextStatus)) {
            nextTrusted = 0; // terminal always untrusted
        } else if (explicitTrusted !== null) {
            // trust bit is the source of truth for registered ⇄ trusted
            nextStatus = explicitTrusted === 1 ? "trusted" : "registered";
        } else if (explicitStatus === "trusted") {
            nextTrusted = 1;
        } else if (explicitStatus === "registered") {
            nextTrusted = 0;
        } else {
            // no deciding field changed → keep the existing pair consistent
            nextStatus = nextTrusted === 1 ? "trusted" : "registered";
        }

        const cleanName = name == null ? existing.name : String(name).trim().slice(0, 120);
        const trustedAtSql = nextTrusted === 1
            ? new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
            : null;
        db.prepare(
            `UPDATE coding_projects
             SET name = ?, status = ?, trusted = ?, trusted_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`,
        ).run(cleanName, nextStatus, nextTrusted, trustedAtSql, id, userId, tenantId);
        return this.get(scope, id);
    }

    revoke(scope, projectId) {
        return this.update(scope, projectId, { status: "revoked" });
    }

    archive(scope, projectId) {
        return this.update(scope, projectId, { status: "archived" });
    }
}

export const defaultProjectService = new CodingProjectService();
export default defaultProjectService;
