/** K8 bounded query rewrite with an original-query fallback. */
import { createDefaultRagProvider, preservesProtectedFragments } from "./chatModelRetrievalProvider.js";
import {
    hasUsefulRewriteContext,
    rewriteContextDiagnostics,
    rewriteContextSources,
    shouldUseContextualRewrite,
} from "./rewriteContext.js";

const MAX_KEYWORDS = 8;
const MAX_KEYWORD_CHARS = 80;

function invokeProvider(provider, payload) {
    if (typeof provider === "function") return provider(payload);
    if (provider && typeof provider.rewrite === "function") return provider.rewrite(payload);
    return null;
}

function publicReason(error) {
    const code = String(error?.code || "").toUpperCase();
    if (code.includes("TIMEOUT")) return "RAG_REWRITE_TIMEOUT";
    if (code === "ABORTED" || error?.name === "AbortError") return "ABORTED";
    if (code.includes("PROTECTED")) return "RAG_REWRITE_PROTECTED_FRAGMENT";
    if (code.includes("INVALID")) return "RAG_REWRITE_INVALID_RESPONSE";
    return code.slice(0, 64) || "RAG_REWRITE_PROVIDER_ERROR";
}

function normalizeKeywords(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map((item) => String(item ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, MAX_KEYWORD_CHARS))
        .filter(Boolean))].slice(0, MAX_KEYWORDS);
}

function safeCalls(value, fallback = 1) {
    const calls = Number(value);
    return Number.isFinite(calls) ? Math.max(0, Math.min(1, Math.trunc(calls))) : fallback;
}

function rewriteMeta(raw, provider) {
    return {
        model: raw?.meta?.model || provider?.model || null,
        calls: safeCalls(raw?.meta?.calls),
        usage: raw?.meta?.usage || null,
    };
}

/**
 * Normalize a server-created query plan before it reaches a source loader.
 * Only query text and content-free diagnostics survive; the original query is
 * always restored as position zero and no authorization field is accepted.
 */
export function normalizeQueryPlan(value, query) {
    const original = String(query ?? "").trim();
    const raw = value && typeof value === "object" ? value : {};
    const candidates = Array.isArray(raw.queries) ? raw.queries : [];
    const rewrite = String(candidates[0] || "").trim() === original
        ? String(candidates[1] || "").trim()
        : String(candidates[0] || "").trim();
    const safeRewrite = rewrite && rewrite !== original && preservesProtectedFragments(original, rewrite)
        ? rewrite.slice(0, 600)
        : "";
    const diagnostics = raw.diagnostics && typeof raw.diagnostics === "object" ? raw.diagnostics : raw;
    return {
        queries: original ? [original, ...(safeRewrite ? [safeRewrite] : [])] : [],
        keywords: normalizeKeywords(raw.keywords),
        applied: Boolean(safeRewrite),
        contextual: Boolean(raw.contextual),
        contextUsed: Array.isArray(raw.contextUsed)
            ? raw.contextUsed.filter((source) => ["recent_turns", "summary", "working_memory"].includes(source)).slice(0, 3)
            : [],
        fallback: Boolean(raw.fallback) || Boolean(rewrite && !safeRewrite),
        reason: raw.reason == null ? null : String(raw.reason).slice(0, 64),
        model: diagnostics.model == null ? null : String(diagnostics.model).slice(0, 120),
        calls: safeCalls(raw.calls, 0),
        usage: raw.usage && typeof raw.usage === "object" ? raw.usage : null,
        recentTurnCount: Math.max(0, Math.min(3, Number(raw.recentTurnCount) || 0)),
        summaryPresent: raw.summaryPresent === true,
        workingMemoryPresent: raw.workingMemoryPresent === true,
        contextTokens: Math.max(0, Math.min(2000, Number(raw.contextTokens) || 0)),
    };
}

/**
 * Keep the original query as the first retrieval input. A rewrite is only an
 * additional candidate query; it can never replace authorization/filter data.
 */
export async function runQueryRewrite({
    query,
    enabled = false,
    provider = null,
    context = null,
    rewriteContext = null,
    contextualEnabled = false,
    signal = null,
    timeoutMs = null,
} = {}) {
    const original = String(query ?? "").trim();
    const suppliedContext = context || rewriteContext;
    const contextEligible = Boolean(
        enabled
        &&
        contextualEnabled
        && shouldUseContextualRewrite(original)
        && hasUsefulRewriteContext(suppliedContext),
    );
    const contextDiagnostics = contextEligible ? rewriteContextDiagnostics(suppliedContext) : {
        contextUsed: [],
        recentTurnCount: 0,
        summaryPresent: false,
        workingMemoryPresent: false,
        contextTokens: 0,
    };
    const base = {
        queries: original ? [original] : [],
        keywords: [],
        applied: false,
        contextual: contextEligible,
        contextUsed: contextDiagnostics.contextUsed,
        recentTurnCount: contextDiagnostics.recentTurnCount,
        summaryPresent: contextDiagnostics.summaryPresent,
        workingMemoryPresent: contextDiagnostics.workingMemoryPresent,
        contextTokens: contextDiagnostics.contextTokens,
        fallback: Boolean(enabled && !provider),
        reason: enabled ? "provider-unavailable" : "disabled",
        model: null,
        calls: 0,
        usage: null,
    };
    if (!original || !enabled || !provider) return base;

    try {
        const payload = { query: original, signal, timeoutMs };
        if (contextEligible) payload.context = suppliedContext;
        const raw = await invokeProvider(provider, payload);
        const meta = rewriteMeta(raw, provider);
        const keywords = normalizeKeywords(raw?.keywords);
        const usedContext = contextEligible && raw?.used_context !== false && raw?.usedContext !== false;
        const rewrite = String(raw?.rewrite || "").trim();
        if (!rewrite || rewrite === original) {
            return {
                ...base,
                reason: "no-better-query",
                keywords,
                contextUsed: usedContext ? rewriteContextSources(suppliedContext) : [],
                ...meta,
            };
        }
        if (!preservesProtectedFragments(original, rewrite)) {
            return {
                ...base,
                fallback: true,
                reason: "RAG_REWRITE_PROTECTED_FRAGMENT",
                keywords,
                contextUsed: usedContext ? rewriteContextSources(suppliedContext) : [],
                ...meta,
            };
        }
        return {
            queries: [original, rewrite.slice(0, 600)],
            keywords,
            applied: true,
            fallback: false,
            reason: null,
            contextual: contextEligible,
            contextUsed: usedContext ? rewriteContextSources(suppliedContext) : [],
            recentTurnCount: contextDiagnostics.recentTurnCount,
            summaryPresent: contextDiagnostics.summaryPresent,
            workingMemoryPresent: contextDiagnostics.workingMemoryPresent,
            contextTokens: contextDiagnostics.contextTokens,
            ...meta,
        };
    } catch (error) {
        return {
            ...base,
            fallback: true,
            reason: publicReason(error),
            model: provider?.model || null,
            calls: 1,
        };
    }
}

export function createDefaultQueryRewriter() {
    return createDefaultRagProvider("rewrite");
}

export { shouldUseContextualRewrite };

export default { runQueryRewrite, createDefaultQueryRewriter, normalizeQueryPlan, shouldUseContextualRewrite };
