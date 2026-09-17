/**
 * M12 — link human feedback to sanitized cross-source Trace metadata.
 *
 * This is an attribution report, not a causal claim. It compares feedback on
 * turns with selected cross-source candidates against turns without selected
 * candidates, while requiring a minimum sample count before calling uplift
 * actionable. No answer, memory, comment, or provider payload is returned.
 */

function clamp01(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function feedbackLabel(rating) {
    if (rating === "thumbs_up" || rating === "up" || rating === 1 || rating === true) return 1;
    if (rating === "thumbs_down" || rating === "down" || rating === 0 || rating === false) return 0;
    return null;
}

function parseObject(value) {
    if (value && typeof value === "object") return value;
    try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function traceMetadata(trace) {
    if (!trace || typeof trace !== "object") return {};
    if (trace.metadata && typeof trace.metadata === "object") return trace.metadata;
    const root = parseObject(trace.rootSpan || trace.root_span);
    return root?.metadata && typeof root.metadata === "object" ? root.metadata : {};
}

function treatmentFromRecord(record) {
    if (record?.treatment === "injected" || record?.treatment === "control") return record.treatment;
    const metadata = traceMetadata(record?.trace);
    const diagnostics = metadata.cross_source_recall;
    if (!diagnostics || typeof diagnostics !== "object") return null;
    const selected = Array.isArray(diagnostics?.selected) ? diagnostics.selected : [];
    return selected.length > 0 ? "injected" : "control";
}

function sourceTypesFromRecord(record) {
    const diagnostics = traceMetadata(record?.trace).cross_source_recall;
    return [...new Set((Array.isArray(diagnostics?.selected) ? diagnostics.selected : [])
        .map((item) => String(item?.sourceType || item?.source_type || ""))
        .filter(Boolean))];
}

function groupSummary(rows) {
    const positives = rows.filter((row) => row.label === 1).length;
    return {
        samples: rows.length,
        positive: positives,
        negative: rows.length - positives,
        positiveRate: rows.length ? Math.round(positives / rows.length * 10000) / 10000 : null,
    };
}

/**
 * Convert DB rows into content-free attribution records.
 * `root_span` is parsed only to inspect cross_source_recall metadata.
 */
export function normalizeCrossSourceFeedback(records = []) {
    return (Array.isArray(records) ? records : []).map((record) => {
        const label = feedbackLabel(record?.rating);
        if (label == null) return null;
        const trace = record?.trace || { root_span: record?.root_span };
        const treatment = treatmentFromRecord({ ...record, trace });
        if (!treatment) return null;
        return {
            label,
            treatment,
            sourceTypes: sourceTypesFromRecord({ ...record, trace }),
        };
    }).filter(Boolean);
}

export function aggregateCrossSourceFeedbackImpact(records = [], options = {}) {
    const rows = normalizeCrossSourceFeedback(records);
    const minSamples = Math.max(1, Math.min(1000, Number(options.minSamples) || 5));
    const injected = rows.filter((row) => row.treatment === "injected");
    const control = rows.filter((row) => row.treatment === "control");
    const injectedSummary = groupSummary(injected);
    const controlSummary = groupSummary(control);
    const sufficient = injected.length >= minSamples && control.length >= minSamples;
    const uplift = injectedSummary.positiveRate == null || controlSummary.positiveRate == null
        ? null
        : Math.round((injectedSummary.positiveRate - controlSummary.positiveRate) * 10000) / 10000;

    const sourceStats = {};
    for (const source of new Set(injected.flatMap((row) => row.sourceTypes))) {
        const sourceRows = injected.filter((row) => row.sourceTypes.includes(source));
        sourceStats[source] = groupSummary(sourceRows);
    }

    let recommendation = "collect_more_feedback";
    if (sufficient && uplift != null) {
        if (uplift >= 0.1) recommendation = "candidate_for_canary";
        else if (uplift <= -0.1) recommendation = "review_or_rollback";
        else recommendation = "keep_current_policy";
    }

    return {
        version: "cross-source-feedback-impact-v1",
        samples: rows.length,
        minSamples,
        sufficient,
        injected: injectedSummary,
        control: controlSummary,
        uplift,
        upliftPercent: uplift == null ? null : Math.round(uplift * 10000),
        bySource: sourceStats,
        recommendation,
        confidence: sufficient ? clamp01(Math.min(injected.length, control.length) / (minSamples * 4)) : 0,
    };
}

export default { normalizeCrossSourceFeedback, aggregateCrossSourceFeedbackImpact };
