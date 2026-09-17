import { describe, expect, it } from "vitest";
import { CapturedResponse } from "./runner.js";

describe("CapturedResponse trace capture", () => {
    it("captures trace_id from the metrics SSE event without exposing raw payloads", () => {
        const response = new CapturedResponse();
        response.write("data: {\"type\":\"metrics\",\"metrics\":{\"trace_id\":\"trace-m10\",\"total_tokens\":12}}\n\n");
        expect(response.getTraceId()).toBe("trace-m10");
    });
});
