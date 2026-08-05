/**
 * TraceCollector 单元测试 (Phase 5)
 *
 * 测试 Trace/Span 生命周期：startTrace → startSpan → endSpan → finishTrace
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock DB saveTrace before importing TraceCollector
vi.mock("../../db/index.js", () => ({
    saveTrace: vi.fn(() => 42),
}));

import { TraceCollector } from "../collector.js";

describe("TraceCollector", () => {
    let tc;

    beforeEach(() => {
        tc = new TraceCollector();
    });

    // ── startTrace ──

    describe("startTrace", () => {
        it("should create a new trace and return a traceId", () => {
            const traceId = tc.startTrace(1, 5, "chat", { input: "hello" });
            expect(traceId).toBeTruthy();
            expect(typeof traceId).toBe("string");
            expect(traceId.length).toBeGreaterThan(5);
        });

        it("should auto-create a root span with type=root", () => {
            const traceId = tc.startTrace(1, 5);
            const trace = tc.getTrace(traceId);
            expect(trace).toBeTruthy();
            expect(trace.rootSpan.type).toBe("root");
            expect(trace.rootSpan.name).toBe("root");
            expect(trace.rootSpan.startedAt).toBeTruthy();
            expect(trace.rootSpan.endedAt).toBeNull();
        });

        it("should store traceType and metadata", () => {
            const traceId = tc.startTrace(1, 5, "eval", { testCase: "tc_001" });
            const trace = tc.getTrace(traceId);
            expect(trace.traceType).toBe("eval");
            expect(trace.metadata.testCase).toBe("tc_001");
        });

        it("should generate unique traceIds", () => {
            const id1 = tc.startTrace(1, 1);
            const id2 = tc.startTrace(1, 1);
            expect(id1).not.toBe(id2);
        });

        it("should track agent traversal path from metadata.agentName", () => {
            const traceId = tc.startTrace(1, 5, "chat", { agentName: "router" });
            const trace = tc.getTrace(traceId);
            expect(trace.agentTraversalPath).toContain("router");
        });
    });

    // ── startSpan ──

    describe("startSpan", () => {
        it("should create a child span under root", () => {
            const traceId = tc.startTrace(1, 5);
            const spanId = tc.startSpan(traceId, "web_search", "tool");
            expect(spanId).toBeTruthy();

            const trace = tc.getTrace(traceId);
            expect(trace.spans.has(spanId)).toBe(true);
            expect(trace.rootSpan.children).toContain(spanId);
        });

        it("should create a nested span under a specified parent", () => {
            const traceId = tc.startTrace(1, 5);
            const agentSpanId = tc.startSpan(traceId, "search_agent", "agent");
            const toolSpanId = tc.startSpan(traceId, "web_search", "tool", agentSpanId);

            const trace = tc.getTrace(traceId);
            const agentSpan = trace.spans.get(agentSpanId);
            expect(agentSpan.children).toContain(toolSpanId);
        });

        it("should auto-increment toolCallCount for tool spans", () => {
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "get_system_time", "tool");
            tc.startSpan(traceId, "web_search", "tool");
            tc.startSpan(traceId, "memory", "tool");
            expect(tc.getTrace(traceId).toolCallCount).toBe(3);
        });

        it("should NOT increment toolCallCount for agent spans", () => {
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "router", "agent");
            tc.startSpan(traceId, "synthesizer", "agent");
            expect(tc.getTrace(traceId).toolCallCount).toBe(0);
        });

        it("should auto-track agent traversal path for agent spans", () => {
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "router", "agent");
            tc.startSpan(traceId, "search_agent", "agent");
            tc.startSpan(traceId, "synthesizer", "agent");
            expect(tc.getTrace(traceId).agentTraversalPath).toEqual([
                "router",
                "search_agent",
                "synthesizer",
            ]);
        });

        it("should NOT duplicate agent names in traversal path", () => {
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "search_agent", "agent");
            tc.startSpan(traceId, "search_agent", "agent");
            expect(tc.getTrace(traceId).agentTraversalPath).toEqual(["search_agent"]);
        });

        it("should return null for non-existent traceId", () => {
            const spanId = tc.startSpan("nonexistent", "test", "tool");
            expect(spanId).toBeNull();
        });
    });

    // ── endSpan ──

    describe("endSpan", () => {
        it("should record duration and endedAt", () => {
            const traceId = tc.startTrace(1, 5);
            const spanId = tc.startSpan(traceId, "web_search", "tool");

            tc.endSpan(traceId, spanId);

            const span = tc.getTrace(traceId).spans.get(spanId);
            expect(span.endedAt).toBeTruthy();
            expect(span.durationMs).toBeGreaterThanOrEqual(0);
        });

        it("should merge metadata from endSpan", () => {
            const traceId = tc.startTrace(1, 5);
            const spanId = tc.startSpan(traceId, "web_search", "tool", null, { query: "AI" });

            tc.endSpan(traceId, spanId, { output: "results...", tokens: 500 });

            const span = tc.getTrace(traceId).spans.get(spanId);
            expect(span.metadata.query).toBe("AI");
            expect(span.metadata.output).toBe("results...");
            expect(span.metadata.tokens).toBe(500);
        });

        it("should increment errorCount when metadata.error is set", () => {
            const traceId = tc.startTrace(1, 5);
            const spanId = tc.startSpan(traceId, "web_search", "tool");
            tc.endSpan(traceId, spanId, { error: "timeout" });
            expect(tc.getTrace(traceId).errorCount).toBe(1);
        });

        it("should NOT increment errorCount for agent spans with error", () => {
            const traceId = tc.startTrace(1, 5);
            const spanId = tc.startSpan(traceId, "search_agent", "agent");
            tc.endSpan(traceId, spanId, { error: "timeout" });
            expect(tc.getTrace(traceId).errorCount).toBe(0);
        });

        it("should be safe to call endSpan on non-existent traceId", () => {
            expect(() => tc.endSpan("nonexistent", "span1")).not.toThrow();
        });

        it("should be safe to call endSpan on non-existent spanId", () => {
            const traceId = tc.startTrace(1, 5);
            expect(() => tc.endSpan(traceId, "nonexistent")).not.toThrow();
        });
    });

    // ── finishTrace ──

    describe("finishTrace", () => {
        it("should record root span end time and duration", () => {
            const traceId = tc.startTrace(1, 5);
            const trace = tc.finishTrace(traceId, "deepseek-v4-flash");
            expect(trace.rootSpan.endedAt).toBeTruthy();
            expect(trace.rootSpan.durationMs).toBeGreaterThanOrEqual(0);
        });

        it("should serialize span tree correctly", () => {
            const traceId = tc.startTrace(1, 5);
            const agentSpanId = tc.startSpan(traceId, "general_chat", "agent");
            const toolSpanId = tc.startSpan(traceId, "memory", "tool", agentSpanId);
            tc.endSpan(traceId, toolSpanId, { action: "add" });
            tc.endSpan(traceId, agentSpanId);

            const trace = tc.finishTrace(traceId, "deepseek-v4-flash");

            // rootSpan should be fully serialized
            expect(trace.rootSpan.id).toBe(traceId);
            expect(trace.rootSpan.type).toBe("root");
            expect(trace.rootSpan.children.length).toBe(1); // agent span

            const agentSerialized = trace.rootSpan.children[0];
            expect(agentSerialized.name).toBe("general_chat");
            expect(agentSerialized.type).toBe("agent");
            expect(agentSerialized.children.length).toBe(1); // tool span

            const toolSerialized = agentSerialized.children[0];
            expect(toolSerialized.name).toBe("memory");
            expect(toolSerialized.type).toBe("tool");
            expect(toolSerialized.metadata.action).toBe("add");
        });

        it("should compute aggregate statistics correctly", () => {
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "router", "agent");
            const t1 = tc.startSpan(traceId, "web_search", "tool");
            const t2 = tc.startSpan(traceId, "get_system_time", "tool");
            tc.endSpan(traceId, t1);
            tc.endSpan(traceId, t2, { error: "network" });

            const trace = tc.finishTrace(traceId, "model");
            expect(trace.toolCallCount).toBe(2);
            expect(trace.errorCount).toBe(1);
            expect(trace.agentTraversalPath).toContain("router");
        });

        it("should include messageId and parentTraceId if provided", () => {
            const traceId = tc.startTrace(1, 5);
            const trace = tc.finishTrace(traceId, "model", {
                messageId: 999,
                parentTraceId: "parent-trace-001",
            });
            expect(trace.messageId).toBe(999);
            expect(trace.parentTraceId).toBe("parent-trace-001");
        });

        it("should remove trace from active traces after finish", () => {
            const traceId = tc.startTrace(1, 5);
            tc.finishTrace(traceId, "model");
            expect(tc.getTrace(traceId)).toBeUndefined();
        });

        it("should call saveTrace to persist to DB", async () => {
            const { saveTrace } = await import("../../db/index.js");
            const traceId = tc.startTrace(1, 5);
            tc.startSpan(traceId, "web_search", "tool");
            tc.finishTrace(traceId, "deepseek-v4-flash");

            expect(saveTrace).toHaveBeenCalled();
            // Find the call with our traceId (other tests also call saveTrace)
            const ourCall = saveTrace.mock.calls.find(c => c[0]?.traceId === traceId);
            expect(ourCall).toBeTruthy();
            const savedTrace = ourCall[0];
            expect(savedTrace.traceId).toBe(traceId);
            expect(savedTrace.totalLatencyMs).toBeGreaterThanOrEqual(0);
        });

        it("should return null for non-existent traceId", () => {
            expect(tc.finishTrace("nonexistent", "model")).toBeNull();
        });
    });

    // ── getTrace ──

    describe("getTrace", () => {
        it("should return the trace object for active trace", () => {
            const traceId = tc.startTrace(1, 5);
            const trace = tc.getTrace(traceId);
            expect(trace.traceId).toBe(traceId);
            expect(trace.userId).toBe(1);
            expect(trace.sessionId).toBe(5);
        });

        it("should return undefined for finished trace", () => {
            const traceId = tc.startTrace(1, 5);
            tc.finishTrace(traceId, "model");
            expect(tc.getTrace(traceId)).toBeUndefined();
        });
    });

    // ── concurrent traces ──

    describe("concurrent traces", () => {
        it("should support multiple simultaneous traces", () => {
            const id1 = tc.startTrace(1, 1, "chat");
            const id2 = tc.startTrace(1, 2, "eval");

            tc.startSpan(id1, "web_search", "tool");
            tc.startSpan(id2, "search_knowledge_base", "tool");

            const trace1 = tc.getTrace(id1);
            const trace2 = tc.getTrace(id2);
            expect(trace1.toolCallCount).toBe(1);
            expect(trace2.toolCallCount).toBe(1);
            expect(trace1.traceType).toBe("chat");
            expect(trace2.traceType).toBe("eval");

            // Finish them independently
            const result1 = tc.finishTrace(id1, "m1");
            const result2 = tc.finishTrace(id2, "m2");
            expect(result1.toolCallCount).toBe(1);
            expect(result2.toolCallCount).toBe(1);
        });
    });
});
