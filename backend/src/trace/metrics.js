/**
 * MetricsAggregator — P50/P90/P99 指标聚合器
 *
 * Phase 6b G6：对标 AgentArts 观测面板，从 message_metrics + eval_traces
 * 两表聚合延迟、Token、成功率、Agent 路径等统计指标。
 *
 * 用法：
 *   const agg = new MetricsAggregator();
 *   const report = agg.getFullReport("7d");
 *   // → { latency: { p50, p90, p99, avg, min, max },
 *   //      tokens: { avg, p50, p90, p99 },
 *   //      successRate: 0.95,
 *   //      agentPaths: [...],
 *   //      trend: [{ day, count, avgLatency, avgTokens }, ...],
 *   //      window: "7d", totalRequests: 42 }
 */

import {
    getMetricsLatencies,
    getMetricsTokens,
    getMetricsTraces,
    getMetricsDailyBuckets,
} from "../db/index.js";

/**
 * 计算百分位（线性插值）
 * @param {number[]} sorted — 已排序数组
 * @param {number} p — 百分位 0-100
 * @returns {number}
 */
function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 计算平均数 */
function avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** window 字符串 → 截止时间 ISO 字符串 */
function cutoffFor(window) {
    const now = Date.now();
    switch (window) {
        case "7d":  return new Date(now - 7 * 86400000).toISOString();
        case "30d": return new Date(now - 30 * 86400000).toISOString();
        case "all": return new Date(0).toISOString(); // epoch
        default:    return new Date(now - 7 * 86400000).toISOString();
    }
}

class MetricsAggregator {
    /**
     * 延迟统计：P50 / P90 / P99 / avg / min / max
     */
    getLatencyStats(userId, window = "7d") {
        const cutoff = cutoffFor(window);
        const rows = getMetricsLatencies(userId, cutoff);
        const values = rows.map(r => r.latency_ms).filter(v => v != null).sort((a, b) => a - b);

        return {
            p50: Math.round(percentile(values, 50)),
            p90: Math.round(percentile(values, 90)),
            p99: Math.round(percentile(values, 99)),
            avg: Math.round(avg(values)),
            min: values.length > 0 ? values[0] : 0,
            max: values.length > 0 ? values[values.length - 1] : 0,
            sampleSize: values.length,
        };
    }

    /**
     * Token 分布：avg / P50 / P90 / P99（total_tokens）
     */
    getTokenDistribution(userId, window = "7d") {
        const cutoff = cutoffFor(window);
        const rows = getMetricsTokens(userId, cutoff);

        const totalTokens = rows.map(r => r.total_tokens).filter(v => v != null).sort((a, b) => a - b);
        const promptTokens = rows.map(r => r.prompt_tokens).filter(v => v != null);
        const completionTokens = rows.map(r => r.completion_tokens).filter(v => v != null);

        // 模型分布
        const modelMap = {};
        for (const r of rows) {
            const m = r.model || "unknown";
            modelMap[m] = (modelMap[m] || 0) + 1;
        }

        return {
            total: {
                avg: Math.round(avg(totalTokens)),
                p50: Math.round(percentile(totalTokens, 50)),
                p90: Math.round(percentile(totalTokens, 90)),
                p99: Math.round(percentile(totalTokens, 99)),
            },
            prompt: {
                avg: Math.round(avg(promptTokens)),
            },
            completion: {
                avg: Math.round(avg(completionTokens)),
            },
            modelDistribution: Object.entries(modelMap)
                .map(([model, count]) => ({ model, count }))
                .sort((a, b) => b.count - a.count),
            sampleSize: rows.length,
        };
    }

    /**
     * 成功率：error_count === 0 的 trace 占比
     */
    getSuccessRate(userId, window = "7d") {
        const cutoff = cutoffFor(window);
        const rows = getMetricsTraces(userId, cutoff);

        if (rows.length === 0) return { successRate: 0, total: 0, succeeded: 0, failed: 0 };

        const succeeded = rows.filter(r => (r.error_count || 0) === 0).length;
        const failed = rows.length - succeeded;

        return {
            successRate: rows.length > 0 ? Math.round((succeeded / rows.length) * 10000) / 10000 : 0,
            total: rows.length,
            succeeded,
            failed,
        };
    }

    /**
     * Agent 路径频次统计
     */
    getAgentPathFrequency(userId, window = "7d") {
        const cutoff = cutoffFor(window);
        const rows = getMetricsTraces(userId, cutoff);

        const pathCount = {};
        const agentCount = {};
        for (const r of rows) {
            let paths = [];
            try {
                paths = JSON.parse(r.agent_traversal_path || "[]");
            } catch { /* ignore */ }

            const key = paths.join(" → ") || "(empty)";
            pathCount[key] = (pathCount[key] || 0) + 1;

            for (const agent of paths) {
                agentCount[agent] = (agentCount[agent] || 0) + 1;
            }
        }

        return {
            topPaths: Object.entries(pathCount)
                .map(([path, count]) => ({ path, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
            topAgents: Object.entries(agentCount)
                .map(([agent, count]) => ({ agent, count }))
                .sort((a, b) => b.count - a.count),
            totalTraces: rows.length,
        };
    }

    /**
     * 每日趋势（供 G9 图表消费）
     */
    getTrend(userId, window = "7d") {
        const cutoff = cutoffFor(window);
        const rows = getMetricsDailyBuckets(userId, cutoff);

        // 补充空白天数（窗口期内 0 请求的天）
        if (window !== "all") {
            const days = window === "7d" ? 7 : 30;
            const filled = [];
            const seen = new Set(rows.map(r => r.day));
            const now = new Date();
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const key = d.toISOString().slice(0, 10);
                const existing = rows.find(r => r.day === key);
                filled.push({
                    day: key,
                    count: existing ? existing.count : 0,
                    avgLatency: existing ? Math.round(existing.avg_latency || 0) : 0,
                    avgTokens: existing ? Math.round(existing.avg_tokens || 0) : 0,
                });
            }
            return filled;
        }

        return rows.map(r => ({
            day: r.day,
            count: r.count,
            avgLatency: Math.round(r.avg_latency || 0),
            avgTokens: Math.round(r.avg_tokens || 0),
        }));
    }

    /**
     * 全量报告（一次返回所有指标）
     */
    getFullReport(userId, window = "7d") {
        return {
            window,
            latency: this.getLatencyStats(userId, window),
            tokens: this.getTokenDistribution(userId, window),
            successRate: this.getSuccessRate(userId, window),
            agentPaths: this.getAgentPathFrequency(userId, window),
            trend: this.getTrend(userId, window),
        };
    }
}

/** 单例 */
const metricsAggregator = new MetricsAggregator();

export { MetricsAggregator, metricsAggregator, percentile, avg };
