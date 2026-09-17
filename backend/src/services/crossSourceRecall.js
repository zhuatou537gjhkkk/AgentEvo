/**
 * M9 — cross-source recall policy.
 *
 * This is a pure orchestration/selection layer. It does not read a database
 * and it does not merge user_memory, project_memory, or RAG storage. Callers
 * provide already-authorized ContextPackets; this module only scores, budgets,
 * and explains their selection.
 */
import { estimateTokens } from "./chatUtils.js";

export const CROSS_SOURCE_TYPES = Object.freeze([
    "user_memory",
    "project_memory",
    "rag",
    "knowledge",
    "search",
]);

const DEFAULTS = Object.freeze({
    maxItems: 10,
    maxTokens: 2200,
    minScore: 0,
    sourceCaps: {
        user_memory: 4,
        project_memory: 4,
        rag: 4,
        knowledge: 4,
        search: 3,
    },
});

const SOURCE_TRUST = Object.freeze({
    user_memory: 1.0,
    project_memory: 0.95,
    rag: 0.9,
    knowledge: 0.9,
    search: 0.75,
});

export const CROSS_SOURCE_SCORE_WEIGHTS = Object.freeze({
    relevance: 0.5,
    confidence: 0.2,
    importance: 0.1,
    recency: 0.1,
    trust: 0.1,
});

function clamp01(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function bounded(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeScoreWeights(value) {
    let input = value;
    if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
    }
    const merged = { ...CROSS_SOURCE_SCORE_WEIGHTS, ...(input && typeof input === "object" ? input : {}) };
    const safe = Object.fromEntries(Object.entries(CROSS_SOURCE_SCORE_WEIGHTS).map(([key, fallback]) => [
        key,
        Math.max(0, Number(merged[key]) || fallback),
    ]));
    const total = Object.values(safe).reduce((sum, item) => sum + item, 0) || 1;
    return Object.fromEntries(Object.entries(safe).map(([key, item]) => [key, Math.round(item / total * 1000) / 1000]));
}

function recencyScore(packet, now) {
    const raw = packet?.timestamp || packet?.metadata?.createdAt || packet?.metadata?.created_at;
    const parsed = new Date(raw || now).getTime();
    const ageDays = Math.max(0, (now - (Number.isFinite(parsed) ? parsed : now)) / 86400000);
    return Math.max(0.1, Math.exp(-0.1 * ageDays));
}

export function sourceTypeForPacket(packet) {
    const metadata = packet?.metadata || {};
    if (metadata.sourceType && CROSS_SOURCE_TYPES.includes(metadata.sourceType)) return metadata.sourceType;
    if (metadata.projectMemory === true) return "project_memory";
    if (metadata.type === "memory") return "user_memory";
    if (CROSS_SOURCE_TYPES.includes(metadata.type)) return metadata.type;
    return null;
}

export function crossSourceConfig(overrides = {}) {
    const rawCaps = overrides.sourceCaps || {};
    const sourceCaps = {};
    for (const source of CROSS_SOURCE_TYPES) {
        sourceCaps[source] = Math.round(bounded(
            rawCaps[source] ?? process.env[`MEMORY_CROSS_SOURCE_${source.toUpperCase()}_CAP`],
            DEFAULTS.sourceCaps[source],
            0,
            20,
        ));
    }
    return {
        maxItems: Math.round(bounded(
            overrides.maxItems ?? process.env.MEMORY_CROSS_SOURCE_MAX_ITEMS,
            DEFAULTS.maxItems,
            1,
            50,
        )),
        maxTokens: Math.round(bounded(
            overrides.maxTokens ?? process.env.MEMORY_CROSS_SOURCE_MAX_TOKENS,
            DEFAULTS.maxTokens,
            100,
            20000,
        )),
        minScore: bounded(
            overrides.minScore ?? process.env.MEMORY_CROSS_SOURCE_MIN_SCORE,
            DEFAULTS.minScore,
            0,
            1,
        ),
        scoreWeights: normalizeScoreWeights(overrides.scoreWeights ?? process.env.MEMORY_CROSS_SOURCE_SCORE_WEIGHTS),
        sourceCaps,
    };
}

export function scoreCrossSourceCandidate(packet, now = Date.now(), weightOverrides = null) {
    const sourceType = sourceTypeForPacket(packet) || "unknown";
    const metadata = packet?.metadata || {};
    const relevance = clamp01(packet?.relevanceScore, 0);
    const confidence = clamp01(metadata.confidence ?? metadata.provenance?.confidence, 1);
    const importance = clamp01(metadata.importance, 0.5);
    const recency = recencyScore(packet, now);
    const trust = SOURCE_TRUST[sourceType] ?? 0.5;
    const weights = normalizeScoreWeights(weightOverrides || CROSS_SOURCE_SCORE_WEIGHTS);
    const totalWeight = Object.values(weights).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) || 1;
    const score = Math.min(1, (
        relevance * Math.max(0, Number(weights.relevance) || 0)
        + confidence * Math.max(0, Number(weights.confidence) || 0)
        + importance * Math.max(0, Number(weights.importance) || 0)
        + recency * Math.max(0, Number(weights.recency) || 0)
        + trust * Math.max(0, Number(weights.trust) || 0)
    ) / totalWeight);
    const reasons = [];
    if (relevance >= 0.5) reasons.push("query_relevance");
    if (confidence >= 0.7) reasons.push("high_confidence");
    if (trust >= 0.9) reasons.push("trusted_source");
    if (recency >= 0.8) reasons.push("recent");
    return { sourceType, score, relevance, confidence, importance, recency, trust, reasons };
}

function packetId(packet, index) {
    return packet?.metadata?.memory_id
        ?? packet?.metadata?.memoryId
        ?? packet?.metadata?.provenance?.sourceId
        ?? packet?.metadata?.provenance?.chunkId
        ?? packet?.id
        ?? `candidate-${index}`;
}

/**
 * Select candidates with a fair first pass (one per source), then score order.
 * Per-source caps and the total token budget are both hard limits.
 */
export function selectCrossSourceCandidates(candidates = [], overrides = {}, now = Date.now()) {
    const config = crossSourceConfig(overrides);
    const input = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    const scored = input
        .map((packet, index) => ({ packet, index, id: packetId(packet, index), scoring: scoreCrossSourceCandidate(packet, now, config.scoreWeights) }))
        .filter((item) => item.scoring.sourceType !== "unknown" && item.scoring.score >= config.minScore);
    const dropped = [];
    const rejected = input.length - scored.length;
    for (const item of input
        .map((packet, index) => ({ packet, index, id: packetId(packet, index), scoring: scoreCrossSourceCandidate(packet, now, config.scoreWeights) }))
        .filter((item) => item.scoring.sourceType === "unknown" || item.scoring.score < config.minScore)) {
        dropped.push({ id: item.id, sourceType: item.scoring.sourceType, reason: item.scoring.sourceType === "unknown" ? "unsupported_source" : "below_score", score: item.scoring.score });
    }

    const buckets = new Map(CROSS_SOURCE_TYPES.map((source) => [source, []]));
    for (const item of scored) buckets.get(item.scoring.sourceType).push(item);
    for (const bucket of buckets.values()) {
        bucket.sort((a, b) => b.scoring.score - a.scoring.score || a.index - b.index);
    }

    const selected = [];
    const selectedIds = new Set();
    let selectedTokens = 0;
    const sourceUsed = Object.fromEntries(CROSS_SOURCE_TYPES.map((source) => [source, 0]));
    const sourceSelected = Object.fromEntries(CROSS_SOURCE_TYPES.map((source) => [source, 0]));

    const trySelect = (item) => {
        const source = item.scoring.sourceType;
        if (selected.length >= config.maxItems) {
            dropped.push({ id: item.id, sourceType: source, reason: "max_items", score: item.scoring.score });
            return false;
        }
        if (sourceSelected[source] >= config.sourceCaps[source]) {
            dropped.push({ id: item.id, sourceType: source, reason: "source_cap", score: item.scoring.score });
            return false;
        }
        const tokens = Math.max(1, Number(item.packet.tokenCount) || estimateTokens(item.packet.content));
        if (selectedTokens + tokens > config.maxTokens) {
            dropped.push({ id: item.id, sourceType: source, reason: "cross_source_budget", score: item.scoring.score, tokens });
            return false;
        }
        selected.push({ ...item.packet, crossSourceScore: item.scoring.score, crossSourceReasons: item.scoring.reasons });
        selectedIds.add(item.id);
        selectedTokens += tokens;
        sourceUsed[source] += tokens;
        sourceSelected[source] += 1;
        return true;
    };

    // Fairness pass: give every source one opportunity before filling by score.
    for (const source of CROSS_SOURCE_TYPES) {
        const first = buckets.get(source)?.[0];
        if (first) trySelect(first);
    }
    const rest = scored
        .filter((item) => !selectedIds.has(item.id))
        .sort((a, b) => b.scoring.score - a.scoring.score || a.index - b.index);
    for (const item of rest) trySelect(item);

    const bySource = Object.fromEntries(CROSS_SOURCE_TYPES.map((source) => [source, {
        candidates: buckets.get(source).length,
        selected: sourceSelected[source],
        tokens: sourceUsed[source],
        cap: config.sourceCaps[source],
    }]));
    return {
        selected,
        dropped,
        selectedTokens,
        scanned: input.length,
        rejected,
        config,
        bySource,
    };
}

/** Load multiple already-authorized sources independently; one failure is non-fatal. */
export async function recallAcrossSources(sources = {}, overrides = {}, now = Date.now()) {
    const candidates = [];
    const errors = {};
    for (const source of CROSS_SOURCE_TYPES) {
        const loader = sources[source];
        if (loader == null) continue;
        try {
            const value = typeof loader === "function" ? await loader() : loader;
            const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
            candidates.push(...items);
        } catch (error) {
            errors[source] = { code: error?.code || "SOURCE_UNAVAILABLE" };
        }
    }
    return { ...selectCrossSourceCandidates(candidates, overrides, now), errors };
}

export default {
    CROSS_SOURCE_TYPES,
    crossSourceConfig,
    sourceTypeForPacket,
    scoreCrossSourceCandidate,
    CROSS_SOURCE_SCORE_WEIGHTS,
    selectCrossSourceCandidates,
    recallAcrossSources,
};
