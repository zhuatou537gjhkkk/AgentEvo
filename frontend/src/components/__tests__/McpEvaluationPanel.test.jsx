import { describe, expect, it } from "vitest";
import { rateText } from "../McpEvaluationPanel.jsx";

describe("MCP evaluation panel metric display", () => {
    it("shows numerator and denominator for a real sample", () => {
        expect(rateText({ numerator: 6, denominator: 8, value: 0.75 })).toBe("75.0% (6/8)");
    });

    it("shows no sample instead of fabricating a zero percent", () => {
        expect(rateText({ numerator: 0, denominator: 0, value: null })).toBe("无样本");
        expect(rateText(null)).toBe("无样本");
    });
});
