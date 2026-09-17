import { describe, expect, it, vi } from "vitest";
import { createSSEEmitter, emitPlanProgress } from "./chatGraph.js";

describe("chat graph identity contracts", () => {
    it("targets the dispatched subtask in plan progress", () => {
        const events = [];
        const plan = [
            { id: "1", status: "in_progress" },
            { id: "2", status: "pending" },
        ];
        const result = emitPlanProgress(
            { todoUpdated: (todos) => events.push(todos) },
            plan,
            "agent_start",
            "2",
        );
        expect(result.map((step) => step.status)).toEqual(["in_progress", "in_progress"]);
        expect(events[0].find((step) => step.id === "2").status).toBe("in_progress");
    });

    it("keeps same-type agent lifecycle IDs paired when closed out of order", () => {
        const writes = [];
        const res = { writableEnded: false, write: (frame) => writes.push(frame), once: () => {} };
        const collector = {
            getTrace: () => ({}),
            startSpan: vi.fn().mockReturnValueOnce("span-a").mockReturnValueOnce("span-b"),
            endSpan: vi.fn(),
        };
        const sse = createSSEEmitter(res, collector, "trace");
        sse.agentStart("code", "1");
        sse.agentStart("code", "2");
        sse.agentEnd("code", "span-a");
        sse.agentEnd("code", "span-b");
        const events = writes.map((frame) => {
            const text = String(frame);
            const start = text.indexOf("data: ");
            if (start < 0) return null;
            const end = text.indexOf("\\n", start);
            return JSON.parse(text.slice(start + 6, end < 0 ? undefined : end));
        }).filter(Boolean);
        expect(events.filter((event) => event.type === "agent_start").map((event) => event.subTaskId)).toEqual(["1", "2"]);
        expect(events.filter((event) => event.type === "agent_end").map((event) => event.subTaskId)).toEqual(["1", "2"]);
    });
});
