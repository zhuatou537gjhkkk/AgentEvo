/**
 * Phase 7 / R4 — hybrid code retrieval + citations + shared service.
 *
 * Roadmap R4 checklist #6 (lexical/path/symbol + embedding hybrid retrieval)
 * and the "shared retrieval service" contract that knowledge/code agents call
 * (roadmap R4 #7): no duplicated indexing, one fused read path.
 *
 * R4 DoD alignment:
 *   - lexical is always available (zero network); when an embedder + vector
 *     store are injected, embedding search is fused via reciprocal-rank-fusion
 *     and degrades to lexical-only on any embedding failure — an embedding
 *     failure never turns a healthy lexical hit into status 'error';
 *   - status 'no_match' (healthy empty) is distinct from backend failure: the
 *     only way hybridRetrieve surfaces 'error' is lexicalSearch itself
 *     throwing (wrapped with a classified error code);
 *   - every item carries `provenance { file, startLine, endLine, commit }` so
 *     buildCitationText emits valid `[n] file:start-end` citations.
 *
 * retrieveProjectCode() additionally records owner-scoped telemetry rows
 * (hit / no_match / error + groundedness + latency) via telemetry.js.
 */
import { classifyError } from "../services/resilience.js";
import { memoryContractEnabled } from "../services/memoryFlags.js";
import { buildProjectRetrievalProvenance } from "../services/memoryContract.js";
import { lexicalSearch } from "./lexical.js";
import { recordKnowledgeQuery } from "./telemetry.js";
import { createOpenAiEmbedder } from "./embedder.js";
import { getConfiguredVectorStore, getDurableVectorStore } from "./vectorStoreAdapter.js";
import { safeFaissErrorCode } from "./faissVectorStore.js";
import {
    ragFaissCompareEnabled,
    ragFaissEnabled,
    ragFaissReadEnabled,
    ragContextualQueryRewriteEnabled,
    ragQueryRewriteEnabled,
    ragRerankEnabled,
} from "./flags.js";
import { createChatModelReranker } from "./chatModelRetrievalProvider.js";
import { createDefaultQueryRewriter, normalizeQueryPlan, runQueryRewrite } from "./queryRewrite.js";
import { runRerank } from "./reranker.js";

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function exactCompoundTerms(query) {
    return [...new Set((String(query || "").match(/[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+/g) || []).map((value) => value.toLowerCase()))];
}

function toEmbeddingItem(hit) {
    return {
        chunkId: hit.chunkId ?? hit.id,
        documentId: hit.documentId ?? hit.document_id ?? null,
        filePath: hit.filePath ?? hit.file_path ?? null,
        fileName: hit.fileName ?? hit.file_name ?? null,
        chunkLevel: hit.chunkLevel ?? hit.chunk_level ?? "leaf",
        parentChunkId: hit.parentChunkId ?? hit.parent_chunk_id ?? null,
        pageStart: hit.pageStart ?? hit.page_start ?? null,
        pageEnd: hit.pageEnd ?? hit.page_end ?? null,
        headingPath: hit.headingPath ?? [],
        startLine: hit.startLine ?? hit.start_line ?? null,
        endLine: hit.endLine ?? hit.end_line ?? null,
        content: hit.content ?? "",
        symbols: hit.symbols ?? "",
        commit: hit.commit ?? hit.sourceCommit ?? hit.source_commit ?? null,
    };
}

function defaultProjectEmbedder() {
    const hasKey = Boolean(
        process.env.OPENAI_EMBEDDING_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.DASHSCOPE_API_KEY,
    );
    return hasKey ? createOpenAiEmbedder() : null;
}

function readVectorStats(vectorStore) {
    if (!vectorStore || typeof vectorStore.stats !== "function") return {};
    try {
        const stats = vectorStore.stats({ ensure: false }) || {};
        return {
            vectorBackend: stats.name || vectorStore.name || null,
            vectorIndexLoadMs: Math.max(0, Number(stats.loadLatencyMs) || 0),
            vectorIndexBuildMs: Math.max(0, Number(stats.buildLatencyMs) || 0),
            vectorIndexGeneration: Number.isSafeInteger(Number(stats.generation)) ? Number(stats.generation) : null,
            vectorIndexChunkCount: Math.max(0, Number(stats.chunkCount) || 0),
        };
    } catch {
        return { vectorBackend: vectorStore.name || null };
    }
}

function overlapSummary(linearHits, faissHits) {
    const linearIds = new Set((linearHits || []).map((item) => String(item?.chunkId ?? item?.id ?? "")));
    const faissIds = new Set((faissHits || []).map((item) => String(item?.chunkId ?? item?.id ?? "")));
    const overlapIds = [...linearIds].filter((id) => id && faissIds.has(id));
    const faissById = new Map((faissHits || []).map((item) => [String(item?.chunkId ?? item?.id ?? ""), Number(item?.score) || 0]));
    const linearById = new Map((linearHits || []).map((item) => [String(item?.chunkId ?? item?.id ?? ""), Number(item?.score) || 0]));
    const deltas = overlapIds.map((id) => Math.abs((linearById.get(id) || 0) - (faissById.get(id) || 0)));
    return {
        overlap: overlapIds.length,
        ratio: Math.min(linearIds.size, faissIds.size) > 0
            ? overlapIds.length / Math.min(linearIds.size, faissIds.size)
            : 1,
        scoreDelta: deltas.length ? Math.max(...deltas) : 0,
    };
}

async function compareDurableAndFaiss({ scope, projectId, store, vectorStore, queryVector, k, filter, linearHits, linearLatencyMs }) {
    if (!ragFaissEnabled() || !ragFaissCompareEnabled() || ragFaissReadEnabled()) return null;
    if (!vectorStore || !queryVector || vectorStore.name !== "durable") return null;
    const started = Date.now();
    let faissStore = null;
    try {
        faissStore = (await import("./faissVectorStore.js")).getFaissVectorStore({ scope, projectId, store });
        const faissHits = await faissStore.similaritySearch(queryVector, k, filter);
        const faissLatencyMs = Date.now() - started;
        const summary = overlapSummary(linearHits, faissHits);
        const stats = readVectorStats(faissStore);
        return {
            ...summary,
            linearLatencyMs: Math.max(0, Number(linearLatencyMs) || 0),
            faissLatencyMs,
            generation: stats.vectorIndexGeneration,
            chunkCount: stats.vectorIndexChunkCount,
            loadMs: stats.vectorIndexLoadMs,
            buildMs: stats.vectorIndexBuildMs,
            fallbackCode: null,
            faissStore,
        };
    } catch (error) {
        const stats = readVectorStats(faissStore);
        return {
            overlap: 0,
            ratio: 0,
            scoreDelta: null,
            linearLatencyMs: Math.max(0, Number(linearLatencyMs) || 0),
            faissLatencyMs: Math.max(0, Date.now() - started),
            generation: stats.vectorIndexGeneration,
            chunkCount: stats.vectorIndexChunkCount,
            loadMs: stats.vectorIndexLoadMs,
            buildMs: stats.vectorIndexBuildMs,
            fallbackCode: safeFaissErrorCode(error),
            faissStore,
        };
    }
}

function buildFilteredStore(store, filePathFilter) {
    return {
        getActiveChunks: (scope, projectId, opts = {}) =>
            store.getActiveChunks(scope, projectId, { ...(opts || {}), filePath: filePathFilter }),
    };
}

/**
 * Fuse lexical + embedding ranks using reciprocal-rank-fusion style scoring and
 * min-max normalize to 0..1.
 * @param {{item:object, lexRank:number|null, embRank:number|null}[]} entries
 */
export function fuseResults(entries, topK, contractContext = null) {
    for (const e of entries) {
        let raw = 0;
        if (e.lexRank) raw += 0.5 / e.lexRank;
        if (e.embRank) raw += 0.5 / e.embRank;
        e.rrf = raw;
    }
    const scores = entries.map((e) => e.rrf);
    const min = scores.length ? Math.min(...scores) : 0;
    const max = scores.length ? Math.max(...scores) : 0;
    const span = max - min;
    for (const e of entries) e.score = span > 0 ? (e.rrf - min) / span : 1;

    entries.sort((a, b) => b.score - a.score || String(a.item.chunkId ?? "").localeCompare(String(b.item.chunkId ?? "")));
    return entries.slice(0, Math.max(1, Number(topK) || 1)).map((e, index) => {
        const sources = [];
        if (e.lexRank) sources.push("lexical");
        if (e.embRank) sources.push("embedding");
        const item = e.item;
        const commit = item.commit ?? null;
        const result = {
            ...item,
            score: round6(e.score),
            lexicalScore: e.lexicalScore == null ? null : round6(e.lexicalScore),
            embeddingScore: e.embeddingScore == null ? null : round6(e.embeddingScore),
            rawEvidenceScore: Math.max(
                e.lexicalScore == null ? 0 : Number(e.lexicalScore) || 0,
                e.embeddingScore == null ? 0 : Number(e.embeddingScore) || 0,
            ),
            rank: index + 1,
            sources,
            provenance: {
                file: item.filePath,
                startLine: item.startLine,
                endLine: item.endLine,
                commit,
            },
        };
        if (memoryContractEnabled() && contractContext) {
            result.provenance = buildProjectRetrievalProvenance({
                item: result,
                scope: contractContext.scope,
                projectId: contractContext.projectId,
            });
            result.contractVersion = "memory-context-v2";
            result.sourceType = "project_memory";
            result.status = result.stale ? "stale" : "active";
        }
        return result;
    });
}

/**
 * Hybrid retrieval over one project's durable code chunks.
 * @param {object} args { scope, projectId, query, store?, embedder?,
 *   vectorStore?, opts? }
 *   - store: object with getActiveChunks(scope, projectId, opts) (defaults to
 *     the real knowledge store).
 *   - embedder/vectorStore: when either is null retrieval is lexical-only
 *     (mode 'lexical', embedding 'unavailable' via metrics).
 *   - opts: { topK = 8, lexicalLimit = 6, embeddingLimit = 6,
 *     filePathFilter = null, measure = true }.
 * @returns {{status:'ok'|'no_match', mode:string, items:object[],
 *   metrics:{lexicalCount,embeddingCount,embeddingError,groundedness}}}.
 *   Throws a classified AppError only if the lexical phase itself throws.
 */
export async function hybridRetrieve({ scope, projectId, query, store = null, embedder = null, vectorStore = null, opts = {} } = {}) {
    const o = opts || {};
    const topK = Number(o.topK) || 8;
    const lexicalLimit = Number(o.lexicalLimit) || 6;
    const embeddingLimit = Number(o.embeddingLimit) || 6;
    const filePathFilter = o.filePathFilter == null ? null : String(o.filePathFilter);
    const embeddingAttempted = Boolean(embedder && vectorStore);
    const metrics = {
        lexicalCount: 0,
        embeddingCount: 0,
        fusionCount: 0,
        embeddingCalls: 0,
        embeddingLatencyMs: 0,
        embeddingError: null,
        groundedness: null,
        vectorBackend: vectorStore?.name || null,
        vectorSearchLatencyMs: 0,
        vectorIndexLoadMs: 0,
        vectorIndexBuildMs: 0,
        vectorIndexGeneration: null,
        vectorIndexChunkCount: 0,
        faissFallbackCode: null,
        faissCompareOverlap: null,
        faissCompareScoreDelta: null,
        faissCompareLinearLatencyMs: 0,
        faissCompareSearchLatencyMs: 0,
    };

    // lexical phase (always available; a throw here is a real backend failure)
    let lexItems = [];
    try {
        const lexStore = store && filePathFilter != null ? buildFilteredStore(store, filePathFilter) : store;
        const lex = await lexicalSearch({ scope, projectId, query, store: lexStore, limit: lexicalLimit, candidateCap: 4000 });
        lexItems = lex.items || [];
    } catch (err) {
        throw classifyError(err);
    }
    metrics.lexicalCount = lexItems.length;

    // embedding phase (optional, guarded: never turns a lexical hit into error)
    let embHits = [];
    if (embeddingAttempted && String(query ?? "").trim().length > 0) {
        metrics.embeddingCalls = 1;
        const embeddingStarted = Date.now();
        try {
            const [queryVector] = await embedder.embed([String(query ?? "")]);
            const filter = filePathFilter != null
                ? (entry) => String(entry.filePath ?? "") === filePathFilter
                : null;
            const vectorStarted = Date.now();
            try {
                embHits = await vectorStore.similaritySearch(queryVector, embeddingLimit, filter);
            } catch (err) {
                if (vectorStore.name === "faiss") {
                    metrics.faissFallbackCode = safeFaissErrorCode(err);
                    const linearStore = getDurableVectorStore({ scope, projectId, store });
                    try {
                        embHits = await linearStore.similaritySearch(queryVector, embeddingLimit, filter);
                        metrics.vectorBackend = "durable";
                    } catch {
                        embHits = [];
                    }
                } else {
                    throw err;
                }
            }
            metrics.vectorSearchLatencyMs = Date.now() - vectorStarted;
            Object.assign(metrics, readVectorStats(metrics.vectorBackend === "durable"
                ? getDurableVectorStore({ scope, projectId, store })
                : vectorStore));
            const linearLatencyMs = metrics.vectorBackend === "durable" ? metrics.vectorSearchLatencyMs : 0;
            const compare = await compareDurableAndFaiss({
                scope,
                projectId,
                store,
                vectorStore,
                queryVector,
                k: embeddingLimit,
                filter,
                linearHits: embHits,
                linearLatencyMs,
            });
            if (compare) {
                metrics.faissCompareOverlap = compare.ratio;
                metrics.faissCompareScoreDelta = compare.scoreDelta;
                metrics.faissCompareLinearLatencyMs = compare.linearLatencyMs;
                metrics.faissCompareSearchLatencyMs = compare.faissLatencyMs;
                if (compare.fallbackCode) metrics.faissFallbackCode ||= compare.fallbackCode;
                metrics.vectorIndexGeneration = compare.generation ?? metrics.vectorIndexGeneration;
                metrics.vectorIndexChunkCount = compare.chunkCount || metrics.vectorIndexChunkCount;
                if (compare.loadMs != null) metrics.vectorIndexLoadMs = compare.loadMs;
                if (compare.buildMs != null) metrics.vectorIndexBuildMs = compare.buildMs;
            }
        } catch (err) {
            const classified = classifyError(err);
            metrics.embeddingError = classified.code && classified.code !== "INTERNAL_ERROR"
                ? classified.code
                : "EMBEDDING_UNAVAILABLE";
            embHits = [];
        } finally {
            metrics.embeddingLatencyMs = Date.now() - embeddingStarted;
        }
    }
    metrics.embeddingCount = embHits.length;

    const byId = new Map();
    lexItems.forEach((item, index) => byId.set(item.chunkId, {
        item,
        lexRank: index + 1,
        embRank: null,
        lexicalScore: Number(item.score) || 0,
        embeddingScore: null,
    }));
    embHits.forEach((hit, index) => {
        const existing = byId.get(hit.chunkId ?? hit.id);
        if (existing) {
            existing.embRank = index + 1;
            existing.embeddingScore = Number(hit.score) || 0;
        } else {
            byId.set(hit.chunkId ?? hit.id, {
                item: toEmbeddingItem(hit),
                lexRank: null,
                embRank: index + 1,
                lexicalScore: null,
                embeddingScore: Number(hit.score) || 0,
            });
        }
    });

    const fused = fuseResults([...byId.values()], Math.max(1, byId.size), { scope, projectId });
    const rawEvidenceEnabled = o.requireRawEvidence === true;
    const compoundTerms = exactCompoundTerms(query);
    const minLexicalScore = Number.isFinite(Number(o.minLexicalScore))
        ? Math.max(0, Number(o.minLexicalScore)) : 0.05;
    const minEmbeddingScore = Number.isFinite(Number(o.minEmbeddingScore))
        ? Math.max(-1, Number(o.minEmbeddingScore)) : 0.25;
    // Keep the pre-existing durable-linear contract byte-for-byte when the
    // FAISS reader is dark. FAISS nearest-neighbour results must additionally
    // prove lexical/embedding evidence so a populated index cannot turn an
    // unrelated query into a false positive (including linear fallback while
    // the FAISS canary is enabled).
    const requireEvidence = rawEvidenceEnabled || vectorStore?.name === "faiss" || ragFaissReadEnabled();
    const evidenceItems = fused.filter((item) => !requireEvidence || (
        compoundTerms.every((term) => String(item.content || "").toLowerCase().includes(term)) && (
            (item.lexicalScore != null && item.lexicalScore >= minLexicalScore)
            || (item.embeddingScore != null && item.embeddingScore >= minEmbeddingScore)
        )
    ));
    const items = evidenceItems.slice(0, Math.max(1, Number(topK) || 1));
    metrics.fusionCount = fused.length;

    const hasLex = lexItems.length > 0;
    const hasEmb = metrics.embeddingCount > 0;
    let mode = "lexical";
    if (embeddingAttempted && !metrics.embeddingError && hasEmb) {
        mode = hasLex ? "hybrid" : "embedding";
    }
    metrics.groundedness = items.length > 0 ? items[0].score : null;
    metrics.rawEvidenceRequired = rawEvidenceEnabled;
    metrics.rawEvidenceFiltered = rawEvidenceEnabled ? fused.length - evidenceItems.length : 0;
    metrics.selectedChunkIds = items.map((item) => item.chunkId).filter((id) => id != null).slice(0, 20);
    metrics.selectedDocumentIds = [...new Set(items.map((item) => item.documentId).filter((id) => id != null))].slice(0, 20);

    return {
        status: items.length > 0 ? "ok" : "no_match",
        mode,
        items,
        metrics,
    };
}

function shortCommit(commit) {
    if (!commit) return "";
    const c = String(commit);
    return c.length > 7 ? c.slice(0, 7) : c;
}

/**
 * Deterministic citation block:
 *   [n] filePath:startLine-endLine [@ shortCommit]
 *   <content truncated to ~300 chars with …>
 * @returns {string} '' when there are no items
 */
export function buildCitationText(items, { limitChars = 3000, prefix = null } = {}) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (list.length === 0) return "";
    const lines = [];
    for (let i = 0; i < list.length; i += 1) {
        const it = list[i];
        const file = it.filePath ?? it.file ?? it.provenance?.file;
        const commit = it.commit ?? it.sourceCommit ?? it.provenance?.commit ?? null;
        const hasLines = Number.isInteger(Number(it.startLine)) && Number(it.startLine) > 0
            && Number.isInteger(Number(it.endLine)) && Number(it.endLine) > 0;
        const location = hasLines ? `${file}:${it.startLine}-${it.endLine}` : String(file || "unknown");
        const header = `[${i + 1}] ${location}${commit ? ` @ ${shortCommit(commit)}` : ""}`;
        lines.push(header);
        const content = String(it.content ?? "").trim();
        if (content) {
            lines.push(content.length > 300 ? `${content.slice(0, 300)}…` : content);
        }
    }
    let block = lines.join("\n");
    if (prefix) block = `${prefix}\n${block}`;
    const capChars = Math.max(1, Number(limitChars) || 3000);
    if (block.length > capChars) {
        block = block.slice(0, capChars) + "…";
    }
    return block;
}

function mergeQueryResults(results = [], topK = 8) {
    const byId = new Map();
    const modes = new Set();
    let lexicalCount = 0;
    let embeddingCount = 0;
    let embeddingCalls = 0;
    let embeddingLatencyMs = 0;
    let fusionCount = 0;
    let embeddingError = null;
    let rawEvidenceRequired = false;
    let rawEvidenceFiltered = 0;
    let vectorSearchLatencyMs = 0;
    let vectorIndexLoadMs = 0;
    let vectorIndexBuildMs = 0;
    let vectorBackend = null;
    let vectorIndexGeneration = null;
    let vectorIndexChunkCount = 0;
    let faissFallbackCode = null;
    let faissCompareOverlap = null;
    let faissCompareScoreDelta = null;
    let faissCompareLinearLatencyMs = 0;
    let faissCompareSearchLatencyMs = 0;
    for (const [queryIndex, result] of results.entries()) {
        if (result?.mode) modes.add(result.mode);
        lexicalCount += Number(result?.metrics?.lexicalCount) || 0;
        embeddingCount += Number(result?.metrics?.embeddingCount) || 0;
        embeddingCalls += Number(result?.metrics?.embeddingCalls) || 0;
        embeddingLatencyMs += Number(result?.metrics?.embeddingLatencyMs) || 0;
        fusionCount += Number(result?.metrics?.fusionCount) || 0;
        embeddingError ||= result?.metrics?.embeddingError || null;
        rawEvidenceRequired ||= result?.metrics?.rawEvidenceRequired === true;
        rawEvidenceFiltered += Number(result?.metrics?.rawEvidenceFiltered) || 0;
        vectorSearchLatencyMs += Number(result?.metrics?.vectorSearchLatencyMs) || 0;
        vectorIndexLoadMs += Number(result?.metrics?.vectorIndexLoadMs) || 0;
        vectorIndexBuildMs += Number(result?.metrics?.vectorIndexBuildMs) || 0;
        vectorBackend ||= result?.metrics?.vectorBackend || null;
        if (result?.metrics?.vectorIndexGeneration != null) vectorIndexGeneration = Number(result.metrics.vectorIndexGeneration);
        vectorIndexChunkCount = Math.max(vectorIndexChunkCount, Number(result?.metrics?.vectorIndexChunkCount) || 0);
        faissFallbackCode ||= result?.metrics?.faissFallbackCode || null;
        if (result?.metrics?.faissCompareOverlap != null) faissCompareOverlap = Number(result.metrics.faissCompareOverlap);
        if (result?.metrics?.faissCompareScoreDelta != null) faissCompareScoreDelta = Number(result.metrics.faissCompareScoreDelta);
        faissCompareLinearLatencyMs += Number(result?.metrics?.faissCompareLinearLatencyMs) || 0;
        faissCompareSearchLatencyMs += Number(result?.metrics?.faissCompareSearchLatencyMs) || 0;
        for (const item of result?.items || []) {
            const id = String(item?.chunkId ?? item?.id ?? "");
            if (!id) continue;
            const score = Number(item.score) || 0;
            const adjusted = score + (queryIndex === 0 ? 0.001 : 0);
            const existing = byId.get(id);
            if (!existing || adjusted > existing._queryScore) {
                byId.set(id, { ...item, _queryScore: adjusted });
            } else if (existing && Array.isArray(item.sources)) {
                existing.sources = [...new Set([...(existing.sources || []), ...item.sources])];
            }
        }
    }
    const items = [...byId.values()]
        .sort((a, b) => Number(b._queryScore) - Number(a._queryScore) || String(a.chunkId).localeCompare(String(b.chunkId)))
        .slice(0, Math.max(1, Number(topK) || 1))
        .map((item, index) => {
            const { _queryScore, ...clean } = item;
            return { ...clean, score: round6(Math.max(0, Math.min(1, _queryScore))), rank: index + 1 };
        });
    const mode = modes.has("hybrid") ? "hybrid"
        : modes.has("embedding") ? "embedding"
            : modes.has("lexical") ? "lexical" : "lexical";
    return {
        status: items.length > 0 ? "ok" : "no_match",
        mode,
        items,
        metrics: {
            lexicalCount,
            embeddingCount,
            fusionCount: Math.max(fusionCount, byId.size),
            embeddingCalls,
            embeddingLatencyMs,
            embeddingError,
            groundedness: items.length > 0 ? items[0].score : null,
            queryCount: results.length,
            rawEvidenceRequired,
            rawEvidenceFiltered,
            vectorBackend,
            vectorSearchLatencyMs,
            vectorIndexLoadMs,
            vectorIndexBuildMs,
            vectorIndexGeneration,
            vectorIndexChunkCount,
            faissFallbackCode,
            faissCompareOverlap,
            faissCompareScoreDelta,
            faissCompareLinearLatencyMs,
            faissCompareSearchLatencyMs,
        },
    };
}

/**
 * Shared project-code/upload retrieval service for graph agents. It keeps the
 * original query, optionally adds one LLM rewrite, then reranks only returned
 * candidate IDs. Records one owner-scoped telemetry row for the whole call.
 */
export async function retrieveProjectCode({ scope, projectId, query, deps = {}, opts = {} } = {}) {
    const started = Date.now();
    const dependencies = deps || {};
    const store = dependencies.store || null;
    const embedder = dependencies.embedder === undefined ? defaultProjectEmbedder() : dependencies.embedder;
    const vectorStore = dependencies.vectorStore === undefined
        ? getConfiguredVectorStore({ scope, projectId, store })
        : dependencies.vectorStore;
    try {
        const rewriteEnabled = ragQueryRewriteEnabled() && opts.skipQueryRewrite !== true;
        const queryRewriter = rewriteEnabled && !opts.queryPlan
            ? (dependencies.queryRewriter === undefined ? createDefaultQueryRewriter() : dependencies.queryRewriter)
            : null;
        const rewriteStarted = Date.now();
        const rewrite = opts.queryPlan
            ? normalizeQueryPlan(opts.queryPlan, query)
            : await runQueryRewrite({
                query,
                enabled: rewriteEnabled,
                provider: queryRewriter,
                context: opts.rewriteContext || null,
                contextualEnabled: ragContextualQueryRewriteEnabled(),
                signal: opts.signal || null,
                timeoutMs: opts.queryRewriteTimeoutMs,
            });
        const retrievalResults = await Promise.allSettled(rewrite.queries.map((retrievalQuery) => hybridRetrieve({
            scope,
            projectId,
            query: retrievalQuery,
            store,
            embedder,
            vectorStore,
            opts,
        })));
        const healthyResults = retrievalResults
            .filter((entry) => entry.status === "fulfilled")
            .map((entry) => entry.value);
        if (healthyResults.length === 0) throw retrievalResults.find((entry) => entry.status === "rejected")?.reason || new Error("retrieval unavailable");
        const topK = Number(opts.topK) || 8;
        const result = mergeQueryResults(healthyResults, topK);
        result.metrics.rewrite = {
            enabled: rewriteEnabled,
            applied: rewrite.applied,
            contextual: rewrite.contextual === true,
            contextUsed: Array.isArray(rewrite.contextUsed) ? rewrite.contextUsed : [],
            recentTurnCount: Number(rewrite.recentTurnCount) || 0,
            summaryPresent: rewrite.summaryPresent === true,
            workingMemoryPresent: rewrite.workingMemoryPresent === true,
            contextTokens: Number(rewrite.contextTokens) || 0,
            keywords: Array.isArray(rewrite.keywords) ? rewrite.keywords : [],
            fallback: rewrite.fallback,
            reason: rewrite.reason,
            model: rewrite.model,
            latencyMs: Date.now() - rewriteStarted,
            calls: rewrite.calls,
            usage: rewrite.usage,
        };

        const rerankEnabled = ragRerankEnabled() && opts.skipRerank !== true;
        if (rerankEnabled && result.items.length > 0) {
            const rerankStarted = Date.now();
            const reranker = dependencies.reranker === undefined ? createChatModelReranker() : dependencies.reranker;
            const reranked = await runRerank({
                query,
                candidates: result.items,
                provider: reranker,
                signal: opts.signal || null,
                timeoutMs: opts.rerankTimeoutMs,
            });
            result.items = reranked.items.slice(0, topK);
            result.items = result.items.map((item, index) => ({ ...item, rank: index + 1 }));
            result.metrics.rerankEnabled = true;
            result.metrics.rerankApplied = reranked.applied;
            result.metrics.rerankFallback = reranked.fallback;
            result.metrics.rerankFallbackReason = reranked.reason;
            result.metrics.rerankCount = result.items.length;
            result.metrics.rerankLatencyMs = Date.now() - rerankStarted;
            result.metrics.rerankModel = reranked.providerMeta?.model || reranker?.model || null;
            result.metrics.rerankCalls = Number(reranked.providerMeta?.calls) || (reranker ? 1 : 0);
            result.metrics.rerankUsage = reranked.providerMeta?.usage || null;
            result.metrics.groundedness = result.items.length > 0 ? result.items[0].score : null;
        } else {
            result.metrics.rerankEnabled = false;
            result.metrics.rerankApplied = false;
            result.metrics.rerankFallback = false;
            result.metrics.rerankCount = 0;
            result.metrics.rerankLatencyMs = 0;
        }
        result.metrics.llmCalls = Number(result.metrics.rewrite?.calls || 0) + Number(result.metrics.rerankCalls || 0);
        const latencyMs = Date.now() - started;
        const status = result.items.length > 0 ? "hit" : "no_match";
        if (opts.skipTelemetry !== true) {
            recordKnowledgeQuery({
                scope,
                projectId,
                mode: result.mode,
                status,
                source: result.mode,
                items: result.items.length,
                latencyMs,
                groundedness: result.metrics?.groundedness ?? null,
                query,
                metrics: result.metrics,
            });
        }
        return {
            status: result.items.length > 0 ? "ok" : "no_match",
            mode: result.mode,
            text: buildCitationText(result.items, {}),
            items: result.items,
            metrics: result.metrics,
            errorCode: null,
        };
    } catch (err) {
        const classified = classifyError(err);
        const latencyMs = Date.now() - started;
        if (opts.skipTelemetry !== true) recordKnowledgeQuery({
            scope,
            projectId,
            mode: "lexical",
            status: "error",
            source: "lexical",
            items: 0,
            latencyMs,
            groundedness: null,
            query,
            metrics: { fallbackCode: classified.code },
        });
        return {
            status: "error",
            mode: "lexical",
            text: "",
            items: [],
            metrics: {
                lexicalCount: 0, embeddingCount: 0, fusionCount: 0, embeddingCalls: 0,
                embeddingError: null, groundedness: null, rewrite: null,
                vectorBackend: null, vectorSearchLatencyMs: 0, vectorIndexLoadMs: 0,
                vectorIndexBuildMs: 0, vectorIndexGeneration: null, vectorIndexChunkCount: 0,
                faissFallbackCode: null, faissCompareOverlap: null, faissCompareScoreDelta: null,
                faissCompareLinearLatencyMs: 0, faissCompareSearchLatencyMs: 0,
            },
            errorCode: classified.code,
        };
    }
}

export { mergeQueryResults };

export default { hybridRetrieve, buildCitationText, retrieveProjectCode, fuseResults, mergeQueryResults };
