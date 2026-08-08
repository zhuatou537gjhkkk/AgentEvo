/**
 * ObservabilityPanel.jsx — 前端观测面板
 *
 * Phase 6b G9: 对标 AgentArts 观测面板。
 * - Trace 列表 + 调用链树（递归 Span 渲染）
 * - Metric 指标卡片（延迟 P50/P90/P99、成功率、Token 分布）
 * - 统计概览 Tab
 */

import { useEffect, useState, useCallback } from "react";
import { useChatStore } from "../store/chatStore";

// ═══════════════════════════════════════════════════════════════
// 可测试常量 (Phase 6b G9)
// ═══════════════════════════════════════════════════════════════

/** Span 类型 → Tailwind badge 颜色 */
export const SPAN_TYPE_COLORS = {
    root: "bg-slate-500",
    agent: "bg-indigo-500",
    tool: "bg-emerald-500",
};

/** Trace 类型 → Tailwind badge 颜色 */
export const TRACE_TYPE_COLORS = {
    chat: "bg-blue-500",
    eval: "bg-purple-500",
};

/** Agent 路径频次图颜色调色板 */
export const PATH_COLORS = ["bg-indigo-500", "bg-teal-500", "bg-amber-500", "bg-rose-500", "bg-emerald-500"];

/** Span 耗时条颜色：绿<1s / 黄<3s / 红>3s */
export function spanDurationBarColor(durationMs) {
    if (!durationMs || durationMs <= 0) return "bg-green-400";
    if (durationMs > 3000) return "bg-red-400";
    if (durationMs > 1000) return "bg-amber-400";
    return "bg-green-400";
}

/** Trace 列表项延迟颜色：绿<2s / 黄<5s / 红>5s */
export function traceLatencyBarColor(latencyMs) {
    if (!latencyMs || latencyMs <= 0) return "bg-green-400";
    if (latencyMs > 5000) return "bg-red-400";
    if (latencyMs > 2000) return "bg-amber-400";
    return "bg-green-400";
}

/** 递归渲染 Span 树 */
export function SpanTree({ span, depth = 0 }) {
    const typeBadge = SPAN_TYPE_COLORS[span.type] || "bg-slate-400";
    const durationSec = span.durationMs ? (span.durationMs / 1000).toFixed(1) + "s" : "-";
    const barColor = spanDurationBarColor(span.durationMs);

    return (
        <div className="text-xs" style={{ marginLeft: depth * 20 }}>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                {/* 类型 badge */}
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${typeBadge}`}>
                    {span.type}
                </span>
                {/* 名称 */}
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-main)]">
                    {span.name}
                </span>
                {/* 耗时条 */}
                {span.durationMs > 0 && (
                    <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--panel-border)]">
                            <div
                                className={`h-full rounded-full ${barColor}`}
                                style={{ width: `${Math.min(100, (span.durationMs / 5000) * 100)}%` }}
                            />
                        </div>
                        <span className="w-10 text-right font-mono text-[var(--text-muted)]">{durationSec}</span>
                    </div>
                )}
                {/* Tool metadata */}
                {span.type === "tool" && span.metadata && (
                    <span className="truncate text-[var(--text-muted)]" title={JSON.stringify(span.metadata)}>
                        {span.metadata.input ? `in: ${String(span.metadata.input).slice(0, 40)}` : ""}
                        {span.metadata.output && ` → ${String(span.metadata.output).slice(0, 40)}`}
                    </span>
                )}
            </div>
            {/* 递归 children */}
            {span.children && span.children.map((child) => (
                <SpanTree key={child.id} span={child} depth={depth + 1} />
            ))}
        </div>
    );
}

/** 调用链树渲染 (root_span → recursive SpanTree) */
export function TraceTreeView({ rootSpan }) {
    if (!rootSpan) {
        return <p className="py-4 text-center text-xs text-[var(--text-muted)]">无 Span 数据</p>;
    }
    return (
        <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
            <SpanTree span={rootSpan} depth={0} />
        </div>
    );
}

export default function ObservabilityPanel() {
    const isOpen = useChatStore((s) => s.isObservabilityOpen);
    const toggleObservability = useChatStore((s) => s.toggleObservability);
    const traces = useChatStore((s) => s.observabilityTraces);
    const tracesLoading = useChatStore((s) => s.observabilityTracesLoading);
    const traceDetail = useChatStore((s) => s.observabilityTraceDetail);
    const metrics = useChatStore((s) => s.observabilityMetrics);
    const fetchObservabilityTraces = useChatStore((s) => s.fetchObservabilityTraces);
    const fetchObservabilityTraceDetail = useChatStore((s) => s.fetchObservabilityTraceDetail);
    const fetchObservabilityMetrics = useChatStore((s) => s.fetchObservabilityMetrics);

    const [activeTab, setActiveTab] = useState("traces"); // "traces" | "overview" | "otel-import"
    const [metricsWindow, setMetricsWindow] = useState("7d");
    const [expandedTrace, setExpandedTrace] = useState(null);

    // OTel import state
    const [otelInput, setOtelInput] = useState("");
    const [otelImportResult, setOtelImportResult] = useState(null);
    const [otelImportError, setOtelImportError] = useState(null);
    const [otelImporting, setOtelImporting] = useState(false);
    const importOtelTrace = useChatStore((s) => s.importOtelTrace);

    // OTel export state (per-trace)
    const [otelExporting, setOtelExporting] = useState(null); // traceId being exported
    const [exportResult, setExportResult] = useState(null); // { traceId, message, error }

    // 初始加载
    useEffect(() => {
        if (!isOpen) return;
        fetchObservabilityTraces(30);
        fetchObservabilityMetrics(metricsWindow);
    }, [isOpen]);

    // 切换 metrics window
    useEffect(() => {
        if (!isOpen) return;
        fetchObservabilityMetrics(metricsWindow);
    }, [metricsWindow]);

    // ESC dismiss
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e) => {
            if (e.key === "Escape") toggleObservability();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [isOpen]);

    const handleExpandTrace = useCallback(async (traceId) => {
        if (expandedTrace === traceId) {
            setExpandedTrace(null);
            return;
        }
        setExpandedTrace(traceId);
        await fetchObservabilityTraceDetail(traceId);
    }, [expandedTrace, fetchObservabilityTraceDetail]);

    const handleImportOtel = useCallback(async () => {
        if (!otelInput.trim()) {
            setOtelImportError("请粘贴 OTel Trace JSON");
            return;
        }
        setOtelImporting(true);
        setOtelImportError(null);
        setOtelImportResult(null);
        try {
            let otel;
            try {
                otel = JSON.parse(otelInput);
            } catch {
                setOtelImportError("JSON 解析失败，请检查格式");
                setOtelImporting(false);
                return;
            }
            const data = await importOtelTrace(otel);
            if (data?.ok) {
                setOtelImportResult({ type: "import", message: `导入成功！${data.spans || 0} 个 Span，trace_id: ${data.trace_id}` });
                setOtelInput("");
                // 刷新 trace 列表
                fetchObservabilityTraces(30);
            } else {
                setOtelImportError(data?.message || "导入失败");
            }
        } catch (err) {
            setOtelImportError("导入失败: " + err.message);
        } finally {
            setOtelImporting(false);
        }
    }, [otelInput, importOtelTrace, fetchObservabilityTraces]);

    if (!isOpen) return null;

    const latencyMs = metrics?.latency || {};
    const tokenDist = metrics?.tokens || {};
    const successRate = metrics?.successRate || {};
    const agentPaths = metrics?.agentPaths || {};
    const trendData = metrics?.trend || [];

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
            onClick={(e) => { if (e.target === e.currentTarget) toggleObservability(); }}
        >
            <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-2xl">
                {/* Header */}
                <div className="mb-5 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-[var(--text-main)]">🔭 观测面板</h2>
                    <button
                        type="button"
                        onClick={toggleObservability}
                        className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                    >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* ── Metric 卡片 ── */}
                {metrics && (
                    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
                            <p className="text-[10px] text-[var(--text-muted)]">P50 延迟</p>
                            <p className="mt-0.5 text-xl font-bold text-[var(--text-main)]">{latencyMs.p50 ?? "-"}<span className="text-xs font-normal text-[var(--text-muted)]">ms</span></p>
                            <p className="text-[10px] text-[var(--text-muted)]">P90: {latencyMs.p90 ?? "-"}ms · P99: {latencyMs.p99 ?? "-"}ms</p>
                        </div>
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
                            <p className="text-[10px] text-[var(--text-muted)]">成功率</p>
                            <p className="mt-0.5 text-xl font-bold text-[var(--text-main)]">{((successRate.successRate || 0) * 100).toFixed(0)}%</p>
                            <p className="text-[10px] text-[var(--text-muted)]">{successRate.succeeded ?? 0} / {successRate.total ?? 0} 请求成功</p>
                        </div>
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
                            <p className="text-[10px] text-[var(--text-muted)]">平均 Token</p>
                            <p className="mt-0.5 text-xl font-bold text-[var(--text-main)]">{tokenDist.total?.avg ?? "-"}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">Prompt {tokenDist.prompt?.avg ?? "-"} · Completion {tokenDist.completion?.avg ?? "-"}</p>
                        </div>
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
                            <p className="text-[10px] text-[var(--text-muted)]">样本数</p>
                            <p className="mt-0.5 text-xl font-bold text-[var(--text-main)]">{metricsWindow === "all" ? "全量" : metricsWindow}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">延迟 {latencyMs.sampleSize ?? 0} · Token {tokenDist.sampleSize ?? 0}</p>
                        </div>
                    </div>
                )}

                {/* ── Window 切换 + Tab ── */}
                <div className="mb-4 flex items-center gap-3">
                    {/* Metrics window */}
                    <div className="flex gap-1 rounded-lg bg-[var(--panel-soft)] p-1">
                        {["7d", "30d", "all"].map((w) => (
                            <button
                                key={w}
                                type="button"
                                onClick={() => setMetricsWindow(w)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                    metricsWindow === w
                                        ? "bg-[var(--panel-bg)] text-[var(--text-main)] shadow-sm"
                                        : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                                }`}
                            >
                                {w === "all" ? "全部" : w}
                            </button>
                        ))}
                    </div>
                    <div className="flex-1" />
                    {/* Tabs */}
                    <div className="flex gap-1 rounded-lg bg-[var(--panel-soft)] p-1">
                        {["traces", "overview", "otel-import"].map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                onClick={() => setActiveTab(tab)}
                                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                                    activeTab === tab
                                        ? "bg-[var(--panel-bg)] text-[var(--text-main)] shadow-sm"
                                        : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                                }`}
                            >
                                {tab === "traces" ? "📋 Trace 列表" : tab === "overview" ? "📊 统计概览" : "📥 OTel 导入"}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Trace 列表 Tab ── */}
                {activeTab === "traces" && (
                    <div className="space-y-2">
                        {tracesLoading && traces.length === 0 && (
                            <p className="py-8 text-center text-sm text-[var(--text-muted)]">加载中...</p>
                        )}
                        {!tracesLoading && traces.length === 0 && (
                            <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-8 text-center">
                                <p className="text-sm text-[var(--text-muted)]">暂无 Trace 数据</p>
                                <p className="mt-1 text-xs text-[var(--text-muted)]">发送消息后会自动采集 Trace</p>
                            </div>
                        )}
                        {traces.map((t) => {
                            const latencySec = t.total_latency_ms ? (t.total_latency_ms / 1000).toFixed(1) + "s" : "-";
                            const latencyColor = traceLatencyBarColor(t.total_latency_ms);

                            const isExpanded = expandedTrace === t.trace_id;

                            return (
                                <div
                                    key={t.trace_id}
                                    className={`rounded-xl border transition ${
                                        isExpanded
                                            ? "border-[var(--brand)] bg-[var(--panel-soft)]"
                                            : "border-[var(--panel-border)] bg-[var(--panel-soft)] hover:bg-[var(--panel-bg)]"
                                    }`}
                                >
                                    {/* Trace 列表项 */}
                                    <button
                                        type="button"
                                        onClick={() => handleExpandTrace(t.trace_id)}
                                        className="w-full px-3 py-2.5 text-left"
                                    >
                                        <div className="flex items-center gap-2">
                                            {/* type badge */}
                                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${
                                                TRACE_TYPE_COLORS[t.trace_type] || "bg-slate-500"
                                            }`}>
                                                {t.trace_type}
                                            </span>
                                            {/* agent path */}
                                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                                {(t.agent_traversal_path || []).map((agent, i) => (
                                                    <span key={i} className="flex items-center gap-1">
                                                        {i > 0 && <span className="text-[var(--text-muted)]">→</span>}
                                                        <span className="truncate rounded bg-[var(--panel-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-main)]">{agent}</span>
                                                    </span>
                                                ))}
                                                {(t.agent_traversal_path || []).length === 0 && (
                                                    <span className="text-[var(--text-muted)]">(empty)</span>
                                                )}
                                            </div>
                                            {/* tool count + error */}
                                            <span className="text-[10px] text-[var(--text-muted)]">
                                                🔧{t.tool_call_count}
                                            </span>
                                            {t.error_count > 0 && (
                                                <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-900/30 dark:text-red-400">
                                                    ⚠{t.error_count}
                                                </span>
                                            )}
                                            {/* latency bar */}
                                            <div className="flex items-center gap-1.5">
                                                <div className="h-1.5 w-10 overflow-hidden rounded-full bg-[var(--panel-border)]">
                                                    <div
                                                        className={`h-full rounded-full ${latencyColor}`}
                                                        style={{ width: `${Math.min(100, (t.total_latency_ms / 10000) * 100)}%` }}
                                                    />
                                                </div>
                                                <span className="w-12 text-right font-mono text-[10px] text-[var(--text-muted)]">{latencySec}</span>
                                            </div>
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                                            <span className="font-mono">{t.trace_id.slice(0, 16)}...</span>
                                            <span>|</span>
                                            <span>{t.model || "unknown"}</span>
                                            <span>|</span>
                                            <span>{t.created_at ? new Date(t.created_at).toLocaleString("zh-CN") : "-"}</span>
                                        </div>
                                    </button>
                                    {/* 展开：Span 树 */}
                                    {isExpanded && (
                                        <div className="border-t border-[var(--panel-border)] px-3 py-2">
                                            {traceDetail && traceDetail.trace_id === t.trace_id ? (
                                                <>
                                                    <TraceTreeView rootSpan={traceDetail.root_span} />
                                                    {/* OTel 导出按钮 */}
                                                    <div className="mt-2 flex justify-end">
                                                        <button
                                                            type="button"
                                                            disabled={otelExporting === t.trace_id}
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                setOtelExporting(t.trace_id);
                                                                setExportResult(null);
                                                                try {
                                                                    const { exportTraceAsOtel } = await import("../api/chat.js");
                                                                    const data = await exportTraceAsOtel(t.trace_id);
                                                                    if (data?.ok && data?.otel) {
                                                                        const json = JSON.stringify(data.otel, null, 2);
                                                                        await navigator.clipboard.writeText(json);
                                                                        setExportResult({ traceId: t.trace_id, message: `已复制 ${data.otel.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length || 0} 个 Span 到剪贴板` });
                                                                    } else {
                                                                        setExportResult({ traceId: t.trace_id, error: data?.message || "未知错误" });
                                                                    }
                                                                } catch (err) {
                                                                    setExportResult({ traceId: t.trace_id, error: err.message });
                                                                } finally {
                                                                    setOtelExporting(null);
                                                                }
                                                            }}
                                                            className="rounded-lg px-2.5 py-1 text-[10px] font-medium text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand)]/10 transition disabled:opacity-50"
                                                        >
                                                            {otelExporting === t.trace_id ? "导出中..." : "📤 OTel 导出"}
                                                        </button>
                                                    </div>
                                                    {/* 导出结果提示（仅当前 trace） */}
                                                    {exportResult && exportResult.traceId === t.trace_id && (
                                                        <div className={`mt-1 rounded-lg px-2.5 py-1.5 text-[10px] ${
                                                            exportResult.error
                                                                ? "border border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
                                                                : "border border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400"
                                                        }`}>
                                                            {exportResult.error || exportResult.message}
                                                        </div>
                                                    )}
                                                </>
                                            ) : (
                                                <p className="py-2 text-center text-xs text-[var(--text-muted)]">加载中...</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* ── 统计概览 Tab ── */}
                {activeTab === "overview" && (
                    <div className="space-y-4">
                        {/* Agent 路径 Top 10 */}
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">Agent 路径 Top 10</h3>
                            {(agentPaths.topPaths || []).length === 0 ? (
                                <p className="py-2 text-center text-xs text-[var(--text-muted)]">暂无数据</p>
                            ) : (
                                <div className="space-y-2">
                                    {(agentPaths.topPaths || []).map((p, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <span className="w-5 text-right text-[10px] font-bold text-[var(--text-muted)]">#{i + 1}</span>
                                            <span className="min-w-0 flex-1 truncate rounded bg-[var(--panel-bg)] px-2 py-0.5 text-[11px] font-mono text-[var(--text-main)]">{p.path}</span>
                                            <span className="text-[10px] text-[var(--text-muted)]">{p.count}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Token 分布 */}
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">Token 分布</h3>
                            <div className="grid grid-cols-3 gap-3">
                                <div className="rounded-lg bg-[var(--panel-bg)] p-3 text-center">
                                    <p className="text-[10px] text-[var(--text-muted)]">Total P50</p>
                                    <p className="text-lg font-bold text-[var(--text-main)]">{tokenDist.total?.p50 ?? "-"}</p>
                                </div>
                                <div className="rounded-lg bg-[var(--panel-bg)] p-3 text-center">
                                    <p className="text-[10px] text-[var(--text-muted)]">Total P90</p>
                                    <p className="text-lg font-bold text-[var(--text-main)]">{tokenDist.total?.p90 ?? "-"}</p>
                                </div>
                                <div className="rounded-lg bg-[var(--panel-bg)] p-3 text-center">
                                    <p className="text-[10px] text-[var(--text-muted)]">Total P99</p>
                                    <p className="text-lg font-bold text-[var(--text-main)]">{tokenDist.total?.p99 ?? "-"}</p>
                                </div>
                            </div>
                            {/* 模型分布 */}
                            {(tokenDist.modelDistribution || []).length > 0 && (
                                <div className="mt-3">
                                    <p className="mb-2 text-[10px] text-[var(--text-muted)]">模型使用分布</p>
                                    <div className="flex flex-wrap gap-2">
                                        {(tokenDist.modelDistribution || []).map((m, i) => (
                                            <span key={i} className="rounded bg-[var(--panel-bg)] px-2 py-0.5 text-[11px] text-[var(--text-main)]">
                                                {m.model} <span className="text-[var(--text-muted)]">({m.count})</span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Agent 频次 */}
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">Agent 调用频次</h3>
                            {(agentPaths.topAgents || []).length === 0 ? (
                                <p className="py-2 text-center text-xs text-[var(--text-muted)]">暂无数据</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {(agentPaths.topAgents || []).map((a, i) => {
                                        const maxCount = agentPaths.topAgents[0]?.count || 1;
                                        const pct = Math.round((a.count / maxCount) * 100);
                                        return (
                                            <div key={i} className="flex items-center gap-2">
                                                <span className="w-24 truncate text-[11px] text-[var(--text-main)]">{a.agent}</span>
                                                <div className="h-4 flex-1 rounded-sm bg-[var(--panel-bg)]">
                                                    <div
                                                        className={`h-full rounded-sm ${PATH_COLORS[i % PATH_COLORS.length]} transition-all`}
                                                        style={{ width: `${pct}%` }}
                                                    />
                                                </div>
                                                <span className="w-8 text-right text-[10px] text-[var(--text-muted)]">{a.count}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ── OTel 导入 Tab ── */}
                {activeTab === "otel-import" && (
                    <div className="space-y-4">
                        {/* 导入区域 */}
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">📥 导入外部 OpenTelemetry Trace</h3>
                            <p className="mb-3 text-xs text-[var(--text-muted)]">
                                粘贴标准 OTLP/JSON 格式的 Trace 数据。支持 LangChain、AutoGen、CrewAI 等框架按 OTel 规范导出的 Trace。
                            </p>
                            <textarea
                                value={otelInput}
                                onChange={(e) => { setOtelInput(e.target.value); setOtelImportError(null); setOtelImportResult(null); }}
                                placeholder={`{\n  "resourceSpans": [{\n    "resource": { "attributes": [...] },\n    "scopeSpans": [{\n      "scope": { "name": "..." },\n      "spans": [...]\n    }]\n  }]\n}`}
                                rows={8}
                                className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-xs font-mono text-[var(--text-main)] placeholder:text-[var(--text-muted)] resize-y"
                            />
                            <div className="mt-3 flex items-center gap-3">
                                <button
                                    type="button"
                                    disabled={otelImporting || !otelInput.trim()}
                                    onClick={handleImportOtel}
                                    className="rounded-lg bg-[var(--brand)] px-4 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 transition"
                                >
                                    {otelImporting ? "导入中..." : "导入 Trace"}
                                </button>
                                {otelInput.trim() && (
                                    <button
                                        type="button"
                                        onClick={() => { setOtelInput(""); setOtelImportError(null); setOtelImportResult(null); }}
                                        className="rounded-lg px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                                    >
                                        清空
                                    </button>
                                )}
                            </div>
                            {/* 结果/错误提示 */}
                            {otelImportError && (
                                <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
                                    {otelImportError}
                                </div>
                            )}
                            {otelImportResult && (
                                <div className="mt-3 rounded-lg border border-[var(--brand)]/30 bg-[var(--brand)]/5 px-3 py-2 text-xs text-[var(--text-main)]">
                                    {otelImportResult.message}
                                </div>
                            )}
                        </div>

                        {/* 说明卡片 */}
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            <h3 className="mb-2 text-sm font-semibold text-[var(--text-main)]">格式说明</h3>
                            <div className="space-y-2 text-xs text-[var(--text-muted)]">
                                <p>• 支持的格式：<code className="rounded bg-[var(--panel-bg)] px-1 py-0.5 text-[11px]">OTLP/JSON</code>（OpenTelemetry Protocol JSON）</p>
                                <p>• Span 会按 <code className="rounded bg-[var(--panel-bg)] px-1 py-0.5 text-[11px]">parentSpanId</code> 重建调用链树</p>
                                <p>• <code className="rounded bg-[var(--panel-bg)] px-1 py-0.5 text-[11px]">attributes</code> 中的 <code className="rounded bg-[var(--panel-bg)] px-1 py-0.5 text-[11px]">gen_ai.*</code> 属性会自动提取为元数据</p>
                                <p>• 导入后在「📋 Trace 列表」Tab 中查看，标记为 <span className="rounded bg-purple-500/20 px-1 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">import</span> 类型</p>
                                <p>• 每条 Trace 可点击 <span className="rounded bg-[var(--brand)]/20 px-1 py-0.5 text-[10px] font-medium text-[var(--brand)]">📤 OTel 导出</span> 按钮反向导出</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
