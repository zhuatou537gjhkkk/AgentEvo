/**
 * MetricsAggregator 单元测试 (Phase 6b G6)
 *
 * 测试百分位计算 + 各聚合方法的返回结构
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock DB functions — now accept userId as first arg
const mockLatencies = [];
const mockTokens = [];
const mockTraces = [];
const mockBuckets = [];

vi.mock("../../db/index.js", () => ({
    getMetricsLatencies: vi.fn((_userId, _cutoff) => mockLatencies),
    getMetricsTokens: vi.fn((_userId, _cutoff) => mockTokens),
    getMetricsTraces: vi.fn((_userId, _cutoff) => mockTraces),
    getMetricsDailyBuckets: vi.fn((_userId, _cutoff) => mockBuckets),
}));

import { MetricsAggregator, percentile, avg } from "../metrics.js";

describe("percentile", () => {
    it("should return 0 for empty array", () => {
        expect(percentile([], 50)).toBe(0);
    });

    it("should return the only value for single element", () => {
        expect(percentile([42], 50)).toBe(42);
        expect(percentile([42], 99)).toBe(42);
    });

    it("should compute P50 (median) correctly", () => {
        expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
        expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    });

    it("should compute P90 correctly", () => {
        const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        // idx = 0.9 * 9 = 8.1; lo=8(90), hi=9(100); 90 + (100-90)*0.1 = 91
        expect(percentile(data, 90)).toBe(91);
    });

    it("should compute P99 correctly", () => {
        const data = Array.from({ length: 100 }, (_, i) => i + 1);
        // idx = 0.99 * 99 = 98.01; lo=98(99), hi=99(100); 99 + 1*0.01 = 99.01
        expect(percentile(data, 99)).toBeCloseTo(99.01, 2);
    });

    it("should return min for P0 and max for P100", () => {
        expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
        expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
    });
});

describe("avg", () => {
    it("should return 0 for empty array", () => {
        expect(avg([])).toBe(0);
    });

    it("should compute average correctly", () => {
        expect(avg([10, 20, 30])).toBe(20);
        expect(avg([1])).toBe(1);
    });
});

describe("MetricsAggregator", () => {
    let agg;

    beforeEach(() => {
        agg = new MetricsAggregator();
        mockLatencies.length = 0;
        mockTokens.length = 0;
        mockTraces.length = 0;
        mockBuckets.length = 0;
    });

    // ── getLatencyStats ──

    describe("getLatencyStats", () => {
        it("should return all zeros when no data", () => {
            const stats = agg.getLatencyStats(1, "7d");
            expect(stats.p50).toBe(0);
            expect(stats.p90).toBe(0);
            expect(stats.p99).toBe(0);
            expect(stats.avg).toBe(0);
            expect(stats.sampleSize).toBe(0);
        });

        it("should compute P50/P90/P99 from latency data", () => {
            mockLatencies.push(
                { latency_ms: 100, created_at: "2026-08-06" },
                { latency_ms: 200, created_at: "2026-08-06" },
                { latency_ms: 300, created_at: "2026-08-06" },
                { latency_ms: 400, created_at: "2026-08-06" },
                { latency_ms: 500, created_at: "2026-08-06" },
            );
            const stats = agg.getLatencyStats(1, "7d");
            expect(stats.p50).toBe(300);
            expect(stats.avg).toBe(300);
            expect(stats.min).toBe(100);
            expect(stats.max).toBe(500);
            expect(stats.sampleSize).toBe(5);
        });

        it("should filter out null values", () => {
            mockLatencies.push(
                { latency_ms: null, created_at: "2026-08-06" },
                { latency_ms: 100, created_at: "2026-08-06" },
            );
            const stats = agg.getLatencyStats(1, "7d");
            expect(stats.sampleSize).toBe(1);
            expect(stats.avg).toBe(100);
        });
    });

    // ── getTokenDistribution ──

    describe("getTokenDistribution", () => {
        it("should return zeros when no data", () => {
            const dist = agg.getTokenDistribution(1, "7d");
            expect(dist.total.avg).toBe(0);
            expect(dist.sampleSize).toBe(0);
            expect(dist.modelDistribution).toEqual([]);
        });

        it("should compute token stats correctly", () => {
            mockTokens.push(
                { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, model: "m1", created_at: "2026-08-06" },
                { prompt_tokens: 50, completion_tokens: 150, total_tokens: 200, model: "m1", created_at: "2026-08-06" },
                { prompt_tokens: 80, completion_tokens: 120, total_tokens: 200, model: "m2", created_at: "2026-08-06" },
            );
            const dist = agg.getTokenDistribution(1, "7d");
            expect(dist.total.avg).toBe(233); // (300+200+200)/3 = 233
            expect(dist.prompt.avg).toBe(77);  // (100+50+80)/3 = 76.67 ≈ 77
            expect(dist.completion.avg).toBe(157); // (200+150+120)/3 = 156.67 ≈ 157
            expect(dist.modelDistribution).toHaveLength(2);
            expect(dist.modelDistribution[0]).toEqual({ model: "m1", count: 2 });
            expect(dist.sampleSize).toBe(3);
        });
    });

    // ── getSuccessRate ──

    describe("getSuccessRate", () => {
        it("should return 0 when no traces", () => {
            const rate = agg.getSuccessRate(1, "7d");
            expect(rate.successRate).toBe(0);
            expect(rate.total).toBe(0);
        });

        it("should compute success rate from error counts", () => {
            mockTraces.push(
                { error_count: 0, agent_traversal_path: "[]", tool_call_count: 1, total_latency_ms: 500, trace_type: "chat", created_at: "2026-08-06" },
                { error_count: 0, agent_traversal_path: "[]", tool_call_count: 2, total_latency_ms: 800, trace_type: "chat", created_at: "2026-08-06" },
                { error_count: 1, agent_traversal_path: "[]", tool_call_count: 1, total_latency_ms: 300, trace_type: "chat", created_at: "2026-08-06" },
            );
            const rate = agg.getSuccessRate(1, "7d");
            expect(rate.successRate).toBeCloseTo(0.6667, 2);
            expect(rate.total).toBe(3);
            expect(rate.succeeded).toBe(2);
            expect(rate.failed).toBe(1);
        });

        it("should handle error_count=null as success", () => {
            mockTraces.push(
                { error_count: null, agent_traversal_path: "[]", tool_call_count: 0, total_latency_ms: 100, trace_type: "chat", created_at: "2026-08-06" },
            );
            const rate = agg.getSuccessRate(1, "7d");
            expect(rate.succeeded).toBe(1);
        });
    });

    // ── getAgentPathFrequency ──

    describe("getAgentPathFrequency", () => {
        it("should parse and count agent paths", () => {
            mockTraces.push(
                { agent_traversal_path: JSON.stringify(["router", "search_agent", "synthesizer"]), error_count: 0, tool_call_count: 1, total_latency_ms: 500, trace_type: "chat", created_at: "2026-08-06" },
                { agent_traversal_path: JSON.stringify(["router", "search_agent", "synthesizer"]), error_count: 0, tool_call_count: 2, total_latency_ms: 800, trace_type: "chat", created_at: "2026-08-06" },
                { agent_traversal_path: JSON.stringify(["general_chat"]), error_count: 0, tool_call_count: 0, total_latency_ms: 200, trace_type: "chat", created_at: "2026-08-06" },
            );
            const freq = agg.getAgentPathFrequency(1, "7d");
            expect(freq.topPaths[0].path).toBe("router → search_agent → synthesizer");
            expect(freq.topPaths[0].count).toBe(2);
            expect(freq.topAgents.find(a => a.agent === "search_agent").count).toBe(2);
            expect(freq.totalTraces).toBe(3);
        });

        it("should handle invalid JSON gracefully", () => {
            mockTraces.push(
                { agent_traversal_path: "not json", error_count: 0, tool_call_count: 0, total_latency_ms: 100, trace_type: "chat", created_at: "2026-08-06" },
            );
            const freq = agg.getAgentPathFrequency(1, "7d");
            expect(freq.topPaths[0].path).toBe("(empty)");
            expect(freq.totalTraces).toBe(1);
        });
    });

    // ── getTrend ──

    describe("getTrend", () => {
        it("should fill empty days for 7d window", () => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().slice(0, 10);

            mockBuckets.push(
                { day: yesterdayStr, count: 2, avg_latency: 300, avg_tokens: 500 },
            );
            const trend = agg.getTrend(1, "7d");
            expect(trend).toHaveLength(7);
            // yesterday's bucket should be at position 5 (0-indexed: today is 6, yesterday is 5)
            const yesterdayEntry = trend.find(t => t.day === yesterdayStr);
            expect(yesterdayEntry).toBeDefined();
            expect(yesterdayEntry.count).toBe(2);
            // last element is today (may have count=0 if no data)
            const todayStr = new Date().toISOString().slice(0, 10);
            expect(trend[trend.length - 1].day).toBe(todayStr);
        });

        it("should not fill empty days for 'all' window", () => {
            mockBuckets.push(
                { day: "2026-08-01", count: 1, avg_latency: 100, avg_tokens: 200 },
            );
            const trend = agg.getTrend(1, "all");
            expect(trend).toHaveLength(1);
        });
    });

    // ── getFullReport ──

    describe("getFullReport", () => {
        it("should return all sections in one call", () => {
            const report = agg.getFullReport(1, "30d");
            expect(report.window).toBe("30d");
            expect(report.latency).toBeDefined();
            expect(report.tokens).toBeDefined();
            expect(report.successRate).toBeDefined();
            expect(report.agentPaths).toBeDefined();
            expect(report.trend).toBeDefined();
        });
    });
});
