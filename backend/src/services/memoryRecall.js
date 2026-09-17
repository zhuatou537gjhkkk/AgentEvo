import { estimateTokens } from "./chatUtils.js";
import { memoryTypeAwareScoringEnabled } from "./memoryFlags.js";

const DEFAULTS = {
    candidateLimit: 20,
    maxItems: 5,
    maxTokens: 1200,
    minConfidence: 0.2,
};

/**
 * The legacy recall profile. Keep these values as the single fallback so a
 * disabled type-aware flag follows the old scorer exactly.
 */
export const DEFAULT_RECALL_WEIGHTS = Object.freeze({
    relevance: 0.5,
    confidence: 0.2,
    importance: 0.15,
    recency: 0.15,
});

/** Initial, deliberately uncalibrated type-aware scoring hypotheses. */
export const TYPE_AWARE_RECALL_WEIGHTS = Object.freeze({
    working: Object.freeze({ relevance: 0.45, confidence: 0.10, importance: 0.10, recency: 0.35 }),
    episodic: Object.freeze({ relevance: 0.45, confidence: 0.15, importance: 0.15, recency: 0.25 }),
    semantic: Object.freeze({ relevance: 0.50, confidence: 0.25, importance: 0.20, recency: 0.05 }),
    default: Object.freeze({ ...DEFAULT_RECALL_WEIGHTS }),
});

const RECALL_WEIGHT_KEYS = Object.freeze(Object.keys(DEFAULT_RECALL_WEIGHTS));

function normalizeMemoryType(memoryType) {
    const value = String(memoryType ?? "").trim().toLowerCase();
    return value || "unknown";
}

function normalizeWeights(weights) {
    const safe = {};
    for (const key of RECALL_WEIGHT_KEYS) {
        const value = Number(weights?.[key]);
        safe[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_RECALL_WEIGHTS[key];
    }
    const total = Object.values(safe).reduce((sum, value) => sum + value, 0);
    if (total <= 0) return { ...DEFAULT_RECALL_WEIGHTS };
    return Object.fromEntries(RECALL_WEIGHT_KEYS.map((key) => [key, safe[key] / total]));
}

function typeAwareEnabled(options = {}) {
    if (options.typeAwareScoring !== undefined) return options.typeAwareScoring === true;
    if (options.typeAware !== undefined) return options.typeAware === true;
    return memoryTypeAwareScoringEnabled();
}

/**
 * Resolve the active profile for a memory type. Callers can pass
 * `typeAwareWeights` for deterministic experiments; unknown/missing types
 * always use the legacy default profile.
 */
export function resolveRecallWeights(memoryType, options = {}) {
    const normalizedType = normalizeMemoryType(memoryType);
    if (!typeAwareEnabled(options)) return { ...DEFAULT_RECALL_WEIGHTS };

    const configured = options.typeAwareWeights || options.recallWeights || null;
    const configuredProfile = configured?.[normalizedType] || configured?.default;
    if (configuredProfile && typeof configuredProfile === "object") {
        return normalizeWeights(configuredProfile);
    }
    if (configured && typeof configured === "object" && RECALL_WEIGHT_KEYS.some((key) => key in configured)) {
        return normalizeWeights(configured);
    }
    return { ...(TYPE_AWARE_RECALL_WEIGHTS[normalizedType] || DEFAULT_RECALL_WEIGHTS) };
}

function recallWeightProfileFor(memoryType, options = {}) {
    const normalizedType = normalizeMemoryType(memoryType);
    if (!typeAwareEnabled(options)) return "default";
    return TYPE_AWARE_RECALL_WEIGHTS[normalizedType] ? normalizedType : "default";
}

function bounded(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

export function memoryRecallConfig(overrides = {}) {
    return {
        candidateLimit: Math.round(bounded(overrides.candidateLimit ?? process.env.MEMORY_RECALL_CANDIDATE_LIMIT, DEFAULTS.candidateLimit, 1, 100)),
        maxItems: Math.round(bounded(overrides.maxItems ?? process.env.MEMORY_RECALL_MAX_ITEMS, DEFAULTS.maxItems, 1, 20)),
        maxTokens: Math.round(bounded(overrides.maxTokens ?? process.env.MEMORY_RECALL_MAX_TOKENS, DEFAULTS.maxTokens, 100, 10000)),
        minConfidence: bounded(overrides.minConfidence ?? process.env.MEMORY_RECALL_MIN_CONFIDENCE, DEFAULTS.minConfidence, 0, 1),
        typeAwareScoring: overrides.typeAwareScoring ?? memoryTypeAwareScoringEnabled(),
    };
}

function recencyScore(timestamp, now) {
    const parsed = new Date(timestamp || now).getTime();
    const ageDays = Math.max(0, (now - (Number.isFinite(parsed) ? parsed : now)) / 86400000);
    return Math.max(0.1, Math.exp(-0.1 * ageDays));
}

function queryScore(row) {
    return Math.max(0, Math.min(1, Number(row.relevanceScore) || 0));
}

function confidenceScore(row) {
    return Math.max(0, Math.min(1, Number(row.confidence ?? 1)));
}

function importanceScore(row) {
    return Math.max(0, Math.min(1, Number(row.importance ?? 0.5)));
}

export function scoreMemoryCandidate(row, now = Date.now(), options = {}) {
    // Be permissive for callers that provide options as the second argument.
    if (now && typeof now === "object" && !(now instanceof Date)) {
        options = now;
        now = Date.now();
    }
    const relevance = queryScore(row);
    const confidence = confidenceScore(row);
    const importance = importanceScore(row);
    const recency = recencyScore(row.last_recalled_at || row.updated_at || row.created_at, now);
    const pinnedBonus = row.pinned ? 0.08 : 0;
    const reasons = [];
    if (relevance >= 0.5) reasons.push("query_relevance");
    if (confidence >= 0.7) reasons.push("high_confidence");
    if (importance >= 0.7) reasons.push("high_importance");
    if (recency >= 0.8) reasons.push("recently_used");
    if (row.pinned) reasons.push("pinned");
    if (row.retrievalSources?.includes("lexical")) reasons.push("lexical_match");
    if (row.retrievalSources?.includes("vector")) reasons.push("vector_match");

    if (!typeAwareEnabled(options)) {
        const score = Math.min(1, relevance * 0.5 + confidence * 0.2 + importance * 0.15 + recency * 0.15 + pinnedBonus);
        return { score, relevance, confidence, importance, recency, reasons };
    }

    const memoryType = normalizeMemoryType(row?.memory_type ?? row?.memoryType);
    const weights = resolveRecallWeights(memoryType, options);
    const contributions = {
        relevance: relevance * weights.relevance,
        confidence: confidence * weights.confidence,
        importance: importance * weights.importance,
        recency: recency * weights.recency,
        pinnedBonus,
    };
    const score = Math.max(0, Math.min(1, Object.values(contributions).reduce((sum, value) => sum + value, 0)));
    return {
        score,
        relevance,
        confidence,
        importance,
        recency,
        reasons,
        recallWeightProfile: recallWeightProfileFor(memoryType, options),
        recallScoreComponents: {
            type: memoryType,
            weights,
            contributions,
        },
    };
}

/**
 * Rank active candidates and explain both selected and budget-rejected rows.
 * This function is pure so the ranking can be evaluated without a database.
 */
export function rankMemoryCandidates(candidates = [], options = {}, now = Date.now()) {
    const config = memoryRecallConfig(options);
    const scored = candidates
        .filter((row) => row?.status === "active")
        .map((row) => ({ row, scoring: scoreMemoryCandidate(row, now, config) }))
        .filter(({ scoring }) => scoring.confidence >= config.minConfidence)
        .sort((left, right) => (right.scoring.score - left.scoring.score) || (Number(right.row.id) - Number(left.row.id)));

    const selected = [];
    const dropped = [];
    let usedTokens = 0;
    for (const item of scored) {
        const tokens = estimateTokens(item.row.content);
        if (selected.length >= config.maxItems) {
            dropped.push({ id: item.row.id, reason: "max_items", score: item.scoring.score });
            continue;
        }
        if (usedTokens + tokens > config.maxTokens) {
            dropped.push({ id: item.row.id, reason: "memory_budget", score: item.scoring.score, tokens });
            continue;
        }
        usedTokens += tokens;
        const selectedRow = {
            ...item.row,
            recallScore: item.scoring.score,
            recallReasons: item.scoring.reasons,
            recallTokens: tokens,
        };
        if (item.scoring.recallWeightProfile) {
            selectedRow.recallWeightProfile = item.scoring.recallWeightProfile;
            selectedRow.recallScoreComponents = item.scoring.recallScoreComponents;
        }
        selected.push(selectedRow);
    }

    const selectedIds = new Set(selected.map((row) => Number(row.id)));
    const rejected = candidates
        .filter((row) => row?.status === "active" && !selectedIds.has(Number(row.id)))
        .filter((row) => !dropped.some((item) => Number(item.id) === Number(row.id)))
        .map((row) => ({ id: row.id, reason: "below_confidence", score: null }));

    return {
        selected,
        dropped: [...dropped, ...rejected],
        scanned: candidates.length,
        selectedTokens: usedTokens,
        config,
    };
}

export default {
    DEFAULT_RECALL_WEIGHTS,
    TYPE_AWARE_RECALL_WEIGHTS,
    memoryRecallConfig,
    resolveRecallWeights,
    scoreMemoryCandidate,
    rankMemoryCandidates,
};
