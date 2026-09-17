import { describe, expect, it } from "vitest";
import { assignCrossSourceExperiment, classifyCrossSourceStratum, evaluateCrossSourceCanary, summarizeCrossSourceExperiment } from "./crossSourceExperiment.js";

function trace(group, stratum = "general:user_memory") {
    return {
        root_span: JSON.stringify({ metadata: {
            cross_source_experiment: { group, stratum: { key: stratum } },
        } }),
    };
}

describe("cross-source experiment", () => {
    it("assigns a stable group and records a non-sensitive stratum", () => {
        const first = assignCrossSourceExperiment({ enabled: true, unitId: "user:1:session:7", allocation: 0.5, query: "我喜欢 Python", sourceTypes: ["user_memory"] });
        const second = assignCrossSourceExperiment({ enabled: true, unitId: "user:1:session:7", allocation: 0.5, query: "我喜欢 Python", sourceTypes: ["user_memory"] });
        expect(second).toEqual(first);
        expect(first.stratum).toEqual({ queryClass: "preference", sourceKey: "user_memory", key: "preference:user_memory" });
        expect(first.stratum.key).not.toContain("Python");
    });

    it("keeps control when the experiment is disabled or allocation is zero", () => {
        expect(assignCrossSourceExperiment({ enabled: false, unitId: "a", allocation: 1 }).group).toBe("control");
        expect(assignCrossSourceExperiment({ enabled: true, unitId: "a", allocation: 0 }).group).toBe("control");
        expect(classifyCrossSourceStratum({ query: "搜索最新新闻", sourceTypes: [] }).queryClass).toBe("search");
    });

    it("summarizes injected/control outcomes by stratum", () => {
        const records = [
            { rating: "thumbs_up", trace: trace("injected") },
            { rating: "thumbs_down", trace: trace("control") },
            { rating: "thumbs_up", trace: trace("injected") },
            { rating: "thumbs_down", trace: trace("control") },
        ];
        const summary = summarizeCrossSourceExperiment(records, { minSamples: 2 });
        expect(summary.sufficient).toBe(true);
        expect(summary.uplift).toBe(1);
        expect(summary.recommendation).toBe("candidate_for_canary");
    });

    it("requires manual approval and has an explicit negative gate", () => {
        expect(evaluateCrossSourceCanary({ summary: { sufficient: true, uplift: 0.2 } }).action).toBe("request_manual_canary_approval");
        expect(evaluateCrossSourceCanary({ summary: { sufficient: true, uplift: -0.2 } }).rollbackRecommended).toBe(true);
        expect(evaluateCrossSourceCanary({ summary: { sufficient: false, uplift: 1 } }).approved).toBe(false);
    });
});
