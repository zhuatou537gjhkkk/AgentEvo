import { describe, expect, it } from "vitest";
import { buildRagPanelModel } from "../RagEvaluationPanel.jsx";

describe("K11 RAG evaluation panel model", () => {
    it("builds safe cards from partial telemetry", () => {
        const model = buildRagPanelModel({ telemetry: { summary: { total: 4, hitRate: 0.75, noMatch: 1, error: 0, avgLatencyMs: 20, fallbackCount: 1 }, recentP95LatencyMs: 80 }, report: { available: false } });
        expect(model.cards.find((card) => card.key === "hitRate").value).toBe("75.0%");
        expect(model.cards.find((card) => card.key === "latency").value).toBe("20 / 80 ms");
        expect(model.reportStatus).toBe("暂无 K9 报告");
    });

    it("does not fabricate a gate pass when the report is unavailable", () => {
        expect(buildRagPanelModel({ telemetry: { summary: {} }, report: null }).reportStatus).toBe("暂无 K9 报告");
    });
});
