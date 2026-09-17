import { describe, expect, it } from "vitest";
import { buildCrossSourceExperimentReport, compareCrossSourceExperimentReports, evaluateCrossSourceReleaseGuard, wilsonInterval } from "./crossSourceExperimentReport.js";

function traceRecord(group, rating, stratum = "general:user_memory") {
    return {
        rating,
        trace: { rootSpan: { metadata: { cross_source_experiment: { group, stratum: { key: stratum } } } } },
    };
}

describe("cross-source experiment M14 reports", () => {
    it("returns bounded confidence intervals without exposing raw evidence", () => {
        const report = buildCrossSourceExperimentReport([
            traceRecord("control", "thumbs_down"),
            traceRecord("control", "thumbs_up"),
            traceRecord("injected", "thumbs_up"),
            traceRecord("injected", "thumbs_up"),
        ], { minSamples: 1, periodStart: "2026-09-10T00:00:00Z", periodEnd: "2026-09-11T00:00:00Z" });

        expect(report.summary).toMatchObject({ samples: 4, sufficient: true, uplift: 0.5 });
        expect(report.confidence.control.low).toBeGreaterThanOrEqual(0);
        expect(report.confidence.injected.high).toBeLessThanOrEqual(1);
        expect(report.confidence.uplift.low).toBeLessThan(report.confidence.uplift.high);
        expect(JSON.stringify(report)).not.toContain("thumbs_down");
    });

    it("compares adjacent snapshots using aggregate deltas", () => {
        const before = buildCrossSourceExperimentReport([
            traceRecord("control", "thumbs_down"),
            traceRecord("injected", "thumbs_down"),
        ], { minSamples: 1 });
        const after = buildCrossSourceExperimentReport([
            traceRecord("control", "thumbs_down"),
            traceRecord("injected", "thumbs_up"),
        ], { minSamples: 1 });
        expect(compareCrossSourceExperimentReports({ id: 1, summary: before.summary }, { id: 2, summary: after.summary })).toMatchObject({
            beforeReportId: 1,
            afterReportId: 2,
            upliftDelta: 1,
        });
    });

    it("returns no interval for an empty arm", () => {
        expect(wilsonInterval()).toMatchObject({ low: null, high: null, width: null });
    });

    it("never auto-publishes and exposes explicit release guard actions", () => {
        const before = { summary: { sufficient: true, uplift: 0 }, id: 1 };
        const positive = {
            id: 2,
            summary: { sufficient: true, uplift: 0.5 },
            confidence: { uplift: { low: 0.1, high: 0.9 } },
            canary: { approved: true },
        };
        expect(evaluateCrossSourceReleaseGuard({ before, after: positive })).toMatchObject({
            action: "allow_manual_release",
            approved: true,
            automatic: false,
        });
        expect(evaluateCrossSourceReleaseGuard({ after: {
            summary: { sufficient: true, uplift: -0.4 },
            confidence: { uplift: { low: -0.8, high: -0.1 } },
        } })).toMatchObject({ action: "recommend_rollback", automatic: false });
    });
});
