/**
 * OTel 格式映射单元测试 (Phase 6c OTel)
 *
 * 测试:
 *   - TraceCollector.toOpenTelemetry() 导出
 *   - otelToInternalTrace() 导入
 *   - 格式往返一致性
 */

import { describe, it, expect } from "vitest";
import { TraceCollector } from "../collector.js";
import { otelToInternalTrace } from "../import.js";

// ═══════════════════════════════════════════════════
// TraceCollector.toOpenTelemetry()
// ═══════════════════════════════════════════════════

describe("TraceCollector.toOpenTelemetry", () => {
    it("should return null for null/undefined input", () => {
        expect(TraceCollector.toOpenTelemetry(null)).toBeNull();
        expect(TraceCollector.toOpenTelemetry(undefined)).toBeNull();
    });

    it("should return null for trace without rootSpan", () => {
        expect(TraceCollector.toOpenTelemetry({ traceId: "test" })).toBeNull();
    });

    it("should convert a simple trace to OTel format", () => {
        const traceRecord = {
            traceId: "test-trace-1",
            rootSpan: {
                id: "root-1",
                name: "root",
                type: "root",
                parentSpanId: null,
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:01.000Z",
                durationMs: 1000,
                metadata: { input: "hello" },
                children: [],
            },
            agentTraversalPath: ["router", "search_agent"],
            toolCallCount: 2,
            errorCount: 0,
            model: "deepseek-v4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        expect(otel).toBeTruthy();
        expect(otel.resourceSpans).toBeInstanceOf(Array);
        expect(otel.resourceSpans.length).toBe(1);
        expect(otel.resourceSpans[0].resource).toBeTruthy();
        expect(otel.resourceSpans[0].scopeSpans).toBeInstanceOf(Array);
        expect(otel.resourceSpans[0].scopeSpans.length).toBe(1);

        const spans = otel.resourceSpans[0].scopeSpans[0].spans;
        expect(spans).toBeInstanceOf(Array);
        expect(spans.length).toBe(1); // only root span
        expect(spans[0].name).toBe("root");
        expect(spans[0].spanId).toBe("root-1");
        expect(spans[0].kind).toBe(1); // SPAN_KIND_SERVER for root
    });

    it("should include nested spans in OTel output", () => {
        const traceRecord = {
            traceId: "test-trace-2",
            rootSpan: {
                id: "root-2",
                name: "root",
                type: "root",
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:01.500Z",
                durationMs: 1500,
                metadata: {},
                children: [
                    {
                        id: "child-1",
                        name: "router",
                        type: "agent",
                        parentSpanId: "root-2",
                        startedAt: "2026-08-08T10:00:00.100Z",
                        endedAt: "2026-08-08T10:00:00.500Z",
                        durationMs: 400,
                        metadata: { intent: "search" },
                        children: [
                            {
                                id: "tool-1",
                                name: "web_search",
                                type: "tool",
                                parentSpanId: "child-1",
                                startedAt: "2026-08-08T10:00:00.200Z",
                                endedAt: "2026-08-08T10:00:00.450Z",
                                durationMs: 250,
                                metadata: { query: "test query" },
                                children: [],
                            },
                        ],
                    },
                ],
            },
            agentTraversalPath: ["router"],
            toolCallCount: 1,
            errorCount: 0,
            model: "deepseek-v4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        const spans = otel.resourceSpans[0].scopeSpans[0].spans;
        expect(spans.length).toBe(3); // root + agent + tool
    });

    it("should set error status for spans with error metadata", () => {
        const traceRecord = {
            traceId: "test-trace-3",
            rootSpan: {
                id: "root-3",
                name: "root",
                type: "root",
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:01.000Z",
                durationMs: 1000,
                metadata: { error: "timeout" },
                children: [],
            },
            agentTraversalPath: [],
            toolCallCount: 0,
            errorCount: 1,
            model: "deepseek-v4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        const span = otel.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.status.code).toBe(2);
        expect(span.status.message).toBe("timeout");
    });

    it("should include resource-level attributes", () => {
        const traceRecord = {
            traceId: "test-trace-4",
            rootSpan: {
                id: "root-4",
                name: "root",
                type: "root",
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:01.000Z",
                durationMs: 1000,
                metadata: {},
                children: [],
            },
            agentTraversalPath: ["router"],
            toolCallCount: 3,
            errorCount: 1,
            model: "deepseek-v4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        const attrs = otel.resourceSpans[0].resource.attributes;
        const serviceName = attrs.find((a) => a.key === "service.name");
        expect(serviceName.value.stringValue).toBe("agent-evo");

        const toolCount = attrs.find((a) => a.key === "gen_ai.agent.tool_call_count");
        expect(toolCount.value.intValue).toBe("3");
    });

    it("should handle metadata with non-string values", () => {
        const traceRecord = {
            traceId: "test-trace-5",
            rootSpan: {
                id: "root-5",
                name: "root",
                type: "root",
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:01.000Z",
                durationMs: 1000,
                metadata: { count: 42, flag: true, arr: [1, 2, 3] },
                children: [],
            },
            agentTraversalPath: [],
            toolCallCount: 0,
            errorCount: 0,
            model: "deepseek-v4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        const span = otel.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.status.code).toBe(1); // OK status
    });

    it("should handle trace records from DB (snake_case fields)", () => {
        const traceRecord = {
            trace_id: "db-trace-1",
            rootSpan: {
                id: "root-db",
                name: "root",
                type: "root",
                startedAt: "2026-08-07T00:00:00.000Z",
                endedAt: "2026-08-07T00:00:02.000Z",
                durationMs: 2000,
                metadata: {},
                children: [],
            },
            agentTraversalPath: [],
            toolCallCount: 0,
            errorCount: 0,
            model: "gpt-4",
        };

        const otel = TraceCollector.toOpenTelemetry(traceRecord);
        expect(otel).toBeTruthy();
        // should use trace_id fallback
        const span = otel.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.traceId).toBe("db-trace-1");
    });
});

// ═══════════════════════════════════════════════════
// otelToInternalTrace()
// ═══════════════════════════════════════════════════

describe("otelToInternalTrace", () => {
    it("should return null for null/undefined input", () => {
        expect(otelToInternalTrace(null)).toBeNull();
        expect(otelToInternalTrace(undefined)).toBeNull();
    });

    it("should return null for empty resourceSpans", () => {
        expect(otelToInternalTrace({ resourceSpans: [] })).toBeNull();
        expect(otelToInternalTrace({})).toBeNull();
    });

    it("should convert a simple OTel trace to internal format", () => {
        const otel = {
            resourceSpans: [{
                resource: {
                    attributes: [
                        { key: "service.name", value: { stringValue: "test-service" } },
                    ],
                },
                scopeSpans: [{
                    scope: { name: "test-scope" },
                    spans: [{
                        traceId: "abc123def456",
                        spanId: "span-1",
                        parentSpanId: "",
                        name: "my-operation",
                        kind: 1, // INTERNAL → agent
                        startTimeUnixNano: "1749000000000000000",
                        endTimeUnixNano: "1749000001000000000",
                        attributes: [
                            { key: "custom.key", value: { stringValue: "custom-value" } },
                        ],
                        status: { code: 1 },
                    }],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel, { userId: 1, sessionId: 5 });
        expect(internal).toBeTruthy();
        expect(internal.userId).toBe(1);
        expect(internal.sessionId).toBe(5);
        expect(internal.traceType).toBe("import");
        expect(internal.traceId).toMatch(/^otel-/);
        expect(internal.model).toBe("external");
        expect(internal.rootSpan).toBeTruthy();
        expect(internal.rootSpan.name).toBe("my-operation");
        expect(internal.rootSpan.type).toBe("agent"); // INTERNAL → agent
        expect(internal.rootSpan.children).toBeInstanceOf(Array);
    });

    it("should rebuild parent-child relationships from parentSpanId", () => {
        const otel = {
            resourceSpans: [{
                resource: {
                    attributes: [{ key: "service.name", value: { stringValue: "test" } }],
                },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [
                        {
                            traceId: "trace-1",
                            spanId: "parent-span",
                            parentSpanId: "",
                            name: "parent-operation",
                            kind: 2, // SERVER → root
                            startTimeUnixNano: "1749000000000000000",
                            endTimeUnixNano: "1749000002000000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                        {
                            traceId: "trace-1",
                            spanId: "child-span",
                            parentSpanId: "parent-span",
                            name: "child-operation",
                            kind: 3, // CLIENT → tool
                            startTimeUnixNano: "1749000000500000000",
                            endTimeUnixNano: "1749000001500000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                    ],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.rootSpan.name).toBe("parent-operation");
        expect(internal.rootSpan.children.length).toBe(1);
        expect(internal.rootSpan.children[0].name).toBe("child-operation");
        expect(internal.rootSpan.children[0].type).toBe("tool");
    });

    it("should create a synthetic root for multiple root spans", () => {
        const otel = {
            resourceSpans: [{
                resource: {
                    attributes: [{ key: "service.name", value: { stringValue: "test" } }],
                },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [
                        {
                            traceId: "trace-1",
                            spanId: "span-a",
                            parentSpanId: "",
                            name: "op-a",
                            kind: 1,
                            startTimeUnixNano: "1749000000000000000",
                            endTimeUnixNano: "1749000001000000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                        {
                            traceId: "trace-1",
                            spanId: "span-b",
                            parentSpanId: "",
                            name: "op-b",
                            kind: 1,
                            startTimeUnixNano: "1749000000500000000",
                            endTimeUnixNano: "1749000001500000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                    ],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.rootSpan.name).toBe("imported-trace");
        expect(internal.rootSpan.type).toBe("root");
        expect(internal.rootSpan.children.length).toBe(2);
    });

    it("should mark errored spans", () => {
        const otel = {
            resourceSpans: [{
                resource: {
                    attributes: [{ key: "service.name", value: { stringValue: "test" } }],
                },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [{
                        traceId: "trace-err",
                        spanId: "err-span",
                        parentSpanId: "",
                        name: "failed-op",
                        kind: 1,
                        startTimeUnixNano: "1749000000000000000",
                        endTimeUnixNano: "1749000001000000000",
                        attributes: [],
                        status: { code: 2, message: "something went wrong" },
                    }],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.errorCount).toBe(1);
        expect(internal.rootSpan.metadata.error).toBe("something went wrong");
    });

    it("should handle numeric spanId fields", () => {
        const otel = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [{
                        traceId: "trace-num",
                        spanId: 12345,
                        parentSpanId: 0,
                        name: "num-op",
                        kind: 1,
                        startTimeUnixNano: 1749000000000000000,
                        endTimeUnixNano: 1749000001000000000,
                        attributes: [],
                        status: { code: 1 },
                    }],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.rootSpan.id).toBe("12345");
        // parentSpanId=0 means root span (falsy → no parent)
        expect(internal.rootSpan.parentSpanId).toBeNull();
    });

    it("should handle string nanosecond timestamps", () => {
        const otel = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [{
                        traceId: "trace-str",
                        spanId: "s1",
                        parentSpanId: "",
                        name: "str-op",
                        kind: 1,
                        startTimeUnixNano: "1749000000000000000",
                        endTimeUnixNano: "1749000001500000000",
                        attributes: [],
                        status: { code: 1 },
                    }],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.rootSpan.durationMs).toBe(1500); // 1.5 seconds
    });

    it("should extract attributes as metadata", () => {
        const otel = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [{
                        traceId: "trace-attrs",
                        spanId: "attr-span",
                        parentSpanId: "",
                        name: "attr-op",
                        kind: 1,
                        startTimeUnixNano: "1749000000000000000",
                        endTimeUnixNano: "1749000001000000000",
                        attributes: [
                            { key: "gen_ai.agent.name", value: { stringValue: "router" } },
                            { key: "custom.int", value: { intValue: "42" } },
                            { key: "custom.bool", value: { boolValue: true } },
                        ],
                        status: { code: 1 },
                    }],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        const meta = internal.rootSpan.metadata;
        expect(meta["gen_ai.agent.name"]).toBe("router");
        expect(meta["custom.int"]).toBe("42");
        expect(meta["custom.bool"]).toBe(true);
    });

    it("should count tool spans and collect agent path", () => {
        const otel = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
                scopeSpans: [{
                    scope: { name: "test" },
                    spans: [
                        {
                            traceId: "trace-path",
                            spanId: "root",
                            parentSpanId: "",
                            name: "entry",
                            kind: 2, // SERVER → root
                            startTimeUnixNano: "1749000000000000000",
                            endTimeUnixNano: "1749000003000000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                        {
                            traceId: "trace-path",
                            spanId: "agent",
                            parentSpanId: "root",
                            name: "search_agent",
                            kind: 1, // INTERNAL → agent
                            startTimeUnixNano: "1749000000500000000",
                            endTimeUnixNano: "1749000002000000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                        {
                            traceId: "trace-path",
                            spanId: "tool1",
                            parentSpanId: "agent",
                            name: "web_search",
                            kind: 3, // CLIENT → tool
                            startTimeUnixNano: "1749000001000000000",
                            endTimeUnixNano: "1749000001500000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                        {
                            traceId: "trace-path",
                            spanId: "tool2",
                            parentSpanId: "agent",
                            name: "get_system_time",
                            kind: 3, // CLIENT → tool
                            startTimeUnixNano: "1749000001200000000",
                            endTimeUnixNano: "1749000001300000000",
                            attributes: [],
                            status: { code: 1 },
                        },
                    ],
                }],
            }],
        };

        const internal = otelToInternalTrace(otel);
        expect(internal).toBeTruthy();
        expect(internal.rootSpan.name).toBe("entry");
        expect(internal.rootSpan.type).toBe("root");
        expect(internal.rootSpan.children.length).toBe(1);
        expect(internal.rootSpan.children[0].name).toBe("search_agent");
        expect(internal.rootSpan.children[0].type).toBe("agent");
        expect(internal.rootSpan.children[0].children.length).toBe(2);
        expect(internal.agentTraversalPath).toContain("search_agent");
        expect(internal.toolCallCount).toBe(2);
    });
});

// ═══════════════════════════════════════════════════
// 往返测试 (round-trip)
// ═══════════════════════════════════════════════════

describe("OTel round-trip", () => {
    it("should preserve span hierarchy through export→import cycle", () => {
        const original = {
            traceId: "rt-trace-1",
            rootSpan: {
                id: "rt-root",
                name: "root",
                type: "root",
                startedAt: "2026-08-08T10:00:00.000Z",
                endedAt: "2026-08-08T10:00:02.000Z",
                durationMs: 2000,
                metadata: { input: "test" },
                children: [
                    {
                        id: "rt-agent",
                        name: "router",
                        type: "agent",
                        parentSpanId: "rt-root",
                        startedAt: "2026-08-08T10:00:00.100Z",
                        endedAt: "2026-08-08T10:00:01.900Z",
                        durationMs: 1800,
                        metadata: { intent: "search" },
                        children: [
                            {
                                id: "rt-tool",
                                name: "web_search",
                                type: "tool",
                                parentSpanId: "rt-agent",
                                startedAt: "2026-08-08T10:00:00.200Z",
                                endedAt: "2026-08-08T10:00:01.500Z",
                                durationMs: 1300,
                                metadata: { query: "AI news" },
                                children: [],
                            },
                        ],
                    },
                ],
            },
            agentTraversalPath: ["router"],
            toolCallCount: 1,
            errorCount: 0,
            model: "deepseek-v4",
        };

        // Export → OTel
        const otel = TraceCollector.toOpenTelemetry(original);
        expect(otel).toBeTruthy();

        // Import → Internal
        const imported = otelToInternalTrace(otel);
        expect(imported).toBeTruthy();

        // Verify hierarchy preserved
        expect(imported.toolCallCount).toBe(1);
        expect(imported.agentTraversalPath).toContain("router");

        // Root → agent → tool chain
        const rootChildren = imported.rootSpan.children;
        expect(rootChildren.length).toBe(1);
        expect(rootChildren[0].name).toBe("router");
        expect(rootChildren[0].type).toBe("agent");
        expect(rootChildren[0].children.length).toBe(1);
        expect(rootChildren[0].children[0].name).toBe("web_search");
        expect(rootChildren[0].children[0].type).toBe("tool");
    });
});
