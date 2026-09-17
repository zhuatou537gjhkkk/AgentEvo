/**
 * M14 — repeatable long-window reports for the cross-source experiment.
 *
 * This module is pure: it only consumes content-free feedback evidence and
 * returns a report suitable for persistence. It never changes AgentConfig.
 */
import { evaluateCrossSourceCanary, summarizeCrossSourceExperiment } from "./crossSourceExperiment.js";

const DEFAULT_Z = 1.96;

function round(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return null;
    const scale = 10 ** digits;
    return Math.round(Number(value) * scale) / scale;
}

export function wilsonInterval({ positive = 0, samples = 0 } = {}, z = DEFAULT_Z) {
    const n = Math.max(0, Number(samples) || 0);
    const k = Math.max(0, Math.min(n, Number(positive) || 0));
    if (!n) return { low: null, high: null, width: null, confidence: 0.95 };
    const p = k / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denominator;
    const margin = (z / denominator) * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
    const low = Math.max(0, center - margin);
    const high = Math.min(1, center + margin);
    return { low: round(low), high: round(high), width: round(high - low), confidence: 0.95 };
}

function differenceInterval(control, injected, z = DEFAULT_Z) {
    const controlSamples = Number(control?.samples) || 0;
    const injectedSamples = Number(injected?.samples) || 0;
    if (!controlSamples || !injectedSamples) {
        return { low: null, high: null, width: null, confidence: 0.95 };
    }
    const controlRate = Number(control.positiveRate) || 0;
    const injectedRate = Number(injected.positiveRate) || 0;
    const standardError = Math.sqrt(
        (controlRate * (1 - controlRate)) / controlSamples
        + (injectedRate * (1 - injectedRate)) / injectedSamples,
    );
    const estimate = injectedRate - controlRate;
    return {
        low: round(estimate - z * standardError),
        high: round(estimate + z * standardError),
        width: round(2 * z * standardError),
        confidence: 0.95,
    };
}

function isoOrNull(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function compareCrossSourceExperimentReports(before, after) {
    const beforeSummary = before?.summary || before || {};
    const afterSummary = after?.summary || after || {};
    const beforeUplift = Number(beforeSummary.uplift);
    const afterUplift = Number(afterSummary.uplift);
    const beforePositiveRate = Number(beforeSummary.injected?.positiveRate);
    const afterPositiveRate = Number(afterSummary.injected?.positiveRate);
    return {
        beforeReportId: before?.id ?? null,
        afterReportId: after?.id ?? null,
        upliftDelta: Number.isFinite(beforeUplift) && Number.isFinite(afterUplift)
            ? round(afterUplift - beforeUplift)
            : null,
        injectedPositiveRateDelta: Number.isFinite(beforePositiveRate) && Number.isFinite(afterPositiveRate)
            ? round(afterPositiveRate - beforePositiveRate)
            : null,
        sampleDelta: (Number(afterSummary.samples) || 0) - (Number(beforeSummary.samples) || 0),
        sufficientBefore: Boolean(beforeSummary.sufficient),
        sufficientAfter: Boolean(afterSummary.sufficient),
    };
}

/**
 * Decide whether a proposed configuration may proceed to human review. This
 * is a release guard, not a publisher: it can recommend stop/rollback, but it
 * never calls AgentConfigService and never changes experiment allocation.
 */
export function evaluateCrossSourceReleaseGuard({ before = null, after = null } = {}) {
    const afterSummary = after?.summary || after || {};
    const beforeSummary = before?.summary || before || {};
    if (!after || !afterSummary || typeof afterSummary !== "object") {
        return { action: "review_data", automatic: false, approved: false, reason: "after_report_required" };
    }
    if (!afterSummary.sufficient) {
        return { action: "collect_more_data", automatic: false, approved: false, reason: "after_report_insufficient" };
    }
    const upliftInterval = after?.confidence?.uplift || {};
    if (Number.isFinite(Number(upliftInterval.high)) && Number(upliftInterval.high) < 0) {
        return { action: "recommend_rollback", automatic: false, approved: false, reason: "negative_uplift_interval" };
    }
    const beforeUplift = Number(beforeSummary.uplift);
    const afterUplift = Number(afterSummary.uplift);
    if (beforeSummary.sufficient && Number.isFinite(beforeUplift) && Number.isFinite(afterUplift)
        && afterUplift <= beforeUplift - 0.1) {
        return { action: "stop_experiment", automatic: false, approved: false, reason: "uplift_regressed" };
    }
    if (after.canary?.approved && Number.isFinite(Number(upliftInterval.low)) && Number(upliftInterval.low) > 0) {
        return { action: "allow_manual_release", automatic: false, approved: true, reason: "positive_uplift_interval" };
    }
    return { action: "hold_and_review", automatic: false, approved: false, reason: "uplift_not_conclusive" };
}

export function buildCrossSourceExperimentReport(records = [], {
    minSamples = 5,
    periodStart = null,
    periodEnd = new Date(),
    configVersionId = null,
    experimentKey = null,
} = {}) {
    const summary = summarizeCrossSourceExperiment(records, { minSamples });
    const canary = evaluateCrossSourceCanary({ summary });
    const controlInterval = wilsonInterval(summary.control);
    const injectedInterval = wilsonInterval(summary.injected);
    const upliftInterval = differenceInterval(summary.control, summary.injected);
    const byStratum = Object.fromEntries(Object.entries(summary.byStratum || {}).map(([key, value]) => ({
        [key]: {
            ...value,
            confidence: {
                control: wilsonInterval(value.control),
                injected: wilsonInterval(value.injected),
                uplift: differenceInterval(value.control, value.injected),
            },
        },
    })));

    return {
        version: "cross-source-experiment-report-v1",
        generatedAt: isoOrNull(periodEnd) || new Date().toISOString(),
        periodStart: isoOrNull(periodStart),
        periodEnd: isoOrNull(periodEnd) || new Date().toISOString(),
        experimentKey: experimentKey ? String(experimentKey) : null,
        configVersionId: configVersionId == null ? null : Number(configVersionId) || null,
        summary: { ...summary, byStratum },
        confidence: {
            level: 0.95,
            control: controlInterval,
            injected: injectedInterval,
            uplift: upliftInterval,
        },
        canary,
        release: {
            automatic: false,
            action: canary.action,
            requiresManualApproval: true,
        },
    };
}

export default {
    buildCrossSourceExperimentReport,
    compareCrossSourceExperimentReports,
    evaluateCrossSourceReleaseGuard,
    wilsonInterval,
};
