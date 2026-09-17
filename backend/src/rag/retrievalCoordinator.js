/**
 * K12 — project-code RAG × uploaded knowledge retrieval coordinator.
 *
 * Retrieval remains physically and logically split: each loader receives the
 * same authenticated scope, and only the query text is shared. This module
 * normalizes already-authorized results into cross-source ContextPackets,
 * deduplicates identical evidence, applies the existing fair budget policy,
 * and formats source-specific citations for the existing knowledge agent.
 */
import crypto from "node:crypto";
import { estimateTokens } from "../services/chatUtils.js";
import { selectCrossSourceCandidates } from "../services/crossSourceRecall.js";
import { ContextPacket } from "../services/contextBuilder.js";
import { retrieveProjectCode } from "./retrieval.js";
import { retrieveUploadedKnowledge } from "./uploadRetrieval.js";
import { createDefaultQueryRewriter, normalizeQueryPlan, runQueryRewrite } from "./queryRewrite.js";
import { ragContextualQueryRewriteEnabled, ragQueryRewriteEnabled } from "./flags.js";
import { recordKnowledgeQuery } from "./telemetry.js";

const DEFAULT_MAX_SOURCE_ITEMS = 8;
const MAX_SOURCE_ITEMS = 20;

function bounded(value, fallback, max = MAX_SOURCE_ITEMS) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(max, Math.trunc(number)));
}

function safeScore(value, fallback = 0.5) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function sourceText(item) {
    return String(item?.contextContent ?? item?.compressedContent ?? item?.content ?? item?.parentContent ?? "").trim();
}

function sourceId(item, fallback) {
    return String(item?.chunkId ?? item?.chunk_id ?? item?.id ?? item?.documentId ?? item?.document_id ?? fallback);
}

function hashContent(content) {
    return crypto.createHash("sha256").update(String(content)).digest("hex").slice(0, 24);
}

function projectPacket(item, index, projectId) {
    const content = sourceText(item);
    const id = sourceId(item, `project-${index}`);
    const provenance = {
        sourceType: "rag",
        sourceId: id,
        projectId: projectId == null ? null : String(projectId),
        file: item?.provenance?.file ?? item?.filePath ?? item?.file_path ?? null,
        startLine: item?.provenance?.startLine ?? item?.startLine ?? item?.start_line ?? null,
        endLine: item?.provenance?.endLine ?? item?.endLine ?? item?.end_line ?? null,
        commit: item?.provenance?.commit ?? item?.commit ?? null,
        revisionId: item?.revisionId ?? item?.revision_id ?? null,
    };
    const metadata = {
        type: "rag",
        source: "project_code_rag",
        sourceType: "rag",
        projectId: projectId == null ? null : String(projectId),
        chunkId: item?.chunkId ?? null,
        documentId: item?.documentId ?? item?.document_id ?? null,
        confidence: safeScore(item?.confidence, 0.9),
        provenance,
    };
    const packet = new ContextPacket({
        content,
        tokenCount: Math.max(1, Number(item?.tokenCount) || estimateTokens(content)),
        relevanceScore: safeScore(item?.relevanceScore ?? item?.score ?? item?.rawEvidenceScore),
        metadata,
    });
    return Object.assign(packet, item, {
        content,
        tokenCount: packet.tokenCount,
        relevanceScore: packet.relevanceScore,
        metadata: packet.metadata,
        sourceType: "rag",
        sourceId: id,
        provenance,
    });
}

function knowledgePacket(item, index) {
    const content = sourceText(item);
    const id = sourceId(item, `knowledge-${index}`);
    const provenance = {
        sourceType: "knowledge",
        sourceId: id,
        documentId: item?.documentId ?? item?.document_id ?? null,
        file: item?.filePath ?? item?.file_path ?? null,
        fileName: item?.fileName ?? item?.file_name ?? null,
        pageStart: item?.pageStart ?? item?.page_start ?? item?.parentPageStart ?? null,
        pageEnd: item?.pageEnd ?? item?.page_end ?? item?.parentPageEnd ?? null,
        headingPath: Array.isArray(item?.headingPath) ? item.headingPath : [],
        revisionId: item?.revisionId ?? item?.revision_id ?? null,
    };
    const metadata = {
        type: "knowledge",
        source: "uploaded_knowledge",
        sourceType: "knowledge",
        chunkId: item?.chunkId ?? null,
        documentId: item?.documentId ?? item?.document_id ?? null,
        confidence: safeScore(item?.confidence, 0.9),
        provenance,
    };
    const packet = new ContextPacket({
        content,
        tokenCount: Math.max(1, Number(item?.tokenCount) || estimateTokens(content)),
        relevanceScore: safeScore(item?.relevanceScore ?? item?.score ?? item?.rawEvidenceScore),
        metadata,
    });
    return Object.assign(packet, item, {
        content,
        tokenCount: packet.tokenCount,
        relevanceScore: packet.relevanceScore,
        metadata: packet.metadata,
        sourceType: "knowledge",
        sourceId: id,
        provenance,
    });
}

function normalizeLoaderResult(value, sourceType) {
    if (!value || typeof value !== "object") {
        return { status: "error", items: [], errorCode: "SOURCE_INVALID_RESULT" };
    }
    return {
        status: value.status === "ok" ? "ok" : value.status === "no_match" ? "no_match" : "error",
        items: Array.isArray(value.items) ? value.items : [],
        errorCode: value.status === "error" ? String(value.errorCode || `${sourceType.toUpperCase()}_UNAVAILABLE`).slice(0, 80) : null,
        metrics: value.metrics || null,
        mode: value.mode || null,
    };
}

function dedupePackets(packets) {
    const seen = new Set();
    const output = [];
    let deduped = 0;
    for (const packet of packets) {
        const content = String(packet?.content || "").trim();
        if (!content) continue;
        const key = hashContent(content);
        if (seen.has(key)) {
            deduped += 1;
            continue;
        }
        seen.add(key);
        output.push(packet);
    }
    return { packets: output, deduped };
}

function pageLabel(provenance) {
    const start = provenance?.pageStart;
    const end = provenance?.pageEnd;
    if (start == null && end == null) return "";
    if (start != null && end != null && Number(start) !== Number(end)) return ` p.${start}-${end}`;
    return ` p.${start ?? end}`;
}

function projectCitation(provenance) {
    const file = provenance?.file || "unknown-file";
    const start = provenance?.startLine ?? "?";
    const end = provenance?.endLine ?? start;
    const commit = provenance?.commit ? ` @ ${String(provenance.commit).slice(0, 40)}` : "";
    return `[项目代码: ${file}:${start}-${end}${commit}]`;
}

function knowledgeCitation(provenance) {
    const file = provenance?.fileName || provenance?.file || "unknown-document";
    const heading = Array.isArray(provenance?.headingPath) && provenance.headingPath.length > 0
        ? ` · ${provenance.headingPath.join(" > ")}`
        : "";
    return `[知识库文档: ${file}${pageLabel(provenance)}${heading}]`;
}

export function buildCrossSourceCitationText(items = [], { limitChars = 10000 } = {}) {
    const lines = [];
    for (const item of items) {
        const provenance = item?.metadata?.provenance || item?.provenance || {};
        const citation = item?.sourceType === "knowledge" || item?.metadata?.sourceType === "knowledge"
            ? knowledgeCitation(provenance)
            : projectCitation(provenance);
        lines.push(citation);
        lines.push(String(item?.content || "").slice(0, 1000));
    }
    const text = lines.filter(Boolean).join("\n");
    const cap = Math.max(500, Number(limitChars) || 10000);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function sourceSummary(result) {
    return {
        status: result.status,
        candidates: result.items.length,
        errorCode: result.errorCode,
        mode: result.mode,
    };
}

/**
 * Run both authorized sources concurrently and select a bounded unified set.
 * Inject `deps.projectRetrieval`/`deps.knowledgeRetrieval` in tests or a
 * controlled caller; production defaults use the existing retrieval facades.
 */
export async function retrieveAcrossSources({ scope, projectId, query, deps = {}, opts = {} } = {}) {
    const started = Date.now();
    const sourceLimit = bounded(opts.sourceTopK, DEFAULT_MAX_SOURCE_ITEMS);
    const projectLoader = deps.projectRetrieval || retrieveProjectCode;
    const knowledgeLoader = deps.knowledgeRetrieval || retrieveUploadedKnowledge;
    const originalQuery = String(query || "").trim();
    const rewriteEnabled = ragQueryRewriteEnabled() && opts.skipQueryRewrite !== true;
    const rewriteProvider = deps.queryRewriter !== undefined
        ? deps.queryRewriter
        : deps.projectDeps?.queryRewriter !== undefined
            ? deps.projectDeps.queryRewriter
            : deps.knowledgeDeps?.queryRewriter;
    const queryPlan = opts.queryPlan
        ? normalizeQueryPlan(opts.queryPlan, originalQuery)
        : rewriteEnabled
            ? await runQueryRewrite({
                query: originalQuery,
                enabled: true,
                provider: rewriteProvider === undefined ? createDefaultQueryRewriter() : rewriteProvider,
                context: opts.rewriteContext || null,
                contextualEnabled: ragContextualQueryRewriteEnabled(),
                signal: opts.signal || null,
                timeoutMs: opts.queryRewriteTimeoutMs,
            })
            : null;
    const commonOpts = {
        ...opts,
        topK: sourceLimit,
        signal: opts.signal || null,
        // The coordinator owns the combined telemetry row. Source loaders
        // still return their metrics, but must not emit duplicate rows.
        skipTelemetry: true,
        ...(queryPlan ? { queryPlan } : {}),
    };
    const [projectSettled, knowledgeSettled] = await Promise.allSettled([
        projectLoader({ scope, projectId, query: originalQuery, deps: deps.projectDeps || {}, opts: commonOpts }),
        knowledgeLoader({ scope, query: originalQuery, deps: deps.knowledgeDeps || {}, opts: commonOpts }),
    ]);

    const project = projectSettled.status === "fulfilled"
        ? normalizeLoaderResult(projectSettled.value, "project_code")
        : { status: "error", items: [], errorCode: "PROJECT_RAG_QUERY_FAILED", metrics: null, mode: null };
    const knowledge = knowledgeSettled.status === "fulfilled"
        ? normalizeLoaderResult(knowledgeSettled.value, "knowledge")
        : { status: "error", items: [], errorCode: "KNOWLEDGE_RAG_QUERY_FAILED", metrics: null, mode: null };

    const rawPackets = [
        ...project.items.map((item, index) => projectPacket(item, index, projectId)),
        ...knowledge.items.map((item, index) => knowledgePacket(item, index)),
    ];
    const dedupe = dedupePackets(rawPackets);
    const selection = selectCrossSourceCandidates(dedupe.packets, {
        maxItems: opts.maxItems,
        maxTokens: opts.maxTokens,
        minScore: opts.minScore,
        sourceCaps: opts.sourceCaps,
        scoreWeights: opts.scoreWeights,
    });
    const healthySources = [project, knowledge].filter((result) => result.status !== "error").length;
    const selected = selection.selected;
    const status = selected.length > 0
        ? "ok"
        : healthySources > 0
            ? "no_match"
            : "error";
    const errors = {};
    if (project.status === "error") errors.project_code = { code: project.errorCode };
    if (knowledge.status === "error") errors.knowledge = { code: knowledge.errorCode };
    const rewrite = project.metrics?.rewrite || knowledge.metrics?.rewrite || (queryPlan && {
        enabled: rewriteEnabled,
        ...queryPlan,
    }) || null;
    const metrics = {
        sourceTopK: sourceLimit,
        deduped: dedupe.deduped,
        selectedTokens: selection.selectedTokens,
        bySource: selection.bySource,
        sources: {
            project_code: sourceSummary(project),
            knowledge: sourceSummary(knowledge),
        },
        rewrite,
        llmCalls: Number(rewrite?.calls || 0)
            + Number(project.metrics?.rerankCalls || 0)
            + Number(knowledge.metrics?.rerankCalls || 0),
        selectedChunkIds: selected.map((item) => item?.chunkId ?? item?.sourceId).filter((id) => id != null).slice(0, 20),
        selectedDocumentIds: [...new Set(selected.map((item) => item?.documentId ?? item?.document_id).filter((id) => id != null))].slice(0, 20),
        healthySources,
        errors,
        selection: {
            scanned: selection.scanned,
            rejected: selection.rejected,
            dropped: selection.dropped.slice(0, 50),
            config: selection.config,
        },
    };
    if (opts.skipTelemetry !== true) {
        try {
            recordKnowledgeQuery({
                scope,
                projectId,
                mode: "cross_source",
                status: status === "ok" ? "hit" : status === "no_match" ? "no_match" : "error",
                source: "cross_source",
                items: selected.length,
                latencyMs: Date.now() - started,
                groundedness: selected.length > 0 ? selected[0]?.score ?? selected[0]?.relevanceScore ?? null : null,
                query: originalQuery,
                metrics,
            });
        } catch (error) {
            // Telemetry must never turn a successful cross-source answer into
            // a retrieval failure (test seams may not have a DB owner row).
        }
    }
    return {
        status,
        mode: "cross_source",
        text: buildCrossSourceCitationText(selected, { limitChars: opts.citationLimitChars }),
        items: selected,
        packets: selected,
        metrics,
        errorCode: status === "error" ? "CROSS_SOURCE_RETRIEVAL_FAILED" : null,
    };
}

export { dedupePackets, knowledgePacket, projectPacket };

export default { retrieveAcrossSources, buildCrossSourceCitationText };
