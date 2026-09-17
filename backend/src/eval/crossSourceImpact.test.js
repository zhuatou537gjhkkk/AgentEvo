import { describe, expect, it } from "vitest";
import { aggregateCrossSourceFeedbackImpact, normalizeCrossSourceFeedback } from "./crossSourceImpact.js";

function trace(selected) {
    return {
        root_span: JSON.stringify({ metadata: {
            cross_source_recall: {
                selected,
            },
        } }),
    };
}

describe("cross-source feedback impact", () => {
    it("links feedback to treatment using Trace metadata without exposing content", () => {
        const rows = normalizeCrossSourceFeedback([
            { rating: "thumbs_up", trace: trace([{ id: "u1", sourceType: "user_memory" }]) },
            { rating: "thumbs_down", trace: trace([]) },
        ]);
        expect(rows).toEqual([
            { label: 1, treatment: "injected", sourceTypes: ["user_memory"] },
            { label: 0, treatment: "control", sourceTypes: [] },
        ]);
        expect(JSON.stringify(rows)).not.toContain("u1");
    });

    it("reports positive uplift only when both groups meet the sample gate", () => {
        const rows = [
            { rating: "thumbs_up", trace: trace([{ sourceType: "user_memory" }]) },
            { rating: "thumbs_up", trace: trace([{ sourceType: "rag" }]) },
            { rating: "thumbs_down", trace: trace([]) },
            { rating: "thumbs_down", trace: trace([]) },
        ];
        const result = aggregateCrossSourceFeedbackImpact(rows, { minSamples: 2 });
        expect(result.sufficient).toBe(true);
        expect(result.uplift).toBe(1);
        expect(result.recommendation).toBe("candidate_for_canary");
        expect(result.bySource.user_memory.samples).toBe(1);
    });

    it("does not recommend a rollout with insufficient feedback", () => {
        const result = aggregateCrossSourceFeedbackImpact([
            { rating: "thumbs_up", treatment: "injected" },
            { rating: "thumbs_down", treatment: "control" },
        ], { minSamples: 5 });
        expect(result.sufficient).toBe(false);
        expect(result.recommendation).toBe("collect_more_feedback");
        expect(result.confidence).toBe(0);
    });

    it("excludes feedback without Trace diagnostics instead of treating it as control", () => {
        const result = aggregateCrossSourceFeedbackImpact([
            { rating: "thumbs_down" },
            { rating: "thumbs_up", trace: trace([]) },
        ], { minSamples: 1 });
        expect(result.samples).toBe(1);
        expect(result.control.samples).toBe(1);
        expect(result.injected.samples).toBe(0);
        expect(result.sufficient).toBe(false);
    });
});
