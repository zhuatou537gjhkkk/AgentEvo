/**
 * Phase 7 / R4 — durable RAG telemetry.
 *
 * roadmap R4 DoD: "hit/no-match/groundedness/index latency 可观测". Every durable
 * retrieval records one append-only, owner-scoped row in `knowledge_query_log`
 * and prints a compact console metric line (same spirit as the legacy
 * `[rag][scores]` log). Aggregates are owner-scoped so one tenant never sees
 * another's hit/miss rates.
 *
 * `status` ∈ hit | no_match | error — distinguishing a healthy no-match from a
 * backend failure is the R4 DoD contract; `source` records which retriever
 * produced the items (lexical | embedding | hybrid | memory | dual | canary).
 */
import db, { initDB } from "../db/index.js";
import { normalizeKnowledgeScope } from "./knowledgeStore.js";

let ensured = false;
function ensureSchema() {
    if (!ensured) {
        initDB();
        ensured = true;
    }
}

export function recordKnowledgeQuery({
    scope, projectId = null, mode = "durable", status = "hit", source = "hybrid",
    items = 0, latencyMs = 0, groundedness = null, query = "",
} = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const statusValue = ["hit", "no_match", "error"].includes(status) ? status : "error";
    db.prepare(`
        INSERT INTO knowledge_query_log
        (owner_user_id, tenant_id, project_id, mode, status, source, items, latency_ms, groundedness, query_preview)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ownerUserId, tenantId,
        projectId == null || projectId === "" ? null : String(projectId).slice(0, 120),
        String(mode).slice(0, 32) || "durable",
        statusValue,
        String(source || "").slice(0, 32),
        Number(items) | 0,
        Math.max(0, Number(latencyMs) || 0),
        groundedness == null ? null : Math.max(0, Math.min(1, Number(groundedness) || 0)),
        String(query || "").slice(0, 120),
    );
    const line = `[rag][${mode}] ${statusValue}${source ? `/${source}` : ""} items=${Number(items) | 0} latencyMs=${Math.round((Number(latencyMs) || 0) * 100) / 100}${groundedness == null ? "" : ` groundedness=${Math.round((Number(groundedness) || 0) * 100) / 100}`}${projectId ? ` project=${projectId}` : ""}`;
    console.log(line);
}

/**
 * Owner-scoped aggregate over the last `windowMinutes` (default all-time when 0).
 * @returns {{ total, hit, noMatch, error, hitRate, avgLatencyMs, avgGroundedness }}
 */
export function getKnowledgeQuerySummary(scope, { windowMinutes = 0 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const row = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hit,
            SUM(CASE WHEN status = 'no_match' THEN 1 ELSE 0 END) AS noMatch,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            AVG(latency_ms) AS avgLatencyMs,
            AVG(groundedness) AS avgGroundedness
        FROM knowledge_query_log
        WHERE owner_user_id = ? AND tenant_id = ?
          AND (? <= 0 OR created_at >= datetime('now', '-' || ? || ' minutes'))
    `).get(ownerUserId, tenantId, Number(windowMinutes) || 0, Number(windowMinutes) || 0);
    const total = Number(row?.total || 0);
    const hit = Number(row?.hit || 0);
    const noMatch = Number(row?.noMatch || 0);
    const error = Number(row?.error || 0);
    return {
        total,
        hit,
        noMatch,
        error,
        hitRate: total > 0 ? hit / total : 0,
        avgLatencyMs: Number(row?.avgLatencyMs || 0),
        avgGroundedness: row?.avgGroundedness == null ? null : Number(row.avgGroundedness),
    };
}

export function getRecentKnowledgeQueries(scope, { limit = 30 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    return db.prepare(`
        SELECT id, project_id, mode, status, source, items, latency_ms, groundedness, query_preview, created_at
        FROM knowledge_query_log
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY id DESC LIMIT ?
    `).all(ownerUserId, tenantId, Math.max(1, Number(limit) | 0));
}

export default { recordKnowledgeQuery, getKnowledgeQuerySummary, getRecentKnowledgeQueries };
