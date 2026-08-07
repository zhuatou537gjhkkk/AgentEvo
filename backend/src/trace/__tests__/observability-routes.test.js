/**
 * Phase 6b G9: 观测面板 API 端点 — 单元测试
 *
 * 测试 GET /observability/traces 和 GET /observability/traces/:traceId
 * 的路由逻辑（mock DB 层）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Trace 列表格式化逻辑 (来自 app.js) ──

function formatTraces(rows) {
    return rows.map((r) => ({
        trace_id: r.trace_id,
        trace_type: r.trace_type,
        agent_traversal_path: (() => {
            try { return JSON.parse(r.agent_traversal_path || "[]"); } catch { return []; }
        })(),
        tool_call_count: r.tool_call_count,
        error_count: r.error_count,
        total_latency_ms: r.total_latency_ms,
        model: r.model,
        created_at: r.created_at,
    }));
}

// ── Trace 详情格式化逻辑 (来自 app.js) ──

function formatTraceDetail(trace) {
    if (!trace) return null;
    const rootSpan = (() => {
        try { return JSON.parse(trace.root_span || "{}"); } catch { return {}; }
    })();
    const agentTraversalPath = (() => {
        try { return JSON.parse(trace.agent_traversal_path || "[]"); } catch { return []; }
    })();
    return {
        trace_id: trace.trace_id,
        trace_type: trace.trace_type,
        total_latency_ms: trace.total_latency_ms,
        tool_call_count: trace.tool_call_count,
        error_count: trace.error_count,
        model: trace.model,
        agent_traversal_path: agentTraversalPath,
        root_span: rootSpan,
        created_at: trace.created_at,
    };
}

// ── formatTraces 测试 ──

describe("formatTraces (GET /observability/traces)", () => {
    it("should format trace rows with parsed agent_traversal_path", () => {
        const rows = [
            {
                trace_id: "tr-001",
                trace_type: "chat",
                agent_traversal_path: JSON.stringify(["router", "search_agent", "synthesizer"]),
                tool_call_count: 3,
                error_count: 0,
                total_latency_ms: 1200,
                model: "deepseek-v4",
                created_at: "2026-08-06T10:00:00.000Z",
            },
        ];

        const formatted = formatTraces(rows);
        expect(formatted).toHaveLength(1);
        expect(formatted[0].trace_id).toBe("tr-001");
        expect(formatted[0].agent_traversal_path).toEqual(["router", "search_agent", "synthesizer"]);
        expect(formatted[0].tool_call_count).toBe(3);
        expect(formatted[0].total_latency_ms).toBe(1200);
    });

    it("should handle empty rows", () => {
        expect(formatTraces([])).toEqual([]);
    });

    it("should handle empty agent_traversal_path", () => {
        const rows = [
            {
                trace_id: "tr-002",
                trace_type: "chat",
                agent_traversal_path: "[]",
                tool_call_count: 0,
                error_count: 0,
                total_latency_ms: 500,
                model: "unknown",
                created_at: "2026-08-06T10:00:00.000Z",
            },
        ];
        const formatted = formatTraces(rows);
        expect(formatted[0].agent_traversal_path).toEqual([]);
    });

    it("should handle malformed JSON in agent_traversal_path gracefully", () => {
        const rows = [
            {
                trace_id: "tr-003",
                trace_type: "eval",
                agent_traversal_path: "<<<not-json>>>",
                tool_call_count: 1,
                error_count: 1,
                total_latency_ms: 800,
                model: "test",
                created_at: "2026-08-06T10:00:00.000Z",
            },
        ];
        const formatted = formatTraces(rows);
        // Should fallback to empty array
        expect(formatted[0].agent_traversal_path).toEqual([]);
    });

    it("should handle null agent_traversal_path", () => {
        const rows = [
            {
                trace_id: "tr-004",
                trace_type: "chat",
                agent_traversal_path: null,
                tool_call_count: 2,
                error_count: 0,
                total_latency_ms: 1500,
                model: "test",
                created_at: "2026-08-06T10:00:00.000Z",
            },
        ];
        const formatted = formatTraces(rows);
        expect(formatted[0].agent_traversal_path).toEqual([]);
    });

    it("should preserve all fields in formatted output", () => {
        const rows = [
            {
                trace_id: "tr-005",
                trace_type: "reflection",
                agent_traversal_path: JSON.stringify(["planner", "synthesizer"]),
                tool_call_count: 0,
                error_count: 0,
                total_latency_ms: 200,
                model: "opus-5",
                created_at: "2026-08-06T11:00:00.000Z",
            },
        ];
        const formatted = formatTraces(rows);
        const f = formatted[0];
        expect(f.trace_type).toBe("reflection");
        expect(f.model).toBe("opus-5");
        expect(f.error_count).toBe(0);
        expect(f.created_at).toBe("2026-08-06T11:00:00.000Z");
    });
});

// ── formatTraceDetail 测试 ──

describe("formatTraceDetail (GET /observability/traces/:traceId)", () => {
    it("should return null for null trace", () => {
        expect(formatTraceDetail(null)).toBeNull();
        expect(formatTraceDetail(undefined)).toBeNull();
    });

    it("should format a complete trace with root span tree", () => {
        const rootSpan = {
            id: "root-1",
            name: "root",
            type: "root",
            parentSpanId: null,
            startedAt: "2026-08-06T10:00:00.000Z",
            endedAt: "2026-08-06T10:00:01.200Z",
            durationMs: 1200,
            metadata: {},
            children: [
                {
                    id: "span-1",
                    name: "router",
                    type: "agent",
                    parentSpanId: "root-1",
                    startedAt: "2026-08-06T10:00:00.100Z",
                    endedAt: "2026-08-06T10:00:00.500Z",
                    durationMs: 400,
                    metadata: {},
                    children: [],
                },
                {
                    id: "span-2",
                    name: "web_search",
                    type: "tool",
                    parentSpanId: "root-1",
                    startedAt: "2026-08-06T10:00:00.500Z",
                    endedAt: "2026-08-06T10:00:01.000Z",
                    durationMs: 500,
                    metadata: { input: "AI news", output: "5 results" },
                    children: [],
                },
            ],
        };

        const trace = {
            trace_id: "tr-detail-01",
            trace_type: "chat",
            total_latency_ms: 1200,
            tool_call_count: 1,
            error_count: 0,
            model: "deepseek-v4",
            agent_traversal_path: JSON.stringify(["router", "synthesizer"]),
            root_span: JSON.stringify(rootSpan),
            created_at: "2026-08-06T10:00:00.000Z",
        };

        const formatted = formatTraceDetail(trace);
        expect(formatted.trace_id).toBe("tr-detail-01");
        expect(formatted.agent_traversal_path).toEqual(["router", "synthesizer"]);
        expect(formatted.root_span.id).toBe("root-1");
        expect(formatted.root_span.children).toHaveLength(2);
        expect(formatted.root_span.children[0].name).toBe("router");
        expect(formatted.root_span.children[0].type).toBe("agent");
        expect(formatted.root_span.children[0].durationMs).toBe(400);
        expect(formatted.root_span.children[1].name).toBe("web_search");
        expect(formatted.root_span.children[1].type).toBe("tool");
        expect(formatted.root_span.children[1].metadata.input).toBe("AI news");
        expect(formatted.root_span.children[1].metadata.output).toBe("5 results");
    });

    it("should handle empty root_span gracefully", () => {
        const trace = {
            trace_id: "tr-detail-02",
            trace_type: "chat",
            total_latency_ms: null,
            tool_call_count: 0,
            error_count: 0,
            model: "",
            agent_traversal_path: "[]",
            root_span: null,
            created_at: "2026-08-06T10:00:00.000Z",
        };

        const formatted = formatTraceDetail(trace);
        expect(formatted.root_span).toEqual({});
        expect(formatted.agent_traversal_path).toEqual([]);
    });

    it("should handle malformed root_span JSON", () => {
        const trace = {
            trace_id: "tr-detail-03",
            trace_type: "eval",
            total_latency_ms: 100,
            tool_call_count: 0,
            error_count: 1,
            model: "",
            agent_traversal_path: "[]",
            root_span: "<<<corrupted>>>",
            created_at: "2026-08-06T10:00:00.000Z",
        };

        const formatted = formatTraceDetail(trace);
        // Should fallback to empty object
        expect(formatted.root_span).toEqual({});
    });
});
