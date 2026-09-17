/**
 * M13 — deterministic stratified control/injected assignment.
 *
 * Assignment is server-side, stable for the same unit and experiment key,
 * and independent of model output. This module has no storage side effects;
 * canary approval remains a separate decision and config-version operation.
 */
import { createHash } from "node:crypto";

export const EXPERIMENT_GROUPS = Object.freeze(["control", "injected"]);
export const DEFAULT_EXPERIMENT_KEY = "memory-cross-source-v1";

function bounded(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function stableBucket(value) {
    const hex = createHash("sha256").update(String(value || "")).digest("hex").slice(0, 8);
    return Number.parseInt(hex, 16) % 10000;
}

function labelOf(rating) {
    if (rating === "thumbs_up" || rating === "up" || rating === 1 || rating === true) return 1;
    if (rating === "thumbs_down" || rating === "down" || rating === 0 || rating === false) return 0;
    return null;
}

export function classifyCrossSourceStratum({ query = "", sourceTypes = [] } = {}) {
    const text = String(query || "").toLowerCase();
    const sources = [...new Set((Array.isArray(sourceTypes) ? sourceTypes : []).map(String).filter(Boolean))].sort();
    let queryClass = "general";
    if (/(代码|代码库|函数|bug|报错|实现|file|function|error)/i.test(text)) queryClass = "code";
    else if (/(搜索|新闻|最新|天气|search|today|latest)/i.test(text)) queryClass = "search";
    else if (/(喜欢|偏好|记住|习惯|preference|prefer)/i.test(text)) queryClass = "preference";
    return {
        queryClass,
        sourceKey: sources.length ? sources.join("+") : "unknown",
        key: `${queryClass}:${sources.length ? sources.join("+") : "unknown"}`,
    };
}

export function assignCrossSourceExperiment({
    enabled = false,
    unitId,
    experimentKey = DEFAULT_EXPERIMENT_KEY,
    allocation = 0,
    query = "",
    sourceTypes = [],
    configVersionId = null,
} = {}) {
    const bucket = stableBucket(`${experimentKey}:${unitId || "anonymous"}`);
    const injectedBoundary = Math.round(bounded(allocation, 0, 0, 1) * 10000);
    const group = enabled && injectedBoundary > 0 && bucket < injectedBoundary ? "injected" : "control";
    const stratum = classifyCrossSourceStratum({ query, sourceTypes });
    return {
        enabled: Boolean(enabled),
        experimentKey: String(experimentKey || DEFAULT_EXPERIMENT_KEY),
        group,
        bucket,
        allocation: injectedBoundary / 10000,
        stratum,
        configVersionId: configVersionId == null ? null : Number(configVersionId) || null,
    };
}

function parseRootSpan(trace) {
    if (trace?.root_span && typeof trace.root_span === "string") {
        try { return JSON.parse(trace.root_span); } catch { return {}; }
    }
    return trace?.rootSpan || trace || {};
}

function experimentFromTrace(trace) {
    const root = parseRootSpan(trace);
    return root?.metadata?.cross_source_experiment || trace?.metadata?.cross_source_experiment || null;
}

function groupStats(rows) {
    const positive = rows.filter((row) => row.label === 1).length;
    return {
        samples: rows.length,
        positive,
        negative: rows.length - positive,
        positiveRate: rows.length ? Math.round(positive / rows.length * 10000) / 10000 : null,
    };
}

/** Summarize only rows with an explicit M13 assignment and valid feedback. */
export function summarizeCrossSourceExperiment(records = [], { minSamples = 5 } = {}) {
    const rows = (Array.isArray(records) ? records : []).map((record) => {
        const label = labelOf(record?.rating);
        const experiment = experimentFromTrace(record?.trace || record);
        if (label == null || !experiment || !EXPERIMENT_GROUPS.includes(experiment.group)) return null;
        return { label, group: experiment.group, stratum: experiment.stratum?.key || "unknown" };
    }).filter(Boolean);
    const safeMin = Math.max(1, Math.min(1000, Number(minSamples) || 5));
    const byStratum = {};
    for (const stratum of new Set(rows.map((row) => row.stratum))) {
        const bucket = rows.filter((row) => row.stratum === stratum);
        const control = bucket.filter((row) => row.group === "control");
        const injected = bucket.filter((row) => row.group === "injected");
        const c = groupStats(control);
        const i = groupStats(injected);
        const sufficient = c.samples >= safeMin && i.samples >= safeMin;
        byStratum[stratum] = {
            control: c,
            injected: i,
            sufficient,
            uplift: sufficient ? Math.round((i.positiveRate - c.positiveRate) * 10000) / 10000 : null,
        };
    }
    const control = groupStats(rows.filter((row) => row.group === "control"));
    const injected = groupStats(rows.filter((row) => row.group === "injected"));
    const sufficient = control.samples >= safeMin && injected.samples >= safeMin;
    const uplift = sufficient ? Math.round((injected.positiveRate - control.positiveRate) * 10000) / 10000 : null;
    return {
        version: "cross-source-experiment-v1",
        samples: rows.length,
        minSamples: safeMin,
        control,
        injected,
        sufficient,
        uplift,
        byStratum,
        recommendation: sufficient && uplift >= 0.1 ? "candidate_for_canary" : "collect_more_feedback",
    };
}

export function evaluateCrossSourceCanary({ summary, minUplift = 0.1, maxNegativeUplift = -0.05 } = {}) {
    const uplift = Number(summary?.uplift);
    const sufficient = Boolean(summary?.sufficient);
    const approved = sufficient && Number.isFinite(uplift) && uplift >= Number(minUplift);
    const rollbackRecommended = sufficient && Number.isFinite(uplift) && uplift <= Number(maxNegativeUplift);
    return {
        approved,
        rollbackRecommended,
        action: approved ? "request_manual_canary_approval" : rollbackRecommended ? "keep_control_and_review" : "collect_more_feedback",
        reason: !sufficient ? "insufficient_stratified_samples" : approved ? "uplift_meets_gate" : rollbackRecommended ? "negative_uplift" : "uplift_below_gate",
    };
}

export default { assignCrossSourceExperiment, classifyCrossSourceStratum, summarizeCrossSourceExperiment, evaluateCrossSourceCanary };
