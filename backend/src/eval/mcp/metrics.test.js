import { describe, expect, it } from "vitest";
import { ratio } from "./checks.js";
import { compareMcpSummaries, summarizeMcpResults } from "./metrics.js";

describe("MCP three-layer metrics", () => {
    it("keeps not_run out of the denominator and returns null for zero samples", () => {
        const summary = summarizeMcpResults([
            { layer: "protocol", status: "pass" },
            { layer: "tool_call", status: "fail", failureClass: "bad_arguments" },
            { layer: "end_to_end", status: "not_run" },
        ]);
        expect(summary.layers.find((item) => item.layer === "protocol").passRate).toEqual({ numerator: 1, denominator: 1, value: 1 });
        expect(summary.layers.find((item) => item.layer === "tool_call").passRate).toEqual({ numerator: 0, denominator: 1, value: 0 });
        expect(summary.layers.find((item) => item.layer === "end_to_end").passRate).toEqual({ numerator: 0, denominator: 0, value: null });
        expect(summary.notRun).toBe(1);
    });

    it("compares layer rates without merging protocol and task quality", () => {
        const before = summarizeMcpResults([{ layer: "protocol", status: "fail" }, { layer: "end_to_end", status: "not_run" }]);
        const after = summarizeMcpResults([{ layer: "protocol", status: "pass" }, { layer: "end_to_end", status: "fail" }]);
        const rows = compareMcpSummaries(before, after);
        expect(rows.find((item) => item.layer === "protocol").delta).toBe(1);
        expect(rows.find((item) => item.layer === "end_to_end").delta).toBeNull();
        expect(ratio(0, 0).value).toBeNull();
    });
});
