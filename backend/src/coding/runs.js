/**
 * CodingRunService — owner-scoped run snapshot + lifecycle.
 *
 * A run is the durable unit of coding work. `snapshot_json` stores only
 * server-decided facts (capability flags, project trust state, mode, scope) —
 * never user content, secrets, raw env, or provider errors. R0 keeps the mode
 * at `observe`; nothing here opens write or command execution (that is R2, gated
 * by separate flags). The service is DB-backed; single-runtime semantics live in
 * CodingRuntimeRegistry (process-local) — see registrar for the coordinated flow.
 *
 * Run lifecycle (roadmap §4.1):
 *   created → preparing → planning → running → waiting_approval → verifying
 *           → completed | failed | cancelled
 * R0 exercises created → running → cancelled/terminal via start/cancel.
 */
import db, { initDB } from "../db/index.js";
import { codingCapabilities, codingWriteToolsEnabled } from "./flags.js";
import { codingEventLogEnabled } from "./flags.js";
import defaultEventStore from "./events.js";
import { codingError, newId, requireCodingScope, sanitizeStored } from "./util.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

const RUN_STATUS = new Set([
    "created", "preparing", "planning", "running", "waiting_approval", "verifying",
    "completed", "failed", "cancelled",
]);
const TERMINAL_RUN_STATUS = new Set(["completed", "failed", "cancelled"]);
// R2: presets. `observe` is the only mode available before CODING_WRITE_TOOLS_ENABLED;
// `edit` (write needs approval) and `trusted` (write auto-approved by policy) are
// write-enabled run modes — their creation is gated server-side by the write flag.
const ALLOWED_MODES = new Set(["observe", "edit", "trusted"]);
const STARTABLE_FROM = new Set(["created", "preparing", "planning"]);
const EVENT_FOR = {
    running: "run.started",
    completed: "run.completed",
    failed: "run.failed",
    cancelled: "run.cancelled",
};

function toRun(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        sessionId: row.session_id,
        status: row.status,
        mode: row.mode,
        preset: row.preset || row.mode || "observe",
        snapshot: (() => { try { return JSON.parse(row.snapshot_json); } catch { return {}; } })(),
        eventSeq: Number(row.event_seq),
        cancelled: Number(row.cancelled) === 1,
        errorCode: row.error_code,
        // R2 write-enabled run identity (server-decided; NULLs → empty defaults)
        worktreePath: row.worktree_path || null,
        worktreeBranch: row.worktree_branch || null,
        baseBranch: row.base_branch || null,
        baseCommit: row.base_commit || null,
        worktreeStatus: row.worktree_status || "none",
        provisionedAt: row.provisioned_at || null,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
    };
}

export class CodingRunService {
    constructor(eventStore = defaultEventStore) {
        this.eventStore = eventStore;
    }

    /** Build a server-decided run snapshot (durable facts, no user content). */
    _buildSnapshot({ userId, tenantId, project, mode }) {
        return {
            scope: { owner: "personal", tenantId, userId },
            mode,
            preset: mode, // R2: preset == run mode (observe|edit|trusted)
            project: project
                ? { id: project.id, name: project.name, status: project.status, trusted: Number(project.trusted) === 1 }
                : null,
            capabilities: codingCapabilities(),
            graph: "chatGraph", // runs stay under the single main Graph contract
            createdAtUtc: new Date().toISOString(),
        };
    }

    _append(scope, runId, event) {
        if (!codingEventLogEnabled()) return null;
        return this.eventStore.appendEvent(scope, runId, event);
    }

    _resolveProject(scope, projectId) {
        if (projectId == null) return null;
        const { userId, tenantId } = scope;
        return db.prepare(
            "SELECT id, name, root_path, status, trusted FROM coding_projects WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(projectId), userId, tenantId) || null;
    }

    _assertSessionOwned(scope, sessionId) {
        if (sessionId == null) return;
        const { userId } = scope;
        const owned = db.prepare("SELECT 1 AS found FROM sessions WHERE id = ? AND user_id = ?").get(Number(sessionId), userId);
        if (!owned) throw codingError("INVALID_SESSION", "session not found or not owned", 400);
    }

    createRun(scope, { projectId = null, sessionId = null, mode = "observe", requestId = null, causationId = null } = {}) {
        ensureSchema();
        const scoped = requireCodingScope(scope, "run");
        const { userId, tenantId } = scoped;
        const cleanMode = String(mode || "observe");
        if (!ALLOWED_MODES.has(cleanMode)) {
            throw codingError("MODE_NOT_AVAILABLE", `mode '${cleanMode}' is not available (observe|edit|trusted)`, 400);
        }
        // A write-enabled preset is a server capability decision: without the
        // write-tools flag the run cannot be created in edit/trusted even if a
        // client asks for it (LLM/client intent is never an authorization).
        if (cleanMode !== "observe" && !codingWriteToolsEnabled()) {
            throw codingError("WRITE_TOOLS_DISABLED", "write-enabled run modes require CODING_WRITE_TOOLS_ENABLED", 403);
        }
        this._assertSessionOwned(scoped, sessionId);
        const project = this._resolveProject(scoped, projectId);
        if (projectId != null && !project) throw codingError("PROJECT_NOT_FOUND", "project not found or not owned", 404);
        // A write-enabled run must name a project — there is nothing to write to
        // otherwise. Trust is enforced later at provision time (resolveProjectRoot).
        if (cleanMode !== "observe" && !project) {
            throw codingError("RUN_REQUIRES_PROJECT", "write-enabled run modes require a project", 400);
        }

        const id = newId("run_");
        const snapshot = sanitizeStored(this._buildSnapshot({ userId, tenantId, project, mode: cleanMode }));
        db.prepare(
            `INSERT INTO coding_runs
                (id, owner_user_id, tenant_id, session_id, project_id, status, mode, preset, snapshot_json, event_seq, cancelled)
             VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, 0, 0)`,
        ).run(id, userId, tenantId, sessionId == null ? null : Number(sessionId), project?.id || null, cleanMode, cleanMode, snapshot);

        this._append(scoped, id, {
            type: "run.created",
            payload: { mode: cleanMode, projectId: project?.id || null },
            requestId,
            causationId,
        });
        return this.getRun(scoped, id);
    }

    getRun(scope, runId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "run");
        return toRun(db.prepare(
            "SELECT * FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(runId), userId, tenantId));
    }

    listRuns(scope, { projectId = null, limit = 50 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "run");
        const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
        const rows = projectId
            ? db.prepare(
                "SELECT * FROM coding_runs WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?",
            ).all(userId, tenantId, String(projectId), safeLimit)
            : db.prepare(
                "SELECT * FROM coding_runs WHERE owner_user_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?",
            ).all(userId, tenantId, safeLimit);
        return rows.map(toRun);
    }

    /**
     * Atomic DB claim for start: only non-terminal runs may move forward, and only
     * one transition wins (single writer UPDATE ... RETURNING). Single-runtime
     * enforcement across concurrent starts additionally uses the process-local
     * CodingRuntimeRegistry — the registrar acquires the registry lock first.
     */
    startRun(scope, runId) {
        return this._transition(scope, runId, "running", { allowFrom: STARTABLE_FROM });
    }

    cancelRun(scope, runId) {
        return this._transition(scope, runId, "cancelled", { allowFrom: RUN_STATUS });
    }

    completeRun(scope, runId) {
        return this._transition(scope, runId, "completed", { allowFrom: RUN_STATUS });
    }

    failRun(scope, runId, { errorCode = null } = {}) {
        return this._transition(scope, runId, "failed", { allowFrom: RUN_STATUS, errorCode });
    }

    _transition(scope, runId, to, { allowFrom = RUN_STATUS, errorCode = null } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "run");
        const id = String(runId);
        if (!RUN_STATUS.has(to)) throw codingError("INVALID_RUN_STATUS", `unsupported run status: ${to}`, 400);
        const current = db.prepare(
            "SELECT status FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(id, userId, tenantId);
        if (!current) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (TERMINAL_RUN_STATUS.has(current.status)) {
            throw codingError("RUN_TERMINAL", `run is already ${current.status}`, 409);
        }
        if (!allowFrom.has(current.status)) {
            throw codingError("RUN_TRANSITION", `cannot move run from '${current.status}' to '${to}'`, 409);
        }

        const terminal = TERMINAL_RUN_STATUS.has(to);
        const changed = db.prepare(
            `UPDATE coding_runs
             SET status = ?, error_code = ?,
                 started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP END),
                 completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP END,
                 cancelled = CASE WHEN ? = 'cancelled' THEN 1 ELSE cancelled END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
               AND status NOT IN ('completed', 'failed', 'cancelled')`,
        ).run(to, errorCode ? String(errorCode).slice(0, 128) : null, to, terminal ? 1 : 0, to, id, userId, tenantId).changes;
        if (!changed) throw codingError("RUN_TRANSITION", `run is already terminal`, 409);

        const eventType = EVENT_FOR[to] || "run.status";
        this._append({ userId, tenantId }, id, {
            type: eventType,
            payload: { from: current.status, to, errorCode: errorCode || null },
        });
        return this.getRun({ userId, tenantId }, id);
    }

    /**
     * Persist the server-decided worktree identity of a write-enabled run
     * (base commit/branch = the disposable worktree was created from these).
     * Allowed on any run state so teardown-after-cancel can record `removed`.
     */
    setWorktree(scope, runId, { path = null, branch = null, baseBranch = null, baseCommit = null, status = "none", provisionedAt = null } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "run");
        const id = String(runId);
        const changed = db.prepare(
            `UPDATE coding_runs
             SET worktree_path = ?, worktree_branch = ?, base_branch = ?, base_commit = ?,
                 worktree_status = ?, provisioned_at = COALESCE(?, provisioned_at),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`,
        ).run(
            path ? String(path).slice(0, 2048) : null,
            branch ? String(branch).slice(0, 200) : null,
            baseBranch ? String(baseBranch).slice(0, 200) : null,
            baseCommit ? String(baseCommit).slice(0, 64) : null,
            ["none", "provisioning", "ready", "unsupported", "failed", "removed"].includes(String(status)) ? String(status) : "none",
            provisionedAt ? String(provisionedAt).slice(0, 40) : null,
            id, userId, tenantId,
        ).changes;
        if (!changed) throw codingError("NOT_FOUND", "coding run not found", 404);
        return this.getRun({ userId, tenantId }, id);
    }

    /** Convenience: flip only the worktree lifecycle bit (no identity rewrite). */
    updateWorktreeStatus(scope, runId, status) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "run");
        const id = String(runId);
        const clean = ["none", "provisioning", "ready", "unsupported", "failed", "removed"].includes(String(status)) ? String(status) : "none";
        const changed = db.prepare(
            `UPDATE coding_runs SET worktree_status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`,
        ).run(clean, id, userId, tenantId).changes;
        if (!changed) throw codingError("NOT_FOUND", "coding run not found", 404);
        return this.getRun({ userId, tenantId }, id);
    }

    /** Pending write/exec run lifecycles: waiting_approval ⇄ running (approval resume). */
    waitForApproval(scope, runId) {
        return this._transition(scope, runId, "waiting_approval", { allowFrom: new Set(["running", "verifying", "planning", "waiting_approval"]) });
    }

    resumeRun(scope, runId) {
        return this._transition(scope, runId, "running", { allowFrom: new Set(["waiting_approval", "running"]) });
    }

    verifying(scope, runId) {
        return this._transition(scope, runId, "verifying", { allowFrom: new Set(["running", "waiting_approval"]) });
    }
}

export const defaultRunService = new CodingRunService();
export default defaultRunService;
