/**
 * Shared durable retrieval facade for uploaded knowledge documents.
 *
 * Upload retrieval deliberately reuses the same lexical search, durable vector
 * adapter, and RRF fusion used by project retrieval. It only adds upload
 * policy: fixed project namespace, bounded candidate budgets, raw-evidence
 * gating, parent-context expansion, and document citations.
 */
import path from "node:path";
import { createOpenAiEmbedder } from "./embedder.js";
import * as knowledgeStore from "./knowledgeStore.js";
import { retrieveProjectCode } from "./retrieval.js";
import { getConfiguredVectorStore } from "./vectorStoreAdapter.js";
import { UPLOAD_DOC_PROJECT } from "./projectIds.js";
import { ragContextCompressionEnabled, ragRerankEnabled } from "./flags.js";
import { runRerank } from "./reranker.js";
import { createChatModelReranker } from "./chatModelRetrievalProvider.js";
import { compressContext } from "./contextCompression.js";
import { recordKnowledgeQuery } from "./telemetry.js";

const DEFAULT_TOP_K = 6;
const DEFAULT_LEXICAL_LIMIT = 20;
const DEFAULT_EMBEDDING_LIMIT = 20;
const MAX_TOP_K = 12;
const MAX_CANDIDATE_LIMIT = 40;

function bounded(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(max, Math.trunc(n)));
}

function normalizePreferredSource(source) {
    if (source == null || String(source).trim() === "") return null;
    const value = path.basename(String(source).trim());
    return value.length > 200 ? value.slice(0, 200) : value;
}

function defaultEmbedder() {
    const hasKey = Boolean(
        process.env.OPENAI_EMBEDDING_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.DASHSCOPE_API_KEY,
    );
    return hasKey ? createOpenAiEmbedder() : null;
}

function pageLabel(item) {
    const start = item.pageStart ?? item.page_start;
    const end = item.pageEnd ?? item.page_end;
    if (start == null && end == null) return "";
    if (start != null && end != null && Number(start) !== Number(end)) return ` p.${start}-${end}`;
    return ` p.${start ?? end}`;
}

function headingLabel(item) {
    const heading = Array.isArray(item.headingPath) ? item.headingPath.filter(Boolean).join(" > ") : "";
    return heading ? ` · ${heading}` : "";
}

function buildUploadCitationText(items, { limitChars = 6000 } = {}) {
    const lines = [];
    for (let index = 0; index < (items || []).length; index += 1) {
        const item = items[index];
        const source = item.fileName || item.filePath || `document-${index + 1}`;
        lines.push(`[${index + 1}] ${source}${pageLabel(item)}${headingLabel(item)}`);
        const context = String(item.contextContent ?? item.parentContent ?? "").trim();
        const compressed = String(item.compressedContent ?? "").trim();
        const leaf = String(item.content ?? "").trim();
        const content = [context || compressed || leaf, leaf && !(context || compressed).includes(leaf) ? leaf : ""]
            .filter(Boolean)
            .join("\n");
        if (content) lines.push(content.length > 1200 ? `${content.slice(0, 1200)}…` : content);
    }
    let text = lines.join("\n");
    const cap = Math.max(500, Number(limitChars) || 6000);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function expandParentContext(items, store, scope, { maxItems = 6, maxChars = 6000 } = {}) {
    if (!store || typeof store.getParentChunks !== "function") return items;
    let used = 0;
    return items.map((item) => {
        if (!item.parentChunkId || !item.documentId) return item;
        let parents = [];
        try {
            parents = store.getParentChunks(scope, item.documentId, { limit: 20 }) || [];
        } catch {
            return item;
        }
        const parent = parents.find((candidate) => String(candidate.id) === String(item.parentChunkId));
        if (!parent || used >= maxChars) return item;
        const remaining = Math.max(0, maxChars - used);
        const parentContent = String(parent.content || "").slice(0, Math.min(1200, remaining));
        used += parentContent.length;
        return {
            ...item,
            parentContent,
            contextContent: [parentContent, String(item.content || "")].filter(Boolean).join("\n"),
            parentHeadingPath: parent.headingPath || [],
            parentPageStart: parent.pageStart ?? null,
            parentPageEnd: parent.pageEnd ?? null,
        };
    }).slice(0, Math.max(1, maxItems));
}

/**
 * Retrieve uploaded documents with bounded hybrid recall.
 * `preferredSource` is a server-side filter, never a project selector.
 */
export async function retrieveUploadedKnowledge({
    scope,
    query,
    preferredSource = null,
    deps = {},
    opts = {},
} = {}) {
    const started = Date.now();
    const store = deps.store || knowledgeStore;
    const source = normalizePreferredSource(preferredSource ?? opts.preferredSource);
    const embedder = deps.embedder === undefined ? defaultEmbedder() : deps.embedder;
    const vectorStore = deps.vectorStore === undefined
        ? getConfiguredVectorStore({ scope, projectId: UPLOAD_DOC_PROJECT, store })
        : deps.vectorStore;
    const topK = bounded(opts.topK, DEFAULT_TOP_K, MAX_TOP_K);
    const lexicalLimit = bounded(opts.lexicalLimit, DEFAULT_LEXICAL_LIMIT, MAX_CANDIDATE_LIMIT);
    const embeddingLimit = bounded(opts.embeddingLimit, DEFAULT_EMBEDDING_LIMIT, MAX_CANDIDATE_LIMIT);
    const rerankEnabled = ragRerankEnabled();
    const retrievalTopK = rerankEnabled ? Math.max(topK, 12) : topK;
    const result = await retrieveProjectCode({
        scope,
        projectId: UPLOAD_DOC_PROJECT,
        query,
        deps: { store, embedder, vectorStore, queryRewriter: deps.queryRewriter },
        opts: {
            ...opts,
            topK: retrievalTopK,
            lexicalLimit,
            embeddingLimit,
            filePathFilter: source,
            requireRawEvidence: true,
            skipRerank: true,
            skipTelemetry: true,
        },
    });
    const rerankStarted = Date.now();
    const reranker = deps.reranker === undefined ? createChatModelReranker() : deps.reranker;
    const reranked = rerankEnabled
        ? await runRerank({
            query,
            candidates: result.items,
            provider: reranker ?? opts.reranker ?? null,
            signal: opts.signal ?? null,
            timeoutMs: opts.rerankTimeoutMs,
        })
        : {
            items: result.items,
            applied: false,
            fallback: false,
            reason: "disabled",
        };
    let items = reranked.items.slice(0, topK);
    const rerankLatencyMs = rerankEnabled ? Date.now() - rerankStarted : 0;
    items = expandParentContext(items, store, scope, {
        maxItems: topK,
        maxChars: bounded(opts.parentContextChars, 6000, 12000),
    });
    const compression = compressContext({
        query,
        candidates: items,
        enabled: ragContextCompressionEnabled(),
        perChunkChars: opts.perChunkChars,
        totalChars: opts.totalContextChars,
    });
    items = compression.items;
    const finalMetrics = {
        ...(result.metrics || {}),
        projectId: UPLOAD_DOC_PROJECT,
        preferredSource: source,
        parentContextItems: items.filter((item) => item.parentContent).length,
        rerankEnabled,
        rerankApplied: reranked.applied,
        rerankFallback: reranked.fallback,
        rerankFallbackReason: reranked.reason,
        fallbackCode: reranked.fallback ? reranked.reason : null,
        rerankCount: rerankEnabled ? result.items.length : 0,
        rerankLatencyMs,
        rerankModel: reranked.providerMeta?.model || reranker?.model || null,
        rerankCalls: Number(reranked.providerMeta?.calls) || (result.items.length > 0 && reranker ? 1 : 0),
        rerankUsage: reranked.providerMeta?.usage || null,
        llmCalls: Number(result.metrics?.rewrite?.calls || 0)
            + (Number(reranked.providerMeta?.calls) || (result.items.length > 0 && reranker ? 1 : 0)),
        selectedChunkIds: items.map((item) => item.chunkId).filter((id) => id != null).slice(0, 20),
        selectedDocumentIds: [...new Set(items.map((item) => item.documentId).filter((id) => id != null))].slice(0, 20),
        compression: compression.metrics,
    };
    if (opts.skipTelemetry !== true) {
        recordKnowledgeQuery({
            scope,
            projectId: UPLOAD_DOC_PROJECT,
            mode: result.mode,
            status: items.length > 0 ? "hit" : "no_match",
            source: result.mode,
            items: items.length,
            latencyMs: Date.now() - started,
            groundedness: items.length > 0 ? items[0].score : null,
            query,
            metrics: finalMetrics,
        });
    }
    return {
        ...result,
        status: items.length > 0 ? "ok" : "no_match",
        items,
        text: buildUploadCitationText(items, { limitChars: opts.citationLimitChars }),
        metrics: finalMetrics,
    };
}

export { buildUploadCitationText, normalizePreferredSource };

export default { retrieveUploadedKnowledge, buildUploadCitationText };
