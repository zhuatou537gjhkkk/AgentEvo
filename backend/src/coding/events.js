/**
 * CodingEventStore — durable, owner-scoped, per-run monotonic event log.
 *
 * Run events are the single ordered record a coding run leaves behind. `seq` is
 * allocated from the run's persistent counter (coding_runs.event_seq) inside the
 * same transaction as the insert, so it is unique and monotonic even under
 * concurrent writers and never reuses a number after a row is deleted. Readers
 * use `afterSeq` (inclusive-exclusive) so `after=lastSeq` returns nothing — no
 * duplicates on replay.
 *
 * Scope is server-authenticated only. Payload is sanitized at the boundary so
 * secrets/provider errors never reach the row (see coding/util.js).
 */
import { randomUUID } from "node:crypto";
import db, { initDB } from "../db/index.js";
import { codingError, newId, nowSql, requireCodingScope, sanitizeStored } from "./util.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

// Events are strictly run-scoped (coding_events.run_id is NOT NULL). Project
// lifecycle is tracked on the coding_projects row itself, not as run events.
const EVENT_TYPES = new Set([
    "run.created", "run.started", "run.completed", "run.failed", "run.cancelled", "run.status",
    // R2 — disposable-worktree lifecycle + action execution transcript.
    "run.worktree_ready", "run.worktree_removed", "run.worktree_unsupported", "run.worktree_failed",
    "action.executed", "action.executing", "action.exec_failed", "action.auto_approved",
    "action.requested", "action.decided",
    "approval.requested", "approval.approved", "approval.denied", "approval.expired",
    // R5 (roadmap #2) — product Skills Runtime audit hooks. Skills only add
    // process/rules/knowledge; these two event types merely RECORD that a skill
    // was activated or denied for a run, they never grant tools or agents.
    "skill.activated", "skill.denied",
]);

function toEventRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        runId: row.run_id,
        seq: Number(row.seq),
        type: row.type,
        actor: row.actor,
        actionId: row.action_id,
        subTaskId: row.sub_task_id,
        causationId: row.causation_id,
        requestId: row.request_id,
        payload: (() => { try { return JSON.parse(row.payload); } catch { return {}; } })(),
        at: row.created_at,
    };
}

export class CodingEventStore {
    appendEvent(scope, runId, event = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "event");
        const type = String(event.type || "");
        if (!EVENT_TYPES.has(type)) {
            throw codingError("INVALID_EVENT_TYPE", `unsupported coding event type: ${type}`, 400);
        }
        const payload = sanitizeStored(event.payload ?? {});
        const actor = String(event.actor || "system").slice(0, 64);
        const actionId = event.actionId ? String(event.actionId).slice(0, 128) : null;
        const subTaskId = event.subTaskId ? String(event.subTaskId).slice(0, 128) : null;
        const causationId = event.causationId ? String(event.causationId).slice(0, 128) : null;
        const requestId = event.requestId ? String(event.requestId).slice(0, 128) : null;

        const write = db.transaction(() => {
            const run = db.prepare(
                "SELECT 1 AS found FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
            ).get(runId, userId, tenantId);
            if (!run) throw codingError("NOT_FOUND", "coding run not found", 404);
            const counter = db.prepare(
                "UPDATE coding_runs SET event_seq = event_seq + 1, updated_at = CURRENT_TIMESTAMP \
                 WHERE id = ? AND owner_user_id = ? AND tenant_id = ? RETURNING event_seq",
            ).get(runId, userId, tenantId);
            const seq = Number(counter.event_seq);
            const at = nowSql();
            const info = db.prepare(
                `INSERT INTO coding_events
                    (run_id, owner_user_id, tenant_id, seq, type, actor,
                     action_id, sub_task_id, causation_id, request_id, payload, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(runId, userId, tenantId, seq, type, actor, actionId, subTaskId, causationId, requestId, payload, at);
            return { id: info.lastInsertRowid, seq, at };
        });
        const { id, seq, at } = write();
        return { id, runId, seq, type, actor, actionId, subTaskId, causationId, requestId, payload: JSON.parse(payload), at };
    }

    /** Events strictly after `afterSeq`, ascending — replay-safe (no duplicates). */
    listEvents(scope, runId, { afterSeq = 0, limit = 200 } = {}) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "event");
        const safeAfter = Math.max(0, Number(afterSeq) || 0);
        const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
        const rows = db.prepare(
            `SELECT * FROM coding_events
             WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? AND seq > ?
             ORDER BY seq ASC LIMIT ?`,
        ).all(runId, userId, tenantId, safeAfter, safeLimit);
        return rows.map(toEventRow);
    }

    getLastSeq(scope, runId) {
        ensureSchema();
        const { userId, tenantId } = requireCodingScope(scope, "event");
        const row = db.prepare(
            "SELECT event_seq FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
        ).get(runId, userId, tenantId);
        return row ? Number(row.event_seq) : null;
    }

    /** Direct append used by approval flows (shares event rows, same seq space). */
    eventId() {
        return randomUUID();
    }
}

export const defaultEventStore = new CodingEventStore();
export default defaultEventStore;
