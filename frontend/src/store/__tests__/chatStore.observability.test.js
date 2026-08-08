/**
 * Store Observability Actions 单元测试 — Phase 6b G9
 *
 * 覆盖：
 *   - 初始状态: isObservabilityOpen / observabilityTraces / observabilityTraceDetail / observabilityMetrics
 *   - toggleObservability: 开关切换
 *   - fetchObservabilityTraces: loading → 数据更新 → 错误处理
 *   - fetchObservabilityTraceDetail: 详情加载
 *   - fetchObservabilityMetrics: window 参数传递
 *
 * 运行: npx vitest run src/store/__tests__/chatStore.observability.test.js
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useChatStore } from "../chatStore";

// 获取模块级 get/set（绕过 React hook 限制）
const getState = () => useChatStore.getState();
const setState = (patch) => useChatStore.setState(patch);

// ═══════════════════════════════════════════════════════
// Mock fetch API
// ═══════════════════════════════════════════════════════

const originalFetch = globalThis.fetch;

beforeEach(() => {
    setState({
        isObservabilityOpen: false,
        observabilityTraces: [],
        observabilityTracesLoading: false,
        observabilityTraceDetail: null,
        observabilityMetrics: null,
    });
    globalThis.fetch = vi.fn();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ═══════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════

describe("observability — initial state", () => {
    it("isObservabilityOpen should default to false", () => {
        expect(getState().isObservabilityOpen).toBe(false);
    });

    it("observabilityTraces should default to empty array", () => {
        expect(Array.isArray(getState().observabilityTraces)).toBe(true);
        expect(getState().observabilityTraces).toHaveLength(0);
    });

    it("observabilityTracesLoading should default to false", () => {
        expect(getState().observabilityTracesLoading).toBe(false);
    });

    it("observabilityTraceDetail should default to null", () => {
        expect(getState().observabilityTraceDetail).toBeNull();
    });

    it("observabilityMetrics should default to null", () => {
        expect(getState().observabilityMetrics).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════
// toggleObservability
// ═══════════════════════════════════════════════════════

describe("toggleObservability", () => {
    it("should toggle from false to true", () => {
        const { toggleObservability } = getState();
        toggleObservability();
        expect(getState().isObservabilityOpen).toBe(true);
    });

    it("should toggle from true to false", () => {
        setState({ isObservabilityOpen: true });
        const { toggleObservability } = getState();
        toggleObservability();
        expect(getState().isObservabilityOpen).toBe(false);
    });

    it("should toggle back and forth correctly", () => {
        const { toggleObservability } = getState();
        toggleObservability();
        expect(getState().isObservabilityOpen).toBe(true);
        toggleObservability();
        expect(getState().isObservabilityOpen).toBe(false);
        toggleObservability();
        expect(getState().isObservabilityOpen).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════
// fetchObservabilityTraces
// ═══════════════════════════════════════════════════════

describe("fetchObservabilityTraces", () => {
    it("should set loading=true before fetch", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, traces: [] }),
        });

        expect(getState().observabilityTracesLoading).toBe(false);
        const promise = getState().fetchObservabilityTraces(30);
        expect(getState().observabilityTracesLoading).toBe(true);
        await promise;
    });

    it("should populate traces on successful fetch", async () => {
        const mockTraces = [
            {
                trace_id: "tr-1",
                trace_type: "chat",
                agent_traversal_path: ["router", "search_agent"],
                tool_call_count: 2,
                error_count: 0,
                total_latency_ms: 1200,
                model: "deepseek-v4",
                created_at: "2026-08-07T10:00:00.000Z",
            },
            {
                trace_id: "tr-2",
                trace_type: "eval",
                agent_traversal_path: ["planner", "synthesizer"],
                tool_call_count: 0,
                error_count: 1,
                total_latency_ms: 800,
                model: "opus-5",
                created_at: "2026-08-07T09:00:00.000Z",
            },
        ];

        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, traces: mockTraces }),
        });

        await getState().fetchObservabilityTraces(20);

        const state = getState();
        expect(state.observabilityTraces).toEqual(mockTraces);
        expect(state.observabilityTraces).toHaveLength(2);
        expect(state.observabilityTracesLoading).toBe(false);
    });

    it("should handle empty traces array", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, traces: [] }),
        });

        await getState().fetchObservabilityTraces(30);
        expect(getState().observabilityTraces).toEqual([]);
        expect(getState().observabilityTracesLoading).toBe(false);
    });

    it("should set loading=false when response is not ok", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: false }),
        });

        await getState().fetchObservabilityTraces(30);
        expect(getState().observabilityTracesLoading).toBe(false);
    });

    it("should set loading=false on network error", async () => {
        fetch.mockRejectedValueOnce(new Error("Network error"));

        await getState().fetchObservabilityTraces(30);
        expect(getState().observabilityTracesLoading).toBe(false);
    });

    it("should use default limit=30 when not specified", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, traces: [] }),
        });

        await getState().fetchObservabilityTraces();

        const [url] = fetch.mock.calls[0];
        expect(url).toContain("limit=30");
    });
});

// ═══════════════════════════════════════════════════════
// fetchObservabilityTraceDetail
// ═══════════════════════════════════════════════════════

describe("fetchObservabilityTraceDetail", () => {
    it("should populate traceDetail on successful fetch", async () => {
        const mockTraceDetail = {
            trace_id: "tr-detail-1",
            trace_type: "chat",
            total_latency_ms: 1500,
            tool_call_count: 1,
            error_count: 0,
            model: "deepseek-v4",
            agent_traversal_path: ["router", "search_agent", "synthesizer"],
            root_span: {
                id: "root-1",
                name: "root",
                type: "root",
                children: [
                    { id: "span-1", name: "router", type: "agent", durationMs: 400, children: [] },
                    { id: "span-2", name: "web_search", type: "tool", durationMs: 600, children: [] },
                ],
            },
            created_at: "2026-08-07T10:00:00.000Z",
        };

        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, trace: mockTraceDetail }),
        });

        await getState().fetchObservabilityTraceDetail("tr-detail-1");

        const state = getState();
        expect(state.observabilityTraceDetail.trace_id).toBe("tr-detail-1");
        expect(state.observabilityTraceDetail.agent_traversal_path).toEqual([
            "router",
            "search_agent",
            "synthesizer",
        ]);
        expect(state.observabilityTraceDetail.root_span.children).toHaveLength(2);
    });

    it("should handle fetch error gracefully", async () => {
        // Should not throw
        fetch.mockRejectedValueOnce(new Error("Network error"));
        await expect(
            getState().fetchObservabilityTraceDetail("bad-id")
        ).resolves.toBeNull();
    });
});

// ═══════════════════════════════════════════════════════
// fetchObservabilityMetrics
// ═══════════════════════════════════════════════════════

describe("fetchObservabilityMetrics", () => {
    it("should populate metrics on successful fetch", async () => {
        const mockMetrics = {
            window: "7d",
            latency: { p50: 300, p90: 800, p99: 1200, avg: 350, min: 100, max: 1500, sampleSize: 10 },
            tokens: {
                total: { avg: 500, p50: 450, p90: 900 },
                prompt: { avg: 200 },
                completion: { avg: 300 },
                modelDistribution: [{ model: "deepseek-v4", count: 8 }],
                sampleSize: 10,
            },
            successRate: { successRate: 0.9, total: 10, succeeded: 9, failed: 1 },
            agentPaths: {
                topPaths: [{ path: "router → search_agent → synthesizer", count: 6 }],
                topAgents: [{ agent: "search_agent", count: 6 }],
                totalTraces: 10,
            },
            trend: [{ day: "2026-08-07", count: 4, avg_latency: 300, avg_tokens: 500 }],
        };

        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, ...mockMetrics }),
        });

        await getState().fetchObservabilityMetrics("7d");

        const state = getState();
        expect(state.observabilityMetrics.latency.p50).toBe(300);
        expect(state.observabilityMetrics.tokens.total.avg).toBe(500);
        expect(state.observabilityMetrics.successRate.successRate).toBe(0.9);
        expect(state.observabilityMetrics.agentPaths.topPaths).toHaveLength(1);
    });

    it("should pass window param in query string", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
        });

        await getState().fetchObservabilityMetrics("30d");

        const [url] = fetch.mock.calls[0];
        expect(url).toContain("window=30d");
    });

    it("should default to window=7d when not specified", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
        });

        await getState().fetchObservabilityMetrics();

        const [url] = fetch.mock.calls[0];
        expect(url).toContain("window=7d");
    });

    it("should handle fetch error gracefully", async () => {
        fetch.mockRejectedValueOnce(new Error("Network error"));
        await expect(
            getState().fetchObservabilityMetrics("7d")
        ).resolves.toBeNull();
    });
});

// ═══════════════════════════════════════════════════════
// 状态隔离: observability 不影响其他 state
// ═══════════════════════════════════════════════════════

describe("observability — state isolation", () => {
    it("should not affect messages when observability state changes", () => {
        const before = getState().messages;
        setState({
            isObservabilityOpen: true,
            observabilityTraces: [{ trace_id: "x", trace_type: "chat", agent_traversal_path: [], tool_call_count: 0, error_count: 0, total_latency_ms: 100, model: "test", created_at: "2026-08-07T00:00:00.000Z" }],
            observabilityTraceDetail: null,
            observabilityMetrics: null,
        });
        expect(getState().messages).toBe(before);
    });
});

// ═══════════════════════════════════════════════════════
// Phase 6c OTel: importOtelTrace / exportTraceAsOtel
// ═══════════════════════════════════════════════════════

describe("importOtelTrace", () => {
    it("should call POST /observability/otel/import with otel body", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, trace_id: "otel-abc", db_id: 1, spans: 3 }),
        });

        const result = await getState().importOtelTrace({ resourceSpans: [] }, 5);

        const [url, opts] = fetch.mock.calls[0];
        expect(url).toContain("/observability/otel/import");
        expect(opts.method).toBe("POST");
        expect(opts.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(opts.body);
        expect(body.otel).toBeDefined();
        expect(body.session_id).toBe(5);

        expect(result.ok).toBe(true);
        expect(result.trace_id).toBe("otel-abc");
    });

    it("should handle import error gracefully", async () => {
        fetch.mockRejectedValueOnce(new Error("Network error"));
        const result = await getState().importOtelTrace({});
        expect(result.ok).toBe(false);
        expect(result.message).toBeTruthy();
    });

    it("should handle server error response", async () => {
        fetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ ok: false, message: "no valid spans found" }),
        });

        const result = await getState().importOtelTrace({ resourceSpans: [] });
        expect(result.ok).toBe(false);
    });

    it("should default sessionId to 0", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, trace_id: "otel-xyz", spans: 1 }),
        });

        await getState().importOtelTrace({ resourceSpans: [] });

        const [, opts] = fetch.mock.calls[0];
        const body = JSON.parse(opts.body);
        expect(body.session_id).toBe(0);
    });
});

describe("exportTraceAsOtel", () => {
    it("should call GET /observability/traces/:traceId/otel", async () => {
        const mockOtel = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-evo" } }] },
                scopeSpans: [{ scope: { name: "agent-evo-agent" }, spans: [] }],
            }],
        };

        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, otel: mockOtel }),
        });

        const result = await getState().exportTraceAsOtel("test-trace-id");

        const [url] = fetch.mock.calls[0];
        expect(url).toContain("/observability/traces/test-trace-id/otel");

        expect(result.ok).toBe(true);
        expect(result.otel).toEqual(mockOtel);
    });

    it("should handle export error gracefully", async () => {
        fetch.mockRejectedValueOnce(new Error("Network error"));
        const result = await getState().exportTraceAsOtel("bad-id");
        expect(result.ok).toBe(false);
        expect(result.message).toBeTruthy();
    });

    it("should handle 404 for non-existent trace", async () => {
        fetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ ok: false, message: "trace not found" }),
        });

        const result = await getState().exportTraceAsOtel("nonexistent");
        expect(result.ok).toBe(false);
    });

    it("should URL-encode traceId with special chars", async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ok: true, otel: {} }),
        });

        await getState().exportTraceAsOtel("trace/id/with/slashes");

        const [url] = fetch.mock.calls[0];
        expect(url).toContain("trace%2Fid%2Fwith%2Fslashes");
    });
});
