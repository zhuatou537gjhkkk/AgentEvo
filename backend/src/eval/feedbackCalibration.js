/**
 * M11 — calibrate deterministic helpfulness proxies against human feedback.
 *
 * This module accepts only numeric quality dimensions and a thumbs-up/down
 * label. It deliberately stores nothing and never sees answer text, memory
 * content, or user identity.
 */

export const HELPFULNESS_FEATURES = Object.freeze([
    "isolation",
    "sourceCoverage",
    "budgetCompliance",
    "helpfulness",
]);

const DEFAULT_WEIGHTS = Object.freeze({
    isolation: 0.2,
    sourceCoverage: 0.2,
    budgetCompliance: 0.1,
    helpfulness: 0.5,
});

function clamp01(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeWeights(weights = {}) {
    const merged = { ...DEFAULT_WEIGHTS, ...weights };
    const safe = Object.fromEntries(HELPFULNESS_FEATURES.map((key) => [key, Math.max(0, Number(merged[key]) || 0)]));
    const total = Object.values(safe).reduce((sum, value) => sum + value, 0) || 1;
    return Object.fromEntries(HELPFULNESS_FEATURES.map((key) => [key, Math.round(safe[key] / total * 1000) / 1000]));
}

function feedbackLabel(rating) {
    if (rating === "thumbs_up" || rating === "up" || rating === 1 || rating === true) return 1;
    if (rating === "thumbs_down" || rating === "down" || rating === 0 || rating === false) return 0;
    return null;
}

function featuresOf(record) {
    const source = record?.features || record?.metrics || record?.quality?.metrics || {};
    return Object.fromEntries(HELPFULNESS_FEATURES.map((key) => [key, clamp01(source[key], 0)]));
}

function score(features, weights) {
    return HELPFULNESS_FEATURES.reduce((total, key) => total + features[key] * weights[key], 0);
}

function balancedAccuracy(rows, threshold) {
    const positives = rows.filter((row) => row.label === 1);
    const negatives = rows.filter((row) => row.label === 0);
    if (positives.length === 0 || negatives.length === 0) return { score: 0, confusion: { tp: 0, tn: 0, fp: 0, fn: 0 } };
    let tp = 0; let tn = 0; let fp = 0; let fn = 0;
    for (const row of rows) {
        const predicted = row.score >= threshold ? 1 : 0;
        if (predicted === 1 && row.label === 1) tp++;
        else if (predicted === 0 && row.label === 0) tn++;
        else if (predicted === 1) fp++;
        else fn++;
    }
    return {
        score: ((tp / positives.length) + (tn / negatives.length)) / 2,
        confusion: { tp, tn, fp, fn },
    };
}

/** Convert a stored feedback record into a content-free calibration example. */
export function buildFeedbackExample(record = {}) {
    const label = feedbackLabel(record.rating);
    if (label == null) return null;
    const features = featuresOf(record);
    return { features, label };
}

/**
 * Pick the best explicit weight/threshold candidate using balanced accuracy.
 * Tie-breaking is deterministic: higher threshold first, then input order.
 */
export function calibrateHelpfulnessFromFeedback(records = [], options = {}) {
    const rows = (Array.isArray(records) ? records : []).map(buildFeedbackExample).filter(Boolean);
    const suppliedWeights = [DEFAULT_WEIGHTS, ...(options.weightCandidates || [])].map(normalizeWeights);
    const uniqueWeights = [...new Map(suppliedWeights.map((item) => [JSON.stringify(item), item])).values()];
    const thresholds = (options.thresholds || [0.4, 0.5, 0.6, 0.7, 0.8]).map(Number)
        .filter(Number.isFinite)
        .map(clamp01);
    const observations = [];
    for (let weightIndex = 0; weightIndex < uniqueWeights.length; weightIndex++) {
        const weights = uniqueWeights[weightIndex];
        const scoredRows = rows.map((row) => ({ ...row, score: score(row.features, weights) }));
        for (let thresholdIndex = 0; thresholdIndex < thresholds.length; thresholdIndex++) {
            const threshold = thresholds[thresholdIndex];
            const result = balancedAccuracy(scoredRows, threshold);
            observations.push({ weightIndex, thresholdIndex, weights, threshold, score: result.score, confusion: result.confusion });
        }
    }
    observations.sort((a, b) => b.score - a.score || b.threshold - a.threshold || a.weightIndex - b.weightIndex || a.thresholdIndex - b.thresholdIndex);
    const best = observations[0] || {
        weights: normalizeWeights(),
        threshold: 0.6,
        score: null,
        confusion: { tp: 0, tn: 0, fp: 0, fn: 0 },
    };
    const baselineWeights = normalizeWeights();
    const baseline = observations.find((item) => JSON.stringify(item.weights) === JSON.stringify(baselineWeights) && item.threshold === 0.6) || best;
    return {
        version: "helpfulness-feedback-calibration-v1",
        samples: rows.length,
        positiveSamples: rows.filter((row) => row.label === 1).length,
        negativeSamples: rows.filter((row) => row.label === 0).length,
        sufficient: rows.length >= 4 && rows.some((row) => row.label === 1) && rows.some((row) => row.label === 0),
        baseline: { weights: baseline.weights, threshold: baseline.threshold, balancedAccuracy: baseline.score, confusion: baseline.confusion },
        best: { weights: best.weights, threshold: best.threshold, balancedAccuracy: best.score, confusion: best.confusion },
        improved: Number.isFinite(best.score) && Number.isFinite(baseline.score) && best.score > baseline.score,
        observations: observations.map((item) => ({ weights: item.weights, threshold: item.threshold, balancedAccuracy: item.score })),
    };
}

export default { buildFeedbackExample, calibrateHelpfulnessFromFeedback, HELPFULNESS_FEATURES };
