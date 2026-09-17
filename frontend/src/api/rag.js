/** K11 knowledge-RAG telemetry and evaluation API. */
import { request } from "./chat.js";

const PROFILE_ORDER = ["lexical", "hybrid", "hybrid+rewrite", "hybrid+rerank", "full"];

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function percentile(values, ratio) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function isRagDisabledError(error) {
    return String(error?.errorCode || error?.code || "") === "RAG_FEATURE_DISABLED" || Number(error?.status) === 403;
}

export function normalizeRagTelemetry(payload) {
    const source = payload?.telemetry || {};
    const summary = source.summary || {};
    const recent = Array.isArray(source.recent) ? source.recent.slice(0, 100) : [];
    const latencies = recent.map((row) => Number(row.latency_ms ?? row.latencyMs)).filter(Number.isFinite);
    const sourceCounts = recent.reduce((result, row) => {
        result.lexical += finite(row.lexical_count ?? row.lexicalCount);
        result.vector += finite(row.embedding_count ?? row.embeddingCount);
        result.fusion += finite(row.fusion_count ?? row.fusionCount);
        return result;
    }, { lexical: 0, vector: 0, fusion: 0 });
    return {
        summary: {
            total: finite(summary.total),
            hit: finite(summary.hit),
            noMatch: finite(summary.noMatch ?? summary.no_match),
            error: finite(summary.error),
            hitRate: finite(summary.hitRate ?? summary.hit_rate),
            avgLatencyMs: finite(summary.avgLatencyMs ?? summary.avg_latency_ms),
            avgRerankLatencyMs: finite(summary.avgRerankLatencyMs ?? summary.avg_rerank_latency_ms),
            avgCompressionRatio: summary.avgCompressionRatio == null ? null : finite(summary.avgCompressionRatio),
            embeddingCalls: finite(summary.embeddingCalls ?? summary.embedding_calls),
            llmCalls: finite(summary.llmCalls ?? summary.llm_calls),
            rewriteApplied: finite(summary.rewriteApplied ?? summary.rewrite_applied),
            rerankApplied: finite(summary.rerankApplied ?? summary.rerank_applied),
            rerankFallback: finite(summary.rerankFallback ?? summary.rerank_fallback),
            fallbackCount: finite(summary.fallbackCount ?? summary.fallback_count),
        },
        recent: recent.map((row) => ({
            id: row.id,
            status: String(row.status || "unknown"),
            source: String(row.source || "unknown"),
            items: finite(row.items),
            latencyMs: finite(row.latency_ms ?? row.latencyMs),
            groundedness: row.groundedness == null ? null : finite(row.groundedness),
            createdAt: row.created_at || row.createdAt || null,
        })),
        recentP95LatencyMs: percentile(latencies, 0.95),
        recentSourceCounts: sourceCounts,
    };
}

export function normalizeRagEvalReport(payload) {
    const source = payload?.ragEval || payload?.report || {};
    const profiles = {};
    for (const name of PROFILE_ORDER) {
        const profile = source.profiles?.[name];
        if (!profile) continue;
        const summary = profile.summary || {};
        profiles[name] = {
            profile: name,
            sampleCount: finite(summary.sampleCount),
            recallAtK: summary.recallAtK == null ? null : finite(summary.recallAtK),
            mrr: summary.mrr == null ? null : finite(summary.mrr),
            ndcgAtK: summary.ndcgAtK == null ? null : finite(summary.ndcgAtK),
            citationPageAccuracy: summary.citationPageAccuracy == null ? null : finite(summary.citationPageAccuracy),
            faithfulness: summary.faithfulness == null ? null : finite(summary.faithfulness),
            p50LatencyMs: summary.p50LatencyMs == null ? null : finite(summary.p50LatencyMs),
            p95LatencyMs: summary.p95LatencyMs == null ? null : finite(summary.p95LatencyMs),
            tokenCount: finite(summary.tokenCount),
            callCount: finite(summary.callCount),
            avgCompressionRatio: summary.avgCompressionRatio == null ? null : finite(summary.avgCompressionRatio),
        };
    }
    return {
        available: source.available === true,
        reason: source.reason || null,
        datasetVersion: source.datasetVersion || null,
        modelAlias: source.modelAlias || null,
        gateStatus: source.gateStatus || "unknown",
        profiles,
        gates: source.gates || {},
    };
}

export async function fetchRagTelemetry({ windowMinutes = 0, limit = 20, signal } = {}) {
    const params = new URLSearchParams({ window_minutes: String(Math.max(0, Number(windowMinutes) || 0)), limit: String(Math.max(1, Math.min(100, Number(limit) || 20))) });
    const response = await request(`/rag/telemetry?${params.toString()}`, { method: "GET" }, { externalSignal: signal, retryCount: 0 });
    return response.json();
}

export async function fetchRagEvalReport({ signal } = {}) {
    const response = await request("/rag/eval-report", { method: "GET" }, { externalSignal: signal, retryCount: 0 });
    return response.json();
}

export { PROFILE_ORDER };

export default { fetchRagTelemetry, fetchRagEvalReport, normalizeRagTelemetry, normalizeRagEvalReport };
