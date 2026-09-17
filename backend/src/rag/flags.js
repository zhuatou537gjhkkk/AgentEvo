/**
 * Phase 7 / R4 — durable knowledge / project RAG / project memory flags.
 *
 * Every getter reads `process.env` at call time (never import time), so tests
 * can flip a scenario per call and `clearRagFlags()` restores default-off.
 * All R4 capabilities are default OFF and roll back by unsetting the env var
 * (the durable store is additive; reads then fall back to the legacy in-memory
 * adapter untouched).
 *
 * Flag split (mirrors roadmap R4 checklist #9 + W5 hardening):
 *   - RAG_DURABLE_ENABLED  — durable *document* store infra: uploads are written
 *     to both the legacy in-memory adapter AND the durable DB store (dual-write)
 *     and read back through a dual-read compare while the canary is OFF.
 *   - DURABLE_RAG_READ     — canary switch: when ALSO set, reads are served from
 *     the durable index instead of the legacy memory adapter (rollback = unset).
 *   - PROJECT_RAG_ENABLED  — per-project *code* RAG: file-hash incremental index
 *     + hybrid lexical/embedding retrieval + knowledge/code agent reuse.
 *   - PROJECT_MEMORY_ENABLED — run working / project episodic / project semantic
 *     memory layers separated from the existing user-level agent_memory.
 *   - KNOWLEDGE_INGEST_V2 — asynchronous durable upload/parse/index lifecycle.
 *   - MINERU_PARSER_ENABLED — allow the opt-in MinerU parser adapter for PDF/images.
 *   - RAG_RERANK_ENABLED — optional second-stage reranking after hybrid recall.
 *   - RAG_QUERY_REWRITE_ENABLED — optional current-chat-model query expansion.
 *   - RAG_CONTEXTUAL_QUERY_REWRITE_ENABLED — optional recent-chat/working-state
 *     input for query expansion; it never replaces the original query.
 *   - RAG_CONTEXT_COMPRESSION_ENABLED — optional bounded extractive compression.
 *   - RAG_CROSS_SOURCE_COORDINATOR_ENABLED — opt-in project-code + upload
 *     knowledge retrieval coordinator used by the existing knowledge agent.
 *   - RAG_FAISS_ENABLED — allow durable FAISS index build/compare work.
 *   - RAG_FAISS_READ_ENABLED — allow durable retrieval to serve FAISS results.
 *   - RAG_FAISS_COMPARE_ENABLED — compare FAISS with durable linear recall while
 *     continuing to serve the linear result.
 *   - KNOWLEDGE_INGEST_WORKER_MODE — inline (default), external, or off.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export function durableRagEnabled() {
    return flagEnabled("RAG_DURABLE_ENABLED");
}

export function durableRagReadCanary() {
    return flagEnabled("DURABLE_RAG_READ");
}

export function projectRagEnabled() {
    return flagEnabled("PROJECT_RAG_ENABLED");
}

export function projectMemoryEnabled() {
    return flagEnabled("PROJECT_MEMORY_ENABLED");
}

export function knowledgeIngestV2Enabled() {
    return flagEnabled("KNOWLEDGE_INGEST_V2");
}

export function mineruParserEnabled() {
    return flagEnabled("MINERU_PARSER_ENABLED");
}

export function ragRerankEnabled() {
    return flagEnabled("RAG_RERANK_ENABLED");
}

export function ragQueryRewriteEnabled() {
    return flagEnabled("RAG_QUERY_REWRITE_ENABLED");
}

export function ragContextualQueryRewriteEnabled() {
    return flagEnabled("RAG_CONTEXTUAL_QUERY_REWRITE_ENABLED");
}

export function ragContextCompressionEnabled() {
    return flagEnabled("RAG_CONTEXT_COMPRESSION_ENABLED");
}

export function ragCrossSourceCoordinatorEnabled() {
    return flagEnabled("RAG_CROSS_SOURCE_COORDINATOR_ENABLED");
}

export function ragFaissEnabled() {
    return flagEnabled("RAG_FAISS_ENABLED");
}

export function ragFaissReadEnabled() {
    return flagEnabled("RAG_FAISS_READ_ENABLED");
}

export function ragFaissCompareEnabled() {
    return flagEnabled("RAG_FAISS_COMPARE_ENABLED");
}

export function knowledgeIngestWorkerMode() {
    const mode = String(process.env.KNOWLEDGE_INGEST_WORKER_MODE || "inline").trim().toLowerCase();
    return ["inline", "external", "off"].includes(mode) ? mode : "inline";
}

export const RAG_FLAG_NAMES = [
    "RAG_DURABLE_ENABLED",
    "DURABLE_RAG_READ",
    "PROJECT_RAG_ENABLED",
    "PROJECT_MEMORY_ENABLED",
    "KNOWLEDGE_INGEST_V2",
    "MINERU_PARSER_ENABLED",
    "RAG_RERANK_ENABLED",
    "RAG_QUERY_REWRITE_ENABLED",
    "RAG_CONTEXTUAL_QUERY_REWRITE_ENABLED",
    "RAG_CONTEXT_COMPRESSION_ENABLED",
    "RAG_CROSS_SOURCE_COORDINATOR_ENABLED",
    "RAG_FAISS_ENABLED",
    "RAG_FAISS_READ_ENABLED",
    "RAG_FAISS_COMPARE_ENABLED",
    "KNOWLEDGE_INGEST_WORKER_MODE",
];

export function clearRagFlags() {
    for (const name of RAG_FLAG_NAMES) {
        delete process.env[name];
    }
}

export default {
    durableRagEnabled,
    durableRagReadCanary,
    projectRagEnabled,
    projectMemoryEnabled,
    knowledgeIngestV2Enabled,
    mineruParserEnabled,
    ragRerankEnabled,
    ragQueryRewriteEnabled,
    ragContextualQueryRewriteEnabled,
    ragContextCompressionEnabled,
    ragCrossSourceCoordinatorEnabled,
    ragFaissEnabled,
    ragFaissReadEnabled,
    ragFaissCompareEnabled,
    knowledgeIngestWorkerMode,
    RAG_FLAG_NAMES,
    clearRagFlags,
};
