/**
 * Phase 7 / R4 — lexical/path/symbol retrieval over the durable store.
 *
 * Pure lexical retrieval (roadmap R4 checklist #6): no embeddings, no network.
 * Candidates come straight from the owner/tenant/project-scoped active chunks
 * returned by `store.getActiveChunks`, so every row is already filtered to the
 * caller's scope — cross-user/cross-tenant reads can never leak rows here.
 *
 * Ranking (weights chosen so a path-only match outranks a content-only match,
 * and an exact symbol hit outranks a bare substring hit):
 *   contentTermHits — 1.0 per query term whose lowercase text is a substring of
 *       the chunk content, normalized by the number of query terms;
 *   symbolExact     — 2.0 when any query term is an exact member of the chunk's
 *       extracted symbols;
 *   pathTermMatch   — 3.0 when any query term is a path term of the chunk's file.
 * The weighted sum is divided by 6 and clamped to 0..1 so scores are comparable
 * across retrievers for hybrid fusion.
 *
 * `no_match` (healthy empty result) is returned, never `error` — distinguishing
 * a no-match from a backend failure is an R4 DoD contract handled by callers.
 */
import { tokenizeQuery, extractPathTerms } from "./codeChunk.js";
import { getActiveChunks } from "./knowledgeStore.js";

const DEFAULT_STORE = { getActiveChunks };

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function toSymbolSet(symbols) {
    const set = new Set();
    for (const part of String(symbols ?? "").split(/[\s,;]+/)) {
        const p = part.toLowerCase();
        if (p) set.add(p);
    }
    return set;
}

/**
 * Pure 0..1 lexical score for one chunk given query tokens. Exported for unit
 * tests. `chunk` uses retrieval-normal fields: { content, symbols, filePath }.
 * @param {object} chunk
 * @param {string[]} tokens query terms (lowercase alnum + CJK bigrams)
 */
export function lexicalCandidateScore(chunk, tokens) {
    const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    if (list.length === 0) return 0;
    const content = String(chunk?.content ?? "").toLowerCase();
    const n = list.length;
    const contentHits = list.reduce((acc, t) => (content.includes(t) ? acc + 1 : acc), 0);
    const contentScore = contentHits / n; // weight 1.0 each, normalized by query-term count
    const symbolSet = toSymbolSet(chunk?.symbols);
    const symbolExact = list.some((t) => symbolSet.has(t)) ? 1 : 0; // weight 2.0
    const pathTerms = new Set(extractPathTerms(chunk?.filePath));
    const pathTermMatch = list.some((t) => pathTerms.has(t)) ? 1 : 0; // weight 3.0
    return Math.min(1, (contentScore * 1.0 + symbolExact * 2.0 + pathTermMatch * 3.0) / 6.0);
}

/**
 * Lexical search over active project chunks.
 * @param {object} args { scope, projectId, query, store?, tokenize?, limit?,
 *   candidateCap? } — scope is a userId number or { userId, tenantId };
 *   store defaults to the real knowledgeStore `getActiveChunks`.
 * @returns {{status:'no_match'|'ok', items:object[], mode:'lexical'}} items =
 *   [{ chunkId, documentId, filePath, startLine, endLine, content, symbols,
 *      score, rank, source, commit? }] sorted desc, rank 1..n.
 */
export function lexicalSearch({ scope, projectId, query, store = null, tokenize = null, limit = 8, candidateCap = 4000 } = {}) {
    const storeRef = store || DEFAULT_STORE;
    const tokenizer = tokenize || tokenizeQuery;
    const { terms, cjk } = tokenizer(query);
    const tokens = [...terms, ...cjk];
    if (tokens.length === 0) {
        return { status: "no_match", items: [], mode: "lexical" };
    }

    const cap = Math.max(1, Number(candidateCap) | 0);
    const rows = storeRef.getActiveChunks(scope, projectId, { limit: cap }) || [];

    const matched = [];
    for (const row of rows) {
        const content = String(row.content ?? "").toLowerCase();
        const symbolSet = toSymbolSet(row.symbols);
        const pathTerms = new Set(extractPathTerms(row.file_path));
        let gate = false;
        for (const t of tokens) {
            if (content.includes(t) || symbolSet.has(t) || pathTerms.has(t)) {
                gate = true;
                break;
            }
        }
        if (!gate) continue;
        const score = lexicalCandidateScore(
            { content: row.content, symbols: row.symbols, filePath: row.file_path },
            tokens,
        );
        matched.push({ row, score });
    }

    matched.sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));

    const top = Math.max(1, Number(limit) | 0);
    const items = matched.slice(0, top).map(({ row, score }, index) => ({
        chunkId: row.id,
        documentId: row.document_id,
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        symbols: row.symbols,
        score: round6(score),
        rank: index + 1,
        source: "lexical",
        commit: row.source_commit ?? null,
    }));

    return {
        status: items.length > 0 ? "ok" : "no_match",
        items,
        mode: "lexical",
    };
}

export default { lexicalSearch, lexicalCandidateScore };
