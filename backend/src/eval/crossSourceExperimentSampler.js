/**
 * M14 — opt-in background sampler for content-free experiment reports.
 *
 * The sampler only writes aggregate snapshots. It never changes config or
 * calls the model. The process-local timer is started only by startServer
 * when MEMORY_CROSS_SOURCE_SAMPLER_V2=true.
 */
import crypto from "node:crypto";
import {
    claimCrossSourceExperimentJob,
    completeCrossSourceExperimentJob,
    failCrossSourceExperimentJob,
    getCrossSourceExperimentScopes,
    getCrossSourceFeedbackEvidence,
    saveCrossSourceExperimentReport,
} from "../db/index.js";
import { crossSourceExperimentEnabled, crossSourceExperimentSamplerEnabled } from "../services/memoryFlags.js";
import { buildCrossSourceExperimentReport } from "./crossSourceExperimentReport.js";

function bounded(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function createCrossSourceExperimentSnapshot(scope, {
    limit = 500,
    minSamples = 5,
    windowHours = 24,
    configVersionId = null,
    experimentKey = null,
    now = new Date(),
} = {}) {
    const safeLimit = bounded(limit, 500, 1, 5000);
    const safeWindowHours = bounded(windowHours, 24, 1, 24 * 30);
    const periodEnd = now instanceof Date ? now : new Date(now);
    const periodStart = new Date(periodEnd.getTime() - safeWindowHours * 60 * 60 * 1000);
    const evidence = getCrossSourceFeedbackEvidence(scope, safeLimit);
    const windowEvidence = evidence.filter((record) => {
        const createdAt = new Date(record?.feedback_created_at || 0).getTime();
        return Number.isFinite(createdAt) && createdAt >= periodStart.getTime() && createdAt <= periodEnd.getTime();
    });
    const report = buildCrossSourceExperimentReport(windowEvidence, {
        minSamples,
        periodStart,
        periodEnd,
        configVersionId,
        experimentKey,
    });
    const id = saveCrossSourceExperimentReport(scope, {
        reportKey: `${report.experimentKey || "cross-source"}:${periodStart.toISOString()}:${periodEnd.toISOString()}`,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        experimentKey: report.experimentKey,
        configVersionId: report.configVersionId,
        report,
    });
    return { id, ...report };
}

export function runCrossSourceExperimentSampler({
    minSamples = Number(process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_MIN_SAMPLES) || 5,
    windowHours = Number(process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_WINDOW_HOURS) || 24,
    scopeLimit = Number(process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_SCOPE_LIMIT) || 100,
    jobName = "cross-source-daily-report",
    leaseSeconds = Number(process.env.MEMORY_CROSS_SOURCE_SAMPLER_LEASE_SECONDS) || 120,
    nextRunSeconds = Number(process.env.MEMORY_CROSS_SOURCE_SAMPLER_NEXT_RUN_SECONDS) || 900,
} = {}) {
    if (!crossSourceExperimentEnabled() || !crossSourceExperimentSamplerEnabled()) {
        return { enabled: false, reports: [], reason: "feature_disabled" };
    }
    const reports = [];
    let skipped = 0;
    for (const scope of getCrossSourceExperimentScopes(scopeLimit)) {
        const holderToken = crypto.randomUUID();
        if (!claimCrossSourceExperimentJob(scope, { jobName, holderToken, leaseSeconds })) {
            skipped += 1;
            continue;
        }
        try {
            const report = createCrossSourceExperimentSnapshot(scope, { minSamples, windowHours });
            completeCrossSourceExperimentJob(scope, { jobName, holderToken, reportId: report.id, nextRunSeconds });
            reports.push(report);
        } catch (error) {
            failCrossSourceExperimentJob(scope, { jobName, holderToken, errorCode: "REPORT_FAILED", retrySeconds: Math.min(nextRunSeconds, 300) });
            reports.push({ scope: { userId: scope.userId, tenantId: scope.tenantId }, errorCode: "REPORT_FAILED" });
        }
    }
    return { enabled: true, reports, skipped };
}

export function startCrossSourceExperimentSampler(options = {}) {
    if (!crossSourceExperimentEnabled() || !crossSourceExperimentSamplerEnabled()) {
        return () => {};
    }
    const intervalMs = bounded(
        options.intervalMs ?? Number(process.env.MEMORY_CROSS_SOURCE_SAMPLER_INTERVAL_MS),
        15 * 60 * 1000,
        60 * 1000,
        24 * 60 * 60 * 1000,
    );
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            runCrossSourceExperimentSampler(options);
        } catch (error) {
            console.warn(`[cross-source-sampler] snapshot failed: ${error.message}`);
        } finally {
            running = false;
        }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

export default { createCrossSourceExperimentSnapshot, runCrossSourceExperimentSampler, startCrossSourceExperimentSampler };
