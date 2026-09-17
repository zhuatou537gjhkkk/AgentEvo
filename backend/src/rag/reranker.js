/**
 * K6 second-stage reranking seam.
 *
 * Reranking may reorder already-retrieved candidates, but it can never create
 * a new chunk or replace chunk content. The provider is injectable so tests
 * stay offline and production can add a bounded model call later.
 */
const MAX_RERANK_CANDIDATES = 12;
const DEFAULT_TIMEOUT_MS = 8000;

function parsePayload(raw) {
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
    }
    return raw;
}

function entriesFromPayload(raw) {
    const parsed = parsePayload(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return null;
}

/** Validate strict provider output against the original candidate allowlist. */
export function validateRerankOutput(raw, candidates = []) {
    const source = Array.isArray(candidates) ? candidates : [];
    const entries = entriesFromPayload(raw);
    if (!entries || entries.length !== source.length) return { ok: false, reason: "invalid-shape" };
    const allowed = new Set(source.map((item) => String(item.chunkId ?? item.id ?? "")));
    const seen = new Set();
    const normalized = [];
    for (const entry of entries) {
        const chunkId = String(entry?.chunkId ?? "");
        const relevance = Number(entry?.relevance);
        if (!chunkId || !allowed.has(chunkId) || seen.has(chunkId)) {
            return { ok: false, reason: "unknown-or-duplicate-id" };
        }
        if (!Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
            return { ok: false, reason: "invalid-relevance" };
        }
        seen.add(chunkId);
        normalized.push({ chunkId, relevance });
    }
    if (seen.size !== allowed.size) return { ok: false, reason: "missing-candidate" };
    normalized.sort((a, b) => b.relevance - a.relevance || a.chunkId.localeCompare(b.chunkId));
    return { ok: true, items: normalized };
}

function deterministicResult(candidates) {
    return candidates.map((item, index) => ({
        ...item,
        fusedRank: item.fusedRank ?? item.rank ?? index + 1,
        rank: index + 1,
    }));
}

async function invokeProvider(provider, payload) {
    if (typeof provider === "function") return provider(payload);
    if (provider && typeof provider.rerank === "function") return provider.rerank(payload);
    return null;
}

async function invokeWithTimeout(provider, payload, timeoutMs) {
    const externalSignal = payload.signal;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort(externalSignal.reason);
        else externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    let timer;
    try {
        const task = invokeProvider(provider, { ...payload, signal: controller.signal });
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(Object.assign(new Error("rerank timeout"), { code: "RERANK_TIMEOUT" }));
            }, timeoutMs);
        });
        return await Promise.race([task, timeout]);
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", forwardAbort);
    }
}

/**
 * Rerank at most twelve candidates. Provider errors and invalid responses are
 * observable but never erase healthy fused retrieval evidence.
 */
export async function runRerank({
    query,
    candidates = [],
    provider = null,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxCandidates = MAX_RERANK_CANDIDATES,
} = {}) {
    const limited = (Array.isArray(candidates) ? candidates : []).slice(0, Math.max(1, Math.min(MAX_RERANK_CANDIDATES, Number(maxCandidates) || MAX_RERANK_CANDIDATES)));
    if (limited.length === 0) {
        return { items: [], applied: false, fallback: false, reason: null };
    }
    if (!provider) {
        return { items: deterministicResult(limited), applied: false, fallback: false, reason: "deterministic-pass-through" };
    }
    try {
        const raw = await invokeWithTimeout(provider, { query: String(query ?? ""), candidates: limited, signal }, Math.max(50, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
        const checked = validateRerankOutput(raw, limited);
        if (!checked.ok) {
            return { items: deterministicResult(limited), applied: false, fallback: true, reason: checked.reason, providerMeta: raw?.meta || null };
        }
        const byId = new Map(limited.map((item) => [String(item.chunkId ?? item.id ?? ""), item]));
        return {
            items: checked.items.map((entry, index) => ({
                ...byId.get(entry.chunkId),
                fusedRank: byId.get(entry.chunkId)?.rank ?? index + 1,
                rerankScore: entry.relevance,
                rank: index + 1,
            })),
            applied: true,
            fallback: false,
            reason: null,
            providerMeta: raw?.meta || null,
        };
    } catch (error) {
        return {
            items: deterministicResult(limited),
            applied: false,
            fallback: true,
            reason: error?.code || "RERANK_PROVIDER_ERROR",
            providerMeta: null,
        };
    }
}

export { MAX_RERANK_CANDIDATES, DEFAULT_TIMEOUT_MS };

export default { validateRerankOutput, runRerank };
