import { useEffect, useState } from "react";
import {
    fetchRagEvalReport,
    fetchRagTelemetry,
    isRagDisabledError,
    normalizeRagEvalReport,
    normalizeRagTelemetry,
    PROFILE_ORDER,
} from "../api/rag.js";

function formatNumber(value, digits = 0) {
    return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
}

function formatPercent(value) {
    return value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
}

function gateText(status) {
    if (status === "pass") return "通过";
    if (status === "fail") return "未通过";
    if (status === "insufficient_sample") return "样本不足";
    if (status === "insufficient_data") return "数据不足";
    return "未评估";
}

export function buildRagPanelModel({ telemetry, report }) {
    const summary = telemetry?.summary || {};
    return {
        cards: [
            { key: "total", label: "查询总数", value: formatNumber(summary.total) },
            { key: "hitRate", label: "命中率", value: formatPercent(summary.hitRate) },
            { key: "noMatch", label: "No-match", value: formatNumber(summary.noMatch) },
            { key: "error", label: "错误", value: formatNumber(summary.error) },
            { key: "latency", label: "平均 / 近期 P95", value: `${formatNumber(summary.avgLatencyMs)} / ${formatNumber(telemetry?.recentP95LatencyMs)} ms` },
            { key: "fallback", label: "Fallback", value: formatNumber(summary.fallbackCount) },
        ],
        reportStatus: report?.available ? gateText(report.gateStatus) : "暂无 K9 报告",
    };
}

function MetricCard({ label, value }) {
    return (
        <div className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2.5">
            <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
            <p className="mt-1 text-lg font-semibold text-[var(--text-main)]">{value}</p>
        </div>
    );
}

function ProfileTable({ report }) {
    if (!report?.available || Object.keys(report.profiles || {}).length === 0) {
        return <div className="rounded-xl border border-dashed border-[var(--panel-border)] px-4 py-5 text-xs text-[var(--text-muted)]">暂无 K9 profile 报告。运行离线评测生成 `backend/tmp/rag-eval-report.json`，面板会自动绑定当前登录用户。</div>;
    }
    const value = (number, digits = 3) => number == null ? "—" : Number(number).toFixed(digits);
    return (
        <div className="overflow-x-auto rounded-xl border border-[var(--panel-border)]">
            <table className="min-w-[760px] w-full text-xs">
                <thead>
                    <tr className="border-b border-[var(--panel-border)] bg-[var(--panel-soft)] text-left text-[var(--text-muted)]">
                        <th className="px-3 py-2">Profile</th><th className="px-3 py-2">样本</th><th className="px-3 py-2">Recall</th><th className="px-3 py-2">MRR</th><th className="px-3 py-2">nDCG</th><th className="px-3 py-2">引用页</th><th className="px-3 py-2">Faithfulness</th><th className="px-3 py-2">p50/p95</th>
                    </tr>
                </thead>
                <tbody>
                    {PROFILE_ORDER.map((name) => {
                        const profile = report.profiles[name];
                        if (!profile) return null;
                        return (
                            <tr key={name} className="border-b border-[var(--panel-border)] last:border-0 text-[var(--text-main)]">
                                <td className="px-3 py-2 font-medium">{name}</td>
                                <td className="px-3 py-2">{profile.sampleCount}</td>
                                <td className="px-3 py-2">{value(profile.recallAtK)}</td>
                                <td className="px-3 py-2">{value(profile.mrr)}</td>
                                <td className="px-3 py-2">{value(profile.ndcgAtK)}</td>
                                <td className="px-3 py-2">{value(profile.citationPageAccuracy)}</td>
                                <td className="px-3 py-2">{value(profile.faithfulness)}</td>
                                <td className="px-3 py-2">{value(profile.p50LatencyMs, 0)} / {value(profile.p95LatencyMs, 0)} ms</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default function RagEvaluationPanel({ visible = true }) {
    const [loading, setLoading] = useState(false);
    const [telemetry, setTelemetry] = useState(null);
    const [report, setReport] = useState(null);
    const [error, setError] = useState("");
    const [disabled, setDisabled] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        if (!visible) return undefined;
        const controller = new AbortController();
        setLoading(true);
        setError("");
        setDisabled(false);
        (async () => {
            try {
                const telemetryPayload = await fetchRagTelemetry({ signal: controller.signal });
                if (!controller.signal.aborted) setTelemetry(normalizeRagTelemetry(telemetryPayload));
            } catch (requestError) {
                if (controller.signal.aborted) return;
                if (isRagDisabledError(requestError)) setDisabled(true);
                else setError("知识库 RAG 观测暂时不可用，请稍后重试。");
                setLoading(false);
                return;
            }
            try {
                const reportPayload = await fetchRagEvalReport({ signal: controller.signal });
                if (!controller.signal.aborted) setReport(normalizeRagEvalReport(reportPayload));
            } catch (requestError) {
                if (!controller.signal.aborted && !isRagDisabledError(requestError)) setReport(normalizeRagEvalReport({ ragEval: { available: false, reason: "RAG_EVAL_REPORT_UNAVAILABLE" } }));
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [visible, refreshKey]);

    if (!visible) return null;
    const model = buildRagPanelModel({ telemetry, report });
    return (
        <section className="mb-6" aria-label="知识库 RAG 评测与观测">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-[var(--text-main)]">📚 知识库 RAG</h3>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">命中、降级、rewrite/rerank 与 K9 profile 质量对比</p>
                </div>
                <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading} className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs text-[var(--text-main)] disabled:opacity-50">{loading ? "加载中…" : "刷新"}</button>
            </div>
            {loading && !telemetry && <div className="surface-subtle rounded-xl px-4 py-6 text-center text-xs text-[var(--text-muted)]">加载 RAG 观测中…</div>}
            {disabled && <div className="rounded-xl border border-dashed border-[var(--panel-border)] px-4 py-5 text-xs text-[var(--text-muted)]">知识库 RAG 当前未开启，观测接口按 feature flag 返回 disabled。</div>}
            {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">{error}<button type="button" onClick={() => setRefreshKey((value) => value + 1)} className="ml-2 underline">重试</button></div>}
            {telemetry && !disabled && !error && (
                <>
                    <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{model.cards.map((card) => <MetricCard key={card.key} {...card} />)}</div>
                    <div className="mb-3 grid gap-3 md:grid-cols-2">
                        <div className="surface-subtle rounded-xl p-3 text-xs text-[var(--text-main)]">
                            <p className="mb-2 font-semibold">检索与模型调用</p>
                            <div className="grid grid-cols-2 gap-2 text-[var(--text-muted)]"><span>lexical 累计 {telemetry.recentSourceCounts.lexical}</span><span>vector 累计 {telemetry.recentSourceCounts.vector}</span><span>fusion 累计 {telemetry.recentSourceCounts.fusion}</span><span>embedding 调用 {telemetry.summary.embeddingCalls}</span><span>LLM 调用 {telemetry.summary.llmCalls}</span><span>压缩率 {telemetry.summary.avgCompressionRatio == null ? "—" : formatPercent(telemetry.summary.avgCompressionRatio)}</span></div>
                        </div>
                        <div className="surface-subtle rounded-xl p-3 text-xs text-[var(--text-main)]"><p className="mb-2 font-semibold">增强链路</p><div className="grid grid-cols-2 gap-2 text-[var(--text-muted)]"><span>rewrite 生效 {telemetry.summary.rewriteApplied}</span><span>rerank 生效 {telemetry.summary.rerankApplied}</span><span>rerank fallback {telemetry.summary.rerankFallback}</span><span>报告门禁 {model.reportStatus}</span></div></div>
                    </div>
                    <div className="mb-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-semibold text-[var(--text-main)]">K9 Profile 对比</h4>{report?.datasetVersion && <span className="text-[10px] text-[var(--text-muted)]">{report.datasetVersion} · {report.modelAlias || "deterministic"}</span>}</div><ProfileTable report={report} /></div>
                    {telemetry.recent.length > 0 && <div><h4 className="mb-2 text-xs font-semibold text-[var(--text-main)]">最近查询（默认隐藏 query 内容）</h4><div className="overflow-x-auto rounded-xl border border-[var(--panel-border)]"><table className="w-full text-xs"><thead><tr className="border-b border-[var(--panel-border)] bg-[var(--panel-soft)] text-left text-[var(--text-muted)]"><th className="px-3 py-2">状态</th><th className="px-3 py-2">来源</th><th className="px-3 py-2">命中数</th><th className="px-3 py-2">延迟</th><th className="px-3 py-2">时间</th></tr></thead><tbody>{telemetry.recent.slice(0, 8).map((row, index) => <tr key={row.id ?? `${row.createdAt || "row"}-${index}`} className="border-b border-[var(--panel-border)] last:border-0 text-[var(--text-main)]"><td className="px-3 py-2">{row.status}</td><td className="px-3 py-2">{row.source}</td><td className="px-3 py-2">{row.items}</td><td className="px-3 py-2">{row.latencyMs} ms</td><td className="px-3 py-2 text-[var(--text-muted)]">{row.createdAt || "—"}</td></tr>)}</tbody></table></div></div>}
                </>
            )}
        </section>
    );
}
