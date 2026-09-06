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
import { lexicalSearch } from "./lexical.js";
import { recordKnowledgeQuery } from "./telemetry.js";

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function toEmbeddingItem(hit) {
    return {
        chunkId: hit.chunkId ?? hit.id,
        documentId: hit.documentId ?? hit.document_id ?? null,
        filePath: hit.filePath ?? hit.file_path ?? null,
        startLine: hit.startLine ?? hit.start_line ?? null,
        endLine: hit.endLine ?? hit.end_line ?? null,
        content: hit.content ?? "",
        symbols: hit.symbols ?? "",
        commit: null, // durable adapter rows do not carry source_commit
    };
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
export function fuseResults(entries, topK) {
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
        return {
            ...item,
            score: round6(e.score),
            rank: index + 1,
            sources,
            provenance: {
                file: item.filePath,
                startLine: item.startLine,
                endLine: item.endLine,
                commit,
            },
        };
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
    const metrics = { lexicalCount: 0, embeddingCount: 0, embeddingError: null, groundedness: null };

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
        try {
            const [queryVector] = await embedder.embed([String(query ?? "")]);
            const filter = filePathFilter != null
                ? (entry) => String(entry.filePath ?? "") === filePathFilter
                : null;
            embHits = await vectorStore.similaritySearch(queryVector, embeddingLimit, filter);
        } catch (err) {
            const classified = classifyError(err);
            metrics.embeddingError = classified.code && classified.code !== "INTERNAL_ERROR"
                ? classified.code
                : "EMBEDDING_UNAVAILABLE";
            embHits = [];
        }
    }
    metrics.embeddingCount = embHits.length;

    const byId = new Map();
    lexItems.forEach((item, index) => byId.set(item.chunkId, { item, lexRank: index + 1, embRank: null }));
    embHits.forEach((hit, index) => {
        const existing = byId.get(hit.chunkId ?? hit.id);
        if (existing) {
            existing.embRank = index + 1;
        } else {
            byId.set(hit.chunkId ?? hit.id, { item: toEmbeddingItem(hit), lexRank: null, embRank: index + 1 });
        }
    });

    const items = fuseResults([...byId.values()], topK);

    const hasLex = lexItems.length > 0;
    const hasEmb = metrics.embeddingCount > 0;
    let mode = "lexical";
    if (embeddingAttempted && !metrics.embeddingError && hasEmb) {
        mode = hasLex ? "hybrid" : "embedding";
    }
    metrics.groundedness = items.length > 0 ? items[0].score : null;

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
        const header = `[${i + 1}] ${file}:${it.startLine ?? 0}-${it.endLine ?? 0}${commit ? ` @ ${shortCommit(commit)}` : ""}`;
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

/**
 * Shared project-code retrieval service for graph agents. Records telemetry.
 * @param {object} args { scope, projectId, query, deps:{ store, embedder,
 *   vectorStore }, opts }
 * @returns {{status:'ok'|'no_match'|'error', mode:string, text:string,
 *   items:object[], metrics:object, errorCode:string|null}}
 */
export async function retrieveProjectCode({ scope, projectId, query, deps = {}, opts = {} } = {}) {
    const started = Date.now();
    const { store, embedder, vectorStore } = deps || {};
    try {
        const result = await hybridRetrieve({ scope, projectId, query, store, embedder, vectorStore, opts });
        const latencyMs = Date.now() - started;
        const status = result.items.length > 0 ? "hit" : "no_match";
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
        });
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
        recordKnowledgeQuery({
            scope,
            projectId,
            mode: "lexical",
            status: "error",
            source: "lexical",
            items: 0,
            latencyMs,
            groundedness: null,
            query,
        });
        return {
            status: "error",
            mode: "lexical",
            text: "",
            items: [],
            metrics: { lexicalCount: 0, embeddingCount: 0, embeddingError: null, groundedness: null },
            errorCode: classified.code,
        };
    }
}

export default { hybridRetrieve, buildCitationText, retrieveProjectCode, fuseResults };
