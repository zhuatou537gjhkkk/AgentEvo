/**
 * M10 — deterministic weight calibration for cross-source ranking.
 *
 * Calibration is deliberately small and offline: callers provide labeled
 * scenarios, and this function chooses from explicit candidate weights. It
 * does not learn from raw user content or mutate runtime configuration.
 */
import { CROSS_SOURCE_SCORE_WEIGHTS, scoreCrossSourceCandidate } from "../services/crossSourceRecall.js";

function normalizeWeights(weights = {}) {
    const merged = { ...CROSS_SOURCE_SCORE_WEIGHTS, ...weights };
    const safe = Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, Math.max(0, Number(value) || 0)]));
    const total = Object.values(safe).reduce((sum, value) => sum + value, 0) || 1;
    return Object.fromEntries(Object.entries(safe).map(([key, value]) => [key, Math.round(value / total * 1000) / 1000]));
}

function candidateId(candidate, index) {
    return String(candidate?.id ?? candidate?.metadata?.memory_id ?? candidate?.metadata?.provenance?.sourceId ?? `candidate-${index}`);
}

function scoreScenario(scenario, weights) {
    const candidates = Array.isArray(scenario?.candidates) ? scenario.candidates : [];
    const limit = Math.max(1, Number(scenario?.limit) || 1);
    const ranked = candidates
        .map((candidate, index) => ({ candidate, index, id: candidateId(candidate, index), score: scoreCrossSourceCandidate(candidate, scenario.now || Date.now(), weights).score }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit);
    const expected = new Set((scenario?.expectedIds || []).map(String));
    if (expected.size === 0) return { score: 0, ranked };
    const hits = ranked.filter((item) => expected.has(item.id));
    const precision = hits.length / limit;
    const reciprocal = hits.length ? 1 / (ranked.findIndex((item) => expected.has(item.id)) + 1) : 0;
    return { score: precision * 0.6 + reciprocal * 0.4, ranked };
}

export function calibrateCrossSourceWeights(scenarios = [], options = {}) {
    const usable = Array.isArray(scenarios) ? scenarios.filter((scenario) => Array.isArray(scenario?.candidates) && scenario.candidates.length > 0) : [];
    const candidates = [CROSS_SOURCE_SCORE_WEIGHTS, ...(options.weightCandidates || [])].map(normalizeWeights);
    const unique = [...new Map(candidates.map((weights) => [JSON.stringify(weights), weights])).values()];
    const observations = unique.map((weights, index) => {
        const scenarioScores = usable.map((scenario) => scoreScenario(scenario, weights));
        const score = scenarioScores.length ? scenarioScores.reduce((sum, item) => sum + item.score, 0) / scenarioScores.length : 0;
        return { index, weights, score: Math.round(score * 10000) / 10000, scenarios: scenarioScores };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const best = observations[0] || { index: 0, weights: normalizeWeights(), score: 0, scenarios: [] };
    const baseline = observations.find((item) => JSON.stringify(item.weights) === JSON.stringify(normalizeWeights())) || best;
    return {
        version: "cross-source-calibration-v1",
        evaluatedScenarios: usable.length,
        candidateCount: unique.length,
        baseline: { weights: baseline.weights, score: baseline.score },
        best: { weights: best.weights, score: best.score },
        improved: best.score > baseline.score,
        observations: observations.map((item) => ({ weights: item.weights, score: item.score })),
    };
}

export default { calibrateCrossSourceWeights };
