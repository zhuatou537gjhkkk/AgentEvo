import crypto from "node:crypto";
import db, { initDB } from "../db/index.js";
import {
    assertIngestStatusTransition,
    INGEST_STATUSES,
    isTerminalIngestStatus,
} from "./documentContract.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

function normalizeScope(scope) {
    const userId = Number(scope?.userId ?? scope?.ownerUserId ?? scope?.id);
    const tenantId = String(scope?.tenantId || `user:${userId}`);
    if (!Number.isInteger(userId) || userId <= 0 || !tenantId) {
        const error = new Error("ingest job requires an authenticated owner scope");
        error.code = "KNOWLEDGE_SCOPE_REQUIRED";
        throw error;
    }
    return { ownerUserId: userId, tenantId };
}

function parseJson(value, fallback) {
    try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function safeOptions(options = {}) {
    const allowed = ["modelVersion", "language", "enableFormula", "enableTable", "isOcr", "pageRanges", "pollIntervalMs"];
    return Object.fromEntries(allowed.filter((key) => options[key] != null).map((key) => [key, options[key]]));
}

function mapJob(row) {
    if (!row) return null;
    return {
        ...row,
        options: parseJson(row.options_json, {}),
        resultMeta: parseJson(row.result_meta_json, {}),
        retryable: Boolean(row.retryable),
    };
}

function assertJobId(jobId) {
    if (!/^ing_[A-Za-z0-9-]{10,120}$/.test(String(jobId || ""))) {
        const error = new Error("invalid ingest job id");
        error.code = "INGEST_JOB_ID_INVALID";
        throw error;
    }
}

function assertStatus(status) {
    if (!INGEST_STATUSES.includes(status)) {
        const error = new Error("invalid ingest status");
        error.code = "INGEST_STATUS_INVALID";
        throw error;
    }
}

export function newIngestJobId() {
    return `ing_${crypto.randomUUID()}`;
}

export function findDuplicateIngestJob(scope, { projectId = "uploaded-documents", fileHash, parser = "native", options = {} } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeScope(scope);
    if (!String(fileHash || "").trim()) return null;
    const row = db.prepare(`
        SELECT * FROM knowledge_ingest_jobs
        WHERE owner_user_id = ? AND tenant_id = ? AND project_id = ? AND file_hash = ? AND parser = ?
          AND status NOT IN ('cancelled')
        ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, created_at DESC
        LIMIT 1
    `).get(ownerUserId, tenantId, String(projectId), String(fileHash), String(parser));
    if (!row) return null;
    return JSON.stringify(safeOptions(parseJson(row.options_json, {}))) === JSON.stringify(safeOptions(options)) ? mapJob(row) : null;
}

export function createIngestJob({
    scope,
    id = newIngestJobId(),
    projectId = "uploaded-documents",
    sourceSessionId = null,
    fileName,
    storageKey,
    mimeType,
    fileHash,
    sizeBytes = 0,
    parser = "native",
    parserVersion = null,
    maxAttempts = 3,
    options = {},
} = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeScope(scope);
    assertJobId(id);
    if (!String(fileName || "").trim() || !String(storageKey || "").trim() || !String(fileHash || "").trim()) {
        const error = new Error("fileName, storageKey, and fileHash are required");
        error.code = "INGEST_JOB_FIELDS_REQUIRED";
        throw error;
    }
    const normalizedOptions = safeOptions(options);
    db.prepare(`
        INSERT INTO knowledge_ingest_jobs
        (id, owner_user_id, tenant_id, source_session_id, project_id, file_name, storage_key,
         mime_type, file_hash, size_bytes, parser, parser_version, status, max_attempts,
         next_attempt_at, options_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP, ?)
    `).run(
        id, ownerUserId, tenantId, sourceSessionId == null ? null : Number(sourceSessionId),
        String(projectId), String(fileName).slice(0, 240), String(storageKey), String(mimeType || "application/octet-stream").slice(0, 160),
        String(fileHash), Math.max(0, Number(sizeBytes) || 0), String(parser), parserVersion ? String(parserVersion) : null,
        Math.max(1, Math.min(20, Number(maxAttempts) || 3)), JSON.stringify(normalizedOptions),
    );
    return getIngestJob(scope, id);
}

export function getIngestJob(scope, jobId) {
    ensureSchema();
    assertJobId(jobId);
    const { ownerUserId, tenantId } = normalizeScope(scope);
    return mapJob(db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?").get(String(jobId), ownerUserId, tenantId));
}

export function listDueIngestJobs({ limit = 10 } = {}) {
    ensureSchema();
    return db.prepare(`
        SELECT * FROM knowledge_ingest_jobs
        WHERE status IN ('queued', 'failed', 'submitting', 'provider_uploading', 'provider_pending', 'provider_running', 'provider_converting', 'downloading', 'parsing', 'indexing')
          AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
          AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
        ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
        LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 10))).map(mapJob);
}

export function claimNextIngestJob({ leaseSeconds = 120, holderToken = crypto.randomUUID() } = {}) {
    ensureSchema();
    const seconds = Math.max(30, Math.min(3600, Number(leaseSeconds) || 120));
    const claim = db.transaction(() => {
        const row = db.prepare(`
            SELECT id, status FROM knowledge_ingest_jobs
            WHERE status IN ('queued', 'failed', 'submitting', 'provider_uploading', 'provider_pending', 'provider_running', 'provider_converting', 'downloading', 'parsing', 'indexing')
              AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
              AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
            ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
            LIMIT 1
        `).get();
        if (!row) return null;
        const result = db.prepare(`
            UPDATE knowledge_ingest_jobs
            SET lease_token = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
                attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP,
                heartbeat_at = CURRENT_TIMESTAMP,
                reclaim_count = reclaim_count + CASE WHEN lease_token IS NOT NULL AND lease_expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
                error_code = NULL, retryable = 0
            WHERE id = ? AND status = ?
              AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
        `).run(String(holderToken), seconds, row.id, row.status);
        return result.changes ? mapJob(db.prepare("SELECT * FROM knowledge_ingest_jobs WHERE id = ?").get(row.id)) : null;
    });
    return claim();
}

function ownedUpdate(jobId, holderToken, sql, params = []) {
    assertJobId(jobId);
    if (!String(holderToken || "").trim()) throw new Error("lease token is required");
    return db.prepare(`${sql} WHERE id = ? AND lease_token = ? AND lease_expires_at > CURRENT_TIMESTAMP`).run(...params, String(jobId), String(holderToken));
}

export function transitionIngestJob(jobId, holderToken, nextStatus, { progressCurrent, progressTotal, progressUnit } = {}) {
    ensureSchema();
    assertStatus(nextStatus);
    const current = db.prepare("SELECT status FROM knowledge_ingest_jobs WHERE id = ? AND lease_token = ?").get(String(jobId), String(holderToken));
    if (!current) return false;
    assertIngestStatusTransition(current.status, nextStatus);
    const sets = ["status = ?", "updated_at = CURRENT_TIMESTAMP"];
    const params = [nextStatus];
    if (progressCurrent != null) { sets.push("progress_current = ?"); params.push(Math.max(0, Number(progressCurrent) || 0)); }
    if (progressTotal != null) { sets.push("progress_total = ?"); params.push(Math.max(0, Number(progressTotal) || 0)); }
    if (progressUnit != null) { sets.push("progress_unit = ?"); params.push(String(progressUnit).slice(0, 40)); }
    return ownedUpdate(jobId, holderToken, `UPDATE knowledge_ingest_jobs SET ${sets.join(", ")}`, params).changes > 0;
}

export function renewIngestLease(jobId, holderToken, { leaseSeconds = 120 } = {}) {
    ensureSchema();
    const seconds = Math.max(30, Math.min(3600, Number(leaseSeconds) || 120));
    return ownedUpdate(jobId, holderToken, "UPDATE knowledge_ingest_jobs SET lease_expires_at = datetime('now', '+' || ? || ' seconds'), heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP", [seconds]).changes > 0;
}

export function updateIngestProvider(jobId, holderToken, { batchId, taskId = null, traceId = null } = {}) {
    ensureSchema();
    return ownedUpdate(jobId, holderToken, `UPDATE knowledge_ingest_jobs SET provider_batch_id = COALESCE(?, provider_batch_id), provider_task_id = COALESCE(?, provider_task_id), provider_trace_id = COALESCE(?, provider_trace_id), updated_at = CURRENT_TIMESTAMP`, [batchId || null, taskId, traceId]).changes > 0;
}

export function completeIngestJob(jobId, holderToken, { documentId, resultMeta = {} } = {}) {
    ensureSchema();
    return ownedUpdate(jobId, holderToken, `UPDATE knowledge_ingest_jobs SET status = 'ready', document_id = ?, result_meta_json = ?, progress_current = progress_total, error_code = NULL, retryable = 0, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [documentId || null, JSON.stringify(resultMeta)]).changes > 0;
}

export function failIngestJob(jobId, holderToken, { errorCode = "INGEST_FAILED", retryable = false, retryDelaySeconds = 30, resultMeta = {} } = {}) {
    ensureSchema();
    const job = db.prepare("SELECT attempt_count, max_attempts FROM knowledge_ingest_jobs WHERE id = ? AND lease_token = ?").get(String(jobId), String(holderToken));
    if (!job) return false;
    const canRetry = Boolean(retryable) && Number(job.attempt_count) < Number(job.max_attempts);
    const baseDelay = Math.max(1, Math.min(86400, Number(retryDelaySeconds) || 30));
    const backoffSeconds = Math.min(86400, baseDelay * (2 ** Math.max(0, Number(job.attempt_count || 1) - 1)));
    const params = [String(errorCode).slice(0, 100), canRetry ? 1 : 0, JSON.stringify(resultMeta), backoffSeconds];
    const sql = canRetry
        ? "UPDATE knowledge_ingest_jobs SET status = 'failed', error_code = ?, retryable = ?, result_meta_json = ?, last_backoff_seconds = ?, failure_count = failure_count + 1, next_attempt_at = datetime('now', '+' || ? || ' seconds'), lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP"
        : "UPDATE knowledge_ingest_jobs SET status = 'failed', error_code = ?, retryable = ?, result_meta_json = ?, last_backoff_seconds = ?, failure_count = failure_count + 1, next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP";
    if (canRetry) params.push(backoffSeconds);
    return db.prepare(`${sql} WHERE id = ? AND lease_token = ?`).run(...params, String(jobId), String(holderToken)).changes > 0;
}

export function cancelIngestJob(scope, jobId, { reason = "CANCELLED" } = {}) {
    ensureSchema();
    assertJobId(jobId);
    const { ownerUserId, tenantId } = normalizeScope(scope);
    return db.prepare(`UPDATE knowledge_ingest_jobs SET status = 'cancelled', error_code = ?, retryable = 0, lease_token = NULL, lease_expires_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status NOT IN ('ready', 'failed', 'cancelled')`).run(String(reason).slice(0, 100), String(jobId), ownerUserId, tenantId).changes > 0;
}

export function retryIngestJob(scope, jobId) {
    ensureSchema();
    assertJobId(jobId);
    const { ownerUserId, tenantId } = normalizeScope(scope);
    return db.prepare(`UPDATE knowledge_ingest_jobs SET status = 'queued', error_code = NULL, retryable = 0, next_attempt_at = CURRENT_TIMESTAMP, finished_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ? AND tenant_id = ? AND status = 'failed'`).run(String(jobId), ownerUserId, tenantId).changes > 0;
}

export function getIngestJobCounts(scope = null) {
    ensureSchema();
    const scopeValues = scope ? normalizeScope(scope) : null;
    const rows = scopeValues
        ? db.prepare("SELECT status, COUNT(*) AS count FROM knowledge_ingest_jobs WHERE owner_user_id = ? AND tenant_id = ? GROUP BY status").all(scopeValues.ownerUserId, scopeValues.tenantId)
        : db.prepare("SELECT status, COUNT(*) AS count FROM knowledge_ingest_jobs GROUP BY status").all();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

/** Aggregate operational counters without exposing file contents or provider payloads. */
export function getIngestOperationalMetrics(scope = null) {
    ensureSchema();
    const scopeValues = scope ? normalizeScope(scope) : null;
    const where = scopeValues ? "WHERE owner_user_id = ? AND tenant_id = ?" : "";
    const params = scopeValues ? [scopeValues.ownerUserId, scopeValues.tenantId] : [];
    return db.prepare(`
        SELECT COUNT(*) AS jobs,
               COALESCE(SUM(attempt_count), 0) AS attempts,
               COALESCE(SUM(failure_count), 0) AS failures,
               COALESCE(SUM(reclaim_count), 0) AS reclaims,
               COALESCE(SUM(CASE WHEN status IN ('queued','failed','submitting','provider_uploading','provider_pending','provider_running','provider_converting','downloading','parsing','indexing') THEN 1 ELSE 0 END), 0) AS active_or_pending
        FROM knowledge_ingest_jobs ${where}
    `).get(...params);
}

export { normalizeScope as normalizeIngestScope, mapJob as mapIngestJob };
export default { createIngestJob, getIngestJob, findDuplicateIngestJob, claimNextIngestJob, transitionIngestJob, renewIngestLease, updateIngestProvider, completeIngestJob, failIngestJob, cancelIngestJob, retryIngestJob, getIngestJobCounts, getIngestOperationalMetrics };
