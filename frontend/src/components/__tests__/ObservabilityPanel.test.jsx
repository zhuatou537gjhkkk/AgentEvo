/**
 * ObservabilityPanel 组件测试 — Phase 6b G9
 *
 * 覆盖：
 *   - SPAN_TYPE_COLORS / TRACE_TYPE_COLORS / PATH_COLORS 常量
 *   - spanDurationBarColor() / traceLatencyBarColor() 辅助函数
 *   - SpanTree / TraceTreeView 返回合法 React element
 *
 * 运行: npx vitest run src/components/__tests__/ObservabilityPanel.test.jsx
 */

import { describe, it, expect } from "vitest";
import {
    SPAN_TYPE_COLORS,
    TRACE_TYPE_COLORS,
    PATH_COLORS,
    spanDurationBarColor,
    traceLatencyBarColor,
} from "../ObservabilityPanel";

// ═══════════════════════════════════════════════════════
// SPAN_TYPE_COLORS
// ═══════════════════════════════════════════════════════

describe("SPAN_TYPE_COLORS", () => {
    it("should define root, agent, and tool types", () => {
        expect(SPAN_TYPE_COLORS).toHaveProperty("root");
        expect(SPAN_TYPE_COLORS).toHaveProperty("agent");
        expect(SPAN_TYPE_COLORS).toHaveProperty("tool");
    });

    it("should use distinct colors for each span type", () => {
        const colors = Object.values(SPAN_TYPE_COLORS);
        const unique = new Set(colors);
        expect(unique.size).toBe(colors.length);
    });

    it("should use Tailwind bg-* format for all values", () => {
        Object.values(SPAN_TYPE_COLORS).forEach((c) => {
            expect(c).toMatch(/^bg-\w+-\d+$/);
        });
    });
});

// ═══════════════════════════════════════════════════════
// TRACE_TYPE_COLORS
// ═══════════════════════════════════════════════════════

describe("TRACE_TYPE_COLORS", () => {
    it("should define chat and eval types", () => {
        expect(TRACE_TYPE_COLORS).toHaveProperty("chat");
        expect(TRACE_TYPE_COLORS).toHaveProperty("eval");
    });

    it("should use distinct colors for each trace type", () => {
        const colors = Object.values(TRACE_TYPE_COLORS);
        const unique = new Set(colors);
        expect(unique.size).toBe(colors.length);
    });
});

// ═══════════════════════════════════════════════════════
// PATH_COLORS
// ═══════════════════════════════════════════════════════

describe("PATH_COLORS", () => {
    it("should have 5 colors for agent path frequency bars", () => {
        expect(PATH_COLORS).toHaveLength(5);
    });

    it("should contain only valid Tailwind bg-* classes", () => {
        PATH_COLORS.forEach((c) => {
            expect(c).toMatch(/^bg-\w+-\d+$/);
        });
    });

    it("should have all unique colors", () => {
        const unique = new Set(PATH_COLORS);
        expect(unique.size).toBe(PATH_COLORS.length);
    });
});

// ═══════════════════════════════════════════════════════
// spanDurationBarColor
// ═══════════════════════════════════════════════════════

describe("spanDurationBarColor", () => {
    it("should return green for durations ≤1000ms", () => {
        expect(spanDurationBarColor(0)).toBe("bg-green-400");
        expect(spanDurationBarColor(500)).toBe("bg-green-400");
        expect(spanDurationBarColor(1000)).toBe("bg-green-400");
    });

    it("should return amber for durations >1000ms and ≤3000ms", () => {
        expect(spanDurationBarColor(1001)).toBe("bg-amber-400");
        expect(spanDurationBarColor(2000)).toBe("bg-amber-400");
        expect(spanDurationBarColor(3000)).toBe("bg-amber-400");
    });

    it("should return red for durations >3000ms", () => {
        expect(spanDurationBarColor(3001)).toBe("bg-red-400");
        expect(spanDurationBarColor(10000)).toBe("bg-red-400");
    });

    it("should return green for null/undefined/0", () => {
        expect(spanDurationBarColor(null)).toBe("bg-green-400");
        expect(spanDurationBarColor(undefined)).toBe("bg-green-400");
        expect(spanDurationBarColor(0)).toBe("bg-green-400");
    });

    it("should return green for negative values", () => {
        expect(spanDurationBarColor(-100)).toBe("bg-green-400");
    });
});

// ═══════════════════════════════════════════════════════
// traceLatencyBarColor
// ═══════════════════════════════════════════════════════

describe("traceLatencyBarColor", () => {
    it("should return green for latencies ≤2000ms", () => {
        expect(traceLatencyBarColor(0)).toBe("bg-green-400");
        expect(traceLatencyBarColor(1000)).toBe("bg-green-400");
        expect(traceLatencyBarColor(2000)).toBe("bg-green-400");
    });

    it("should return amber for latencies >2000ms and ≤5000ms", () => {
        expect(traceLatencyBarColor(2001)).toBe("bg-amber-400");
        expect(traceLatencyBarColor(3500)).toBe("bg-amber-400");
        expect(traceLatencyBarColor(5000)).toBe("bg-amber-400");
    });

    it("should return red for latencies >5000ms", () => {
        expect(traceLatencyBarColor(5001)).toBe("bg-red-400");
        expect(traceLatencyBarColor(30000)).toBe("bg-red-400");
    });

    it("should return green for null/undefined/0", () => {
        expect(traceLatencyBarColor(null)).toBe("bg-green-400");
        expect(traceLatencyBarColor(undefined)).toBe("bg-green-400");
        expect(traceLatencyBarColor(0)).toBe("bg-green-400");
    });

    it("should return green for negative values", () => {
        expect(traceLatencyBarColor(-500)).toBe("bg-green-400");
    });
});

// ═══════════════════════════════════════════════════════
// spanDurationBarColor vs traceLatencyBarColor 边界值
// ═══════════════════════════════════════════════════════

describe("Duration vs Latency threshold differences", () => {
    it("span bar has lower thresholds (1s/3s) than trace bar (2s/5s)", () => {
        // Span: 1500ms → amber (trace would be green)
        expect(spanDurationBarColor(1500)).toBe("bg-amber-400");
        expect(traceLatencyBarColor(1500)).toBe("bg-green-400");

        // Span: 3500ms → red (trace would be amber)
        expect(spanDurationBarColor(3500)).toBe("bg-red-400");
        expect(traceLatencyBarColor(3500)).toBe("bg-amber-400");
    });
});
