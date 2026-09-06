/**
 * ApprovalService — owner-scoped action → approval request → decision.
 *
 * An action records an intended effect (write/exec/network/external) with
 * structured parameters BEFORE any side effect. Nothing in R0 executes actions;
 * this service persists the durable request/decision transcript the runner and
 * tool executor will consume in R1/R2. Approving never equals executing, and
 * decision is owner-only. Payloads (structured input/policy/reason) are
 * sanitized at the boundary so secrets never reach the row.
 */
import db, { initDB } from "../db/index.js";
import { codingEventLogEnabled } from "./flags.js";
import defaultEventStore from "./events.js";
import { cleanText, codingError, newId, requireCodingScope, sanitizeStored } from "./util.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

const EFFECT_TYPES = new Set(["read", "write", "exec", "network", "external"]);
const APPROVAL_STATUS = new Set(["requested", "approved", "denied", "expired", "cancelled"]);
const DECISION = new Set(["approved", "denied"]);

function toAction(row) {
    if (!row) return null;
    return {
        id: row.id,
        runId: row.run_id,
        seq: Number(row.seq),
        type: row.type,
        tool: row.tool,
        input: (() => { try { return JSON.parse(row.input_json); } catch { return {}; } })(),
        status: row.status,
        timeoutMs: row.timeout_ms,
        approvalId: row.approval_id,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toApproval(row) {
    if (!row) return null;
    return {
        id: row.id,
        runId: row.run_id,
        actionId: row.action_id,
        status: row.status,
        policy: (() => { try { return JSON.parse(row.policy); } catch { return {}; } })(),
        requestedBy: row.requested_by,
        decidedBy: row.decided_by,
        reason: row.reason,
        requestedAt: row.requested_at,
        decidedAt: row.decided_at,
        expiresAt: row.expires_at,
    };
}

export class ApprovalService {
    constructor(eventStore = defaultEventStore) {
        this.eventStore = eventStore;
    }

    _append(scope, runId, event) {
        if (!codingEventLogEnabled()) return null;
        return this.eventStore.appendEvent(scope, runId, event);
    }

    _assertRunOpen(scope, runId) {
        const row = db.prepare(
            "SELECT status FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(runId), scope.userId, scope.tenantId);
        if (!row) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
            throw codingError("RUN_TERMINAL", `run is already ${row.status}`, 409);
        }
    }

    /**
     * Record a proposed action and open an approval request for it.
     * R0 default: approvals never execute anything — this is a durable record.
     */
    requestApproval(scope, runId, {
        type, tool, input = {}, timeoutMs = null, policy = {},
        requestedBy = null, reason = null, expiresInMs = 15 * 60 * 1000,
    } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "approval");
        const id = String(runId);
        const effect = String(type || "");
        if (!EFFECT_TYPES.has(effect)) {
            throw codingError("INVALID_ACTION_TYPE", `unsupported action effect: ${effect}`, 400);
        }
        const cleanTool = String(tool || "").trim();
        if (!cleanTool || cleanTool.length > 200) {
            throw codingError("INVALID_ACTION", "action tool is required (<=200 chars)", 400);
        }
        this._assertRunOpen({ userId, tenantId }, id);

        const write = db.transaction(() => {
            const nextRow = db.prepare(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM coding_actions WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?",
            ).get(id, userId, tenantId);
            const seq = Number(nextRow.next_seq);
            const actionId = newId("act_");
            const approvalId = newId("appr_");
            const inputJson = sanitizeStored(input ?? {});
            const policyJson = sanitizeStored(policy ?? {});
            const requestedAt = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
            const expiresAt = Number(expiresInMs) > 0
                ? new Date(Date.now() + Number(expiresInMs)).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
                : null;

            db.prepare(
                `INSERT INTO coding_actions
                    (id, owner_user_id, tenant_id, run_id, seq, type, tool, input_json, status,
                     timeout_ms, approval_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            ).run(actionId, userId, tenantId, id, seq, effect, cleanTool, inputJson,
                timeoutMs ? Math.max(1, Number(timeoutMs)) : null, approvalId, requestedAt, requestedAt);

            db.prepare(
                `INSERT INTO coding_approvals
                    (id, owner_user_id, tenant_id, run_id, action_id, status, policy,
                     requested_by, reason, requested_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
            ).run(approvalId, userId, tenantId, id, actionId, policyJson,
                requestedBy == null ? null : Number(requestedBy),
                reason == null ? null : cleanText(reason, 500), requestedAt, expiresAt);

            db.prepare(
                "UPDATE coding_actions SET status = 'requested', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
            ).run(actionId, userId, tenantId);

            this._append({ userId, tenantId }, id, { type: "action.requested", payload: { actionId, runId: id, type: effect, tool: cleanTool } });
            this._append({ userId, tenantId }, id, { type: "approval.requested", payload: { approvalId, actionId, runId: id } });
            return { approvalId, actionId, seq };
        });
        const { approvalId, actionId } = write();
        return { approval: this.getApproval({ userId, tenantId }, approvalId), action: this._getAction({ userId, tenantId }, actionId) };
    }

    _getAction(scope, actionId) {
        const { userId, tenantId } = requireCodingScope(scope, "action");
        return toAction(db.prepare(
            "SELECT * FROM coding_actions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(actionId), userId, tenantId));
    }

    getAction(scope, actionId) {
        return this._getAction(scope, actionId);
    }

    listActions(scope, runId, { limit = 200 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "action");
        const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
        return db.prepare(
            "SELECT * FROM coding_actions WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? ORDER BY seq ASC LIMIT ?",
        ).all(String(runId), userId, tenantId, safeLimit).map(toAction);
    }

    getApproval(scope, approvalId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "approval");
        return toApproval(db.prepare(
            "SELECT * FROM coding_approvals WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(String(approvalId), userId, tenantId));
    }

    listApprovals(scope, { runId = null, status = null, limit = 200 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "approval");
        const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
        const filter = status && APPROVAL_STATUS.has(String(status));
        const rows = runId
            ? (filter
                ? db.prepare(
                    "SELECT * FROM coding_approvals WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? AND status = ? ORDER BY requested_at DESC LIMIT ?",
                ).all(String(runId), userId, tenantId, String(status), safeLimit)
                : db.prepare(
                    "SELECT * FROM coding_approvals WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? ORDER BY requested_at DESC LIMIT ?",
                ).all(String(runId), userId, tenantId, safeLimit))
            : (filter
                ? db.prepare(
                    "SELECT * FROM coding_approvals WHERE owner_user_id = ? AND tenant_id = ? AND status = ? ORDER BY requested_at DESC LIMIT ?",
                ).all(userId, tenantId, String(status), safeLimit)
                : db.prepare(
                    "SELECT * FROM coding_approvals WHERE owner_user_id = ? AND tenant_id = ? ORDER BY requested_at DESC LIMIT ?",
                ).all(userId, tenantId, safeLimit));
        return rows.map(toApproval);
    }

    /**
     * Owner-only decision. Approving records intent; it does NOT execute the
     * action in R0 (the runner/executor consume the transcript in R1/R2).
     */
    decide(scope, approvalId, { approve = true, decidedBy = null, reason = null } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "approval");
        const id = String(approvalId);
        const approval = db.prepare(
            "SELECT * FROM coding_approvals WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(id, userId, tenantId);
        if (!approval) throw codingError("NOT_FOUND", "approval not found", 404);
        if (approval.status === "expired") throw codingError("APPROVAL_EXPIRED", "approval has expired", 409);
        if (approval.status !== "requested") throw codingError("APPROVAL_DECIDED", `approval is already ${approval.status}`, 409);
        if (approval.expires_at && approval.expires_at <= new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")) {
            db.prepare("UPDATE coding_approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
            this._append({ userId, tenantId }, approval.run_id, {
                type: "approval.expired", payload: { approvalId: id, actionId: approval.action_id },
            });
            throw codingError("APPROVAL_EXPIRED", "approval has expired", 409);
        }

        const nextStatus = approve ? "approved" : "denied";
        const decidedAt = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
        const decidedByClean = decidedBy == null ? userId : Number(decidedBy);
        const reasonClean = reason == null ? null : cleanText(reason, 500);
        db.prepare(
            `UPDATE coding_approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ?
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`,
        ).run(nextStatus, decidedByClean, decidedAt, reasonClean, id, userId, tenantId);
        db.prepare(
            `UPDATE coding_actions SET status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`,
        ).run(nextStatus === "approved" ? "approved" : "denied", approval.action_id, userId, tenantId);

        const eventType = approve ? "approval.approved" : "approval.denied";
        this._append({ userId, tenantId }, approval.run_id, {
            type: eventType, payload: { approvalId: id, actionId: approval.action_id, decidedBy: decidedByClean },
        });
        this._append({ userId, tenantId }, approval.run_id, {
            type: "action.decided", payload: { actionId: approval.action_id, status: nextStatus, approvalId: id },
        });
        return {
            approval: this.getApproval({ userId, tenantId }, id),
            action: this._getAction({ userId, tenantId }, approval.action_id),
        };
    }

    /**
     * R2 — Atomically claim an APPROVED action for execution. Exactly one caller
     * wins (single UPDATE … WHERE status='approved'): concurrent resumes/reconnects
     * can never run the same side effect twice. Returns a claim verdict; execution
     * must call `completeAction` to settle it.
     *
     * @returns {{ claimed: boolean, reason: string }}
     */
    claimActionExecution(scope, actionId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "action");
        const id = String(actionId);
        const changed = db.prepare(
            `UPDATE coding_actions SET status = 'executing', updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'approved'`,
        ).run(id, userId, tenantId).changes;
        if (changed) {
            const row = db.prepare(
                "SELECT run_id FROM coding_actions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
            ).get(id, userId, tenantId);
            this._append({ userId, tenantId }, row.run_id, {
                type: "action.executing", payload: { actionId: id },
            });
            return { claimed: true, reason: "claimed" };
        }
        const current = db.prepare(
            "SELECT status FROM coding_actions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(id, userId, tenantId);
        if (!current) throw codingError("NOT_FOUND", "action not found", 404);
        if (current.status === "executing" || current.status === "executed" || current.status === "failed") {
            return { claimed: false, reason: "already_settled" };
        }
        if (current.status === "requested") return { claimed: false, reason: "not_approved" };
        if (current.status === "denied") return { claimed: false, reason: "denied" };
        return { claimed: false, reason: current.status };
    }

    /**
     * R2 — Settle a claimed (executing) action: `executed` (with optional artifact)
     * or `failed` (with errorCode). No-op when the action is already settled.
     */
    completeAction(scope, actionId, { ok = true, errorCode = null, artifactId = null } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "action");
        const id = String(actionId);
        const runRow = db.prepare(
            "SELECT run_id, status FROM coding_actions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(id, userId, tenantId);
        if (!runRow) throw codingError("NOT_FOUND", "action not found", 404);
        if (runRow.status === "executed" || runRow.status === "failed") return this._getAction({ userId, tenantId }, id);

        const changed = db.prepare(
            `UPDATE coding_actions
             SET status = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'executing'`,
        ).run(ok ? "executed" : "failed", ok ? null : String(errorCode || "EXECUTION_FAILED").slice(0, 128), id, userId, tenantId).changes;
        if (!changed) {
            // Action was not in 'executing' (e.g. denied meanwhile) — leave as is.
            return this._getAction({ userId, tenantId }, id);
        }
        this._append({ userId, tenantId }, runRow.run_id, {
            type: ok ? "action.executed" : "action.exec_failed",
            payload: { actionId: id, artifactId: artifactId || null, errorCode: ok ? null : errorCode || null },
        });
        return this._getAction({ userId, tenantId }, id);
    }

    /** Actions that were owner-approved but not yet claimed/settled (resume candidates). */
    pendingApprovedActions(scope, runId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "action");
        return db.prepare(
            `SELECT * FROM coding_actions
             WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'approved'
             ORDER BY seq ASC`,
        ).all(String(runId), userId, tenantId).map(toAction);
    }
}

export const defaultApprovalService = new ApprovalService();
export default defaultApprovalService;
