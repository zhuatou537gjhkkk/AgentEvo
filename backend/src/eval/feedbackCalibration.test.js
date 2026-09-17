import { describe, expect, it } from "vitest";
import { buildFeedbackExample, calibrateHelpfulnessFromFeedback } from "./feedbackCalibration.js";

describe("helpfulness feedback calibration", () => {
    it("normalizes feedback into content-free examples", () => {
        expect(buildFeedbackExample({ rating: "thumbs_up", metrics: { helpfulness: 0.9 } })).toEqual({
            features: { isolation: 0, sourceCoverage: 0, budgetCompliance: 0, helpfulness: 0.9 },
            label: 1,
        });
        expect(buildFeedbackExample({ rating: "unknown" })).toBeNull();
    });

    it("chooses a deterministic threshold that separates positive and negative feedback", () => {
        const report = calibrateHelpfulnessFromFeedback([
            { rating: "thumbs_up", metrics: { isolation: 1, sourceCoverage: 1, budgetCompliance: 1, helpfulness: 0.95 } },
            { rating: "thumbs_up", metrics: { isolation: 1, sourceCoverage: 0.9, budgetCompliance: 1, helpfulness: 0.8 } },
            { rating: "thumbs_down", metrics: { isolation: 0, sourceCoverage: 0.5, budgetCompliance: 1, helpfulness: 0.2 } },
            { rating: "thumbs_down", metrics: { isolation: 0.2, sourceCoverage: 0.3, budgetCompliance: 0, helpfulness: 0.1 } },
        ]);

        expect(report.version).toBe("helpfulness-feedback-calibration-v1");
        expect(report.sufficient).toBe(true);
        expect(report.best.balancedAccuracy).toBe(1);
        expect(report.best.threshold).toBeGreaterThan(0);
    });

    it("does not claim calibration is sufficient with one-sided feedback", () => {
        const report = calibrateHelpfulnessFromFeedback([
            { rating: "thumbs_up", metrics: { helpfulness: 1 } },
            { rating: "thumbs_up", metrics: { helpfulness: 0.8 } },
        ]);
        expect(report.sufficient).toBe(false);
        expect(report.best.balancedAccuracy).toBe(0);
    });

    it("never needs raw answer content", () => {
        expect(buildFeedbackExample({ rating: "thumbs_up", text: "private answer", metrics: { helpfulness: 1 } })).toMatchObject({ label: 1 });
    });
});
