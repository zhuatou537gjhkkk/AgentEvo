/**
 * EvalDashboard.jsx — 评估仪表盘
 *
 * Phase 5: 对齐 AgentArts 观测评估面板。
 * 显示趋势图、统计卡片、最近分数、反馈汇总。
 */

import { useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";
import EvalRunner from "./EvalRunner.jsx";

export default function EvalDashboard() {
    const isOpen = useChatStore((s) => s.isEvalDashboardOpen);
    const toggleEvalDashboard = useChatStore((s) => s.toggleEvalDashboard);
    const evalReportData = useChatStore((s) => s.evalReportData);
    const fetchEvalReport = useChatStore((s) => s.fetchEvalReport);

    const [showRunner, setShowRunner] = useState(false);
    const [loading, setLoading] = useState(false);
    const [runs, setRuns] = useState([]);
    const [selectedRunId, setSelectedRunId] = useState(""); // "" = 全部

    // 加载 run 列表 + 报告
    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        (async () => {
            try {
                const { fetchEvalRuns } = await import("../api/eval.js");
                const data = await fetchEvalRuns();
                if (data?.ok) setRuns(data.runs || []);
            } catch { /* 静默 */ }
            await fetchEvalReport(selectedRunId || null);
            setLoading(false);
        })();
    }, [isOpen]);

    // 切换 runId 时重新加载报告
    const handleRunChange = async (runId) => {
        setSelectedRunId(runId);
        setLoading(true);
        await fetchEvalReport(runId || null);
        setLoading(false);
    };

    // ESC dismiss
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e) => {
            if (e.key === "Escape") toggleEvalDashboard();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [isOpen]);

    if (!isOpen) return null;

    const trendData = evalReportData?.trendData || [];
    const feedbackStats = evalReportData?.feedbackStats || { thumbs_up: 0, thumbs_down: 0, total: 0 };
    const categories = evalReportData?.categories || [];

    // Compute max score for bar scaling
    const maxScore = 5;

    const renderTrendBars = () => {
        if (trendData.length === 0) {
            return <p className="py-8 text-center text-sm text-[var(--text-muted)]">暂无评估数据，运行一次评估以查看趋势</p>;
        }

        return (
            <div className="space-y-2">
                {trendData.slice(0, 10).reverse().map((d) => (
                    <div key={d.date} className="flex items-center gap-3">
                        <span className="w-20 shrink-0 text-xs text-[var(--text-muted)]">{d.date}</span>
                        <div className="flex flex-1 items-center gap-2">
                            {["correctness", "tool_usage", "conciseness", "safety"].map((dim, i) => {
                                const colors = ["bg-blue-500", "bg-green-500", "bg-amber-500", "bg-purple-500"];
                                const labels = ["正确性", "工具", "简洁", "安全"];
                                const val = d[dim] || 0;
                                return (
                                    <div key={dim} className="flex flex-1 items-center gap-1" title={`${labels[i]}: ${val}`}>
                                        <div className="h-5 flex-1 rounded-sm bg-[var(--panel-soft)]">
                                            <div
                                                className={`h-full rounded-sm ${colors[i]} transition-all`}
                                                style={{ width: `${Math.min(100, (val / maxScore) * 100)}%` }}
                                            />
                                        </div>
                                        <span className="w-6 text-right text-xs text-[var(--text-muted)]">{val}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
            onClick={(e) => { if (e.target === e.currentTarget) toggleEvalDashboard(); }}
        >
            <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-2xl">
                {/* Header */}
                <div className="mb-6">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-bold text-[var(--text-main)]">评估仪表盘</h2>
                        <div className="flex items-center gap-3">
                            {/* Run selector */}
                            {runs.length > 0 && (
                                <select
                                    value={selectedRunId}
                                    onChange={(e) => handleRunChange(e.target.value)}
                                    className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs text-[var(--text-main)] outline-none focus:border-[var(--brand)]"
                                >
                                    <option value="">全部运行</option>
                                    {runs.map((r) => (
                                        <option key={r.run_id} value={r.run_id}>
                                            {r.run_id} ({new Date(r.created_at).toLocaleDateString("zh-CN")})
                                        </option>
                                    ))}
                                </select>
                            )}
                            {selectedRunId && (
                                <button
                                    type="button"
                                    onClick={() => handleRunChange("")}
                                    className="text-xs text-[var(--brand)] hover:underline"
                                >
                                    清除筛选
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={async () => {
                                    // 同时刷新 run 列表和报告
                                    try {
                                        const { fetchEvalRuns } = await import("../api/eval.js");
                                        const data = await fetchEvalRuns();
                                        if (data?.ok) setRuns(data.runs || []);
                                    } catch { /* 静默 */ }
                                    fetchEvalReport(selectedRunId || null);
                                    setShowRunner(false);
                                }}
                                className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--text-main)] hover:opacity-80 transition"
                            >
                                刷新
                            </button>
                        <button
                            type="button"
                            onClick={() => setShowRunner(!showRunner)}
                            className="rounded-xl bg-[#111827] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b1220] transition"
                        >
                            {showRunner ? "隐藏运行器" : "运行评估"}
                        </button>
                        <button
                            type="button"
                            onClick={toggleEvalDashboard}
                            className="rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                        >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>
                </div>

                {loading && (
                    <p className="py-8 text-center text-sm text-[var(--text-muted)]">加载中...</p>
                )}

                {/* Eval Runner */}
                {showRunner && (
                    <div className="mb-6">
                        <EvalRunner />
                    </div>
                )}

                {/* Stat cards */}
                <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                        <p className="text-xs text-[var(--text-muted)]">总测试用例</p>
                        <p className="mt-1 text-2xl font-bold text-[var(--text-main)]">{evalReportData?.totalTestCases || 0}</p>
                    </div>
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                        <p className="text-xs text-[var(--text-muted)]">用户反馈总数</p>
                        <p className="mt-1 text-2xl font-bold text-[var(--text-main)]">{feedbackStats.total}</p>
                    </div>
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-green-50 p-4 dark:bg-green-900/20">
                        <p className="text-xs text-[var(--text-muted)]">👍 有帮助</p>
                        <p className="mt-1 text-2xl font-bold text-green-700 dark:text-green-400">{feedbackStats.thumbs_up}</p>
                    </div>
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-red-50 p-4 dark:bg-red-900/20">
                        <p className="text-xs text-[var(--text-muted)]">👎 需改进</p>
                        <p className="mt-1 text-2xl font-bold text-red-700 dark:text-red-400">{feedbackStats.thumbs_down}</p>
                    </div>
                </div>

                {/* Trend chart */}
                <div className="mb-6">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">评分趋势</h3>
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                        {/* Legend */}
                        <div className="mb-3 flex gap-4 text-xs text-[var(--text-muted)]">
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500" />正确性</span>
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500" />工具使用</span>
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" />简洁度</span>
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-purple-500" />安全性</span>
                        </div>
                        {renderTrendBars()}
                    </div>
                </div>

                {/* Categories */}
                {categories.length > 0 && (
                    <div>
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">测试分类</h3>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {categories.map((cat) => (
                                <div key={cat.category} className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2 text-xs text-[var(--text-main)]">
                                    <span className="font-medium">{cat.category}</span>
                                    <span className="ml-1 text-[var(--text-muted)]">({cat.count})</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
