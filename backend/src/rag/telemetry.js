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

function safeProjectLogLabel(projectId, faissTelemetry) {
    const value = String(projectId ?? "");
    if (!faissTelemetry) return value;
    return /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : "scoped";
}

export function recordKnowledgeQuery({
    scope, projectId = null, mode = "durable", status = "hit", source = "hybrid",
    items = 0, latencyMs = 0, groundedness = null, query = "", metrics = null,
} = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    const statusValue = ["hit", "no_match", "error"].includes(status) ? status : "error";
    const m = metrics && typeof metrics === "object" ? metrics : {};
    const compression = m.compression && typeof m.compression === "object" ? m.compression : m;
    const selectedItems = Array.isArray(m.selectedItems) ? m.selectedItems : [];
    const selectedChunkIds = (Array.isArray(m.selectedChunkIds)
        ? m.selectedChunkIds
        : selectedItems.map((item) => item?.chunkId ?? item?.id))
        .filter((id) => id != null).slice(0, 20);
    const selectedDocumentIds = [...new Set((Array.isArray(m.selectedDocumentIds)
        ? m.selectedDocumentIds
        : selectedItems.map((item) => item?.documentId ?? item?.document_id))
        .filter((id) => id != null))].slice(0, 20);
    const rewrite = m.rewrite && typeof m.rewrite === "object" ? m.rewrite : {};
    const rewriteContextUsed = Array.isArray(rewrite.contextUsed)
        ? rewrite.contextUsed.filter((source) => ["recent_turns", "summary", "working_memory"].includes(source)).slice(0, 3)
        : [];
    const rerankApplied = Boolean(m.rerankApplied);
    const rerankFallback = Boolean(m.rerankFallback);
    const rewriteCalls = Math.max(0, Number(rewrite.calls) || 0);
    const rerankCalls = Math.max(0, Number(m.rerankCalls) || 0);
    const rewriteUsage = rewrite.usage && typeof rewrite.usage === "object" ? rewrite.usage : {};
    const rerankUsage = m.rerankUsage && typeof m.rerankUsage === "object" ? m.rerankUsage : {};
    const llmCalls = Math.max(0, Number(m.llmCalls) || 0, rewriteCalls + rerankCalls);
    const llmInputTokens = Math.max(0, Number(rewriteUsage.input_tokens) || 0) + Math.max(0, Number(rerankUsage.input_tokens) || 0);
    const llmOutputTokens = Math.max(0, Number(rewriteUsage.output_tokens) || 0) + Math.max(0, Number(rerankUsage.output_tokens) || 0);
    // FAISS compare/read telemetry is an operational summary. Keep the legacy
    // query preview for lexical-only rows (backward-compatible), but do not
    // duplicate query text into FAISS-specific rows.
    const faissTelemetry = m.vectorBackend === "faiss"
        || m.faissCompareOverlap != null
        || m.faissCompareScoreDelta != null
        || m.faissFallbackCode != null;
    const queryPreview = faissTelemetry ? "" : String(query || "").slice(0, 120);
    db.prepare(`
        INSERT INTO knowledge_query_log
        (owner_user_id, tenant_id, project_id, mode, status, source, items, latency_ms, groundedness,
         lexical_count, embedding_count, fusion_count, rerank_count, rerank_latency_ms,
         compression_ratio, embedding_calls, embedding_latency_ms, embedding_error_code,
         rewrite_applied, rewrite_latency_ms, rewrite_model, rewrite_calls, rewrite_fallback, rewrite_fallback_code,
         rewrite_contextual, rewrite_context_used, rewrite_recent_turn_count, rewrite_summary_present,
         rewrite_working_memory_present, rewrite_context_tokens,
         rerank_applied, rerank_fallback, rerank_model, rerank_calls, llm_calls, llm_input_tokens, llm_output_tokens,
         served_mode, fallback_code,
         vector_backend, vector_search_latency_ms, vector_index_load_ms, vector_index_build_ms,
         vector_index_generation, vector_index_chunk_count, faiss_fallback_code, faiss_compare_overlap,
         faiss_compare_score_delta, faiss_compare_linear_latency_ms, faiss_compare_search_latency_ms,
         selected_chunk_ids, selected_document_ids, query_preview)
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?
        )
    `).run(
        ownerUserId, tenantId,
        projectId == null || projectId === "" ? null : String(projectId).slice(0, 120),
        String(mode).slice(0, 32) || "durable",
        statusValue,
        String(source || "").slice(0, 32),
        Number(items) | 0,
        Math.max(0, Number(latencyMs) || 0),
        groundedness == null ? null : Math.max(0, Math.min(1, Number(groundedness) || 0)),
        Math.max(0, Number(m.lexicalCount) || 0),
        Math.max(0, Number(m.embeddingCount) || 0),
        Math.max(0, Number(m.fusionCount) || 0),
        Math.max(0, Number(m.rerankCount) || 0),
        Math.max(0, Number(m.rerankLatencyMs) || 0),
        compression.ratio == null ? null : Math.max(0, Math.min(1, Number(compression.ratio) || 0)),
        Math.max(0, Number(m.embeddingCalls) || 0),
        Math.max(0, Number(m.embeddingLatencyMs) || 0),
        m.embeddingError == null ? null : String(m.embeddingError).slice(0, 64),
        rewrite.applied ? 1 : 0,
        Math.max(0, Number(rewrite.latencyMs) || 0),
        rewrite.model == null ? null : String(rewrite.model).slice(0, 120),
        rewriteCalls,
        rewrite.fallback ? 1 : 0,
        rewrite.reason == null ? null : String(rewrite.reason).slice(0, 64),
        rewrite.contextual ? 1 : 0,
        JSON.stringify(rewriteContextUsed),
        Math.max(0, Math.min(3, Number(rewrite.recentTurnCount) || 0)),
        rewrite.summaryPresent ? 1 : 0,
        rewrite.workingMemoryPresent ? 1 : 0,
        Math.max(0, Math.min(2000, Number(rewrite.contextTokens) || 0)),
        rerankApplied ? 1 : 0,
        rerankFallback ? 1 : 0,
        m.rerankModel == null ? null : String(m.rerankModel).slice(0, 120),
        rerankCalls,
        llmCalls,
        llmInputTokens,
        llmOutputTokens,
        m.servedMode == null ? null : String(m.servedMode).slice(0, 32),
        m.fallbackCode == null ? null : String(m.fallbackCode).slice(0, 64),
        m.vectorBackend == null ? null : String(m.vectorBackend).slice(0, 32),
        Math.max(0, Number(m.vectorSearchLatencyMs) || 0),
        Math.max(0, Number(m.vectorIndexLoadMs) || 0),
        Math.max(0, Number(m.vectorIndexBuildMs) || 0),
        Number.isSafeInteger(Number(m.vectorIndexGeneration)) ? Number(m.vectorIndexGeneration) : null,
        Math.max(0, Number(m.vectorIndexChunkCount) || 0),
        m.faissFallbackCode == null ? null : (/^FAISS_[A-Z0-9_]+$/.test(String(m.faissFallbackCode)) ? String(m.faissFallbackCode).slice(0, 64) : "FAISS_INDEX_UNAVAILABLE"),
        m.faissCompareOverlap == null ? null : Math.max(0, Math.min(1, Number(m.faissCompareOverlap) || 0)),
        m.faissCompareScoreDelta == null ? null : Math.max(0, Math.min(2, Number(m.faissCompareScoreDelta) || 0)),
        Math.max(0, Number(m.faissCompareLinearLatencyMs) || 0),
        Math.max(0, Number(m.faissCompareSearchLatencyMs) || 0),
        JSON.stringify(selectedChunkIds),
        JSON.stringify(selectedDocumentIds),
        queryPreview,
    );
    const projectLabel = safeProjectLogLabel(projectId, faissTelemetry);
    const line = `[rag][${mode}] ${statusValue}${source ? `/${source}` : ""} items=${Number(items) | 0} latencyMs=${Math.round((Number(latencyMs) || 0) * 100) / 100}${groundedness == null ? "" : ` groundedness=${Math.round((Number(groundedness) || 0) * 100) / 100}`}${projectLabel ? ` project=${projectLabel}` : ""}`;
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
            AVG(groundedness) AS avgGroundedness,
            AVG(rerank_latency_ms) AS avgRerankLatencyMs,
            AVG(compression_ratio) AS avgCompressionRatio,
            SUM(CASE WHEN fallback_code IS NOT NULL THEN 1 ELSE 0 END) AS fallbackCount,
            SUM(embedding_calls) AS embeddingCalls,
            SUM(embedding_latency_ms) AS embeddingLatencyMs,
            SUM(CASE WHEN embedding_error_code IS NOT NULL THEN 1 ELSE 0 END) AS embeddingFallback,
            SUM(llm_calls) AS llmCalls,
            SUM(CASE WHEN rewrite_applied = 1 THEN 1 ELSE 0 END) AS rewriteApplied,
            SUM(rewrite_calls) AS rewriteCalls,
            SUM(CASE WHEN rewrite_fallback = 1 THEN 1 ELSE 0 END) AS rewriteFallback,
            SUM(CASE WHEN rewrite_contextual = 1 THEN 1 ELSE 0 END) AS rewriteContextual,
            SUM(CASE WHEN rewrite_summary_present = 1 THEN 1 ELSE 0 END) AS rewriteSummaryPresent,
            SUM(CASE WHEN rewrite_working_memory_present = 1 THEN 1 ELSE 0 END) AS rewriteWorkingMemoryPresent,
            AVG(rewrite_context_tokens) AS avgRewriteContextTokens,
            SUM(CASE WHEN rerank_applied = 1 THEN 1 ELSE 0 END) AS rerankApplied,
            SUM(rerank_calls) AS rerankCalls,
            SUM(CASE WHEN rerank_fallback = 1 THEN 1 ELSE 0 END) AS rerankFallback,
            AVG(vector_search_latency_ms) AS vectorSearchLatencyMs,
            AVG(vector_index_load_ms) AS vectorIndexLoadMs,
            AVG(vector_index_build_ms) AS vectorIndexBuildMs,
            AVG(vector_index_chunk_count) AS vectorIndexChunkCount,
            AVG(faiss_compare_overlap) AS faissCompareOverlap,
            AVG(faiss_compare_score_delta) AS faissCompareScoreDelta,
            AVG(faiss_compare_linear_latency_ms) AS faissCompareLinearLatencyMs,
            AVG(faiss_compare_search_latency_ms) AS faissCompareSearchLatencyMs
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
        avgRerankLatencyMs: Number(row?.avgRerankLatencyMs || 0),
        avgCompressionRatio: row?.avgCompressionRatio == null ? null : Number(row.avgCompressionRatio),
        fallbackCount: Number(row?.fallbackCount || 0),
        embeddingCalls: Number(row?.embeddingCalls || 0),
        embeddingLatencyMs: Number(row?.embeddingLatencyMs || 0),
        embeddingFallback: Number(row?.embeddingFallback || 0),
        llmCalls: Number(row?.llmCalls || 0),
        rewriteApplied: Number(row?.rewriteApplied || 0),
        rewriteCalls: Number(row?.rewriteCalls || 0),
        rewriteFallback: Number(row?.rewriteFallback || 0),
        rewriteContextual: Number(row?.rewriteContextual || 0),
        rewriteSummaryPresent: Number(row?.rewriteSummaryPresent || 0),
        rewriteWorkingMemoryPresent: Number(row?.rewriteWorkingMemoryPresent || 0),
        avgRewriteContextTokens: Number(row?.avgRewriteContextTokens || 0),
        rerankApplied: Number(row?.rerankApplied || 0),
        rerankCalls: Number(row?.rerankCalls || 0),
        rerankFallback: Number(row?.rerankFallback || 0),
        vectorSearchLatencyMs: Number(row?.vectorSearchLatencyMs || 0),
        vectorIndexLoadMs: Number(row?.vectorIndexLoadMs || 0),
        vectorIndexBuildMs: Number(row?.vectorIndexBuildMs || 0),
        vectorIndexChunkCount: Number(row?.vectorIndexChunkCount || 0),
        faissCompareOverlap: row?.faissCompareOverlap == null ? null : Number(row.faissCompareOverlap),
        faissCompareScoreDelta: row?.faissCompareScoreDelta == null ? null : Number(row.faissCompareScoreDelta),
        faissCompareLinearLatencyMs: Number(row?.faissCompareLinearLatencyMs || 0),
        faissCompareSearchLatencyMs: Number(row?.faissCompareSearchLatencyMs || 0),
    };
}

export function getRecentKnowledgeQueries(scope, { limit = 30 } = {}) {
    ensureSchema();
    const { ownerUserId, tenantId } = normalizeKnowledgeScope(scope);
    return db.prepare(`
        SELECT id, project_id, mode, status, source, items, latency_ms, groundedness,
               lexical_count, embedding_count, fusion_count, rerank_count, rerank_latency_ms,
               compression_ratio, embedding_calls, embedding_latency_ms, embedding_error_code,
               rewrite_applied, rewrite_latency_ms, rewrite_model, rewrite_calls, rewrite_fallback, rewrite_fallback_code,
               rewrite_contextual, rewrite_context_used, rewrite_recent_turn_count, rewrite_summary_present,
               rewrite_working_memory_present, rewrite_context_tokens,
               rerank_applied, rerank_fallback, rerank_model, rerank_calls, llm_calls, llm_input_tokens, llm_output_tokens,
               served_mode, fallback_code,
               vector_backend, vector_search_latency_ms, vector_index_load_ms, vector_index_build_ms,
               vector_index_generation, vector_index_chunk_count, faiss_fallback_code, faiss_compare_overlap,
               faiss_compare_score_delta, faiss_compare_linear_latency_ms, faiss_compare_search_latency_ms,
               selected_chunk_ids, selected_document_ids, query_preview, created_at
        FROM knowledge_query_log
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY id DESC LIMIT ?
    `).all(ownerUserId, tenantId, Math.max(1, Number(limit) | 0));
}

export default { recordKnowledgeQuery, getKnowledgeQuerySummary, getRecentKnowledgeQueries };
