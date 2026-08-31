/**
 * EvalRunner.jsx — 评估运行器
 *
 * Phase 5: 在 EvalDashboard 中运行评估测试套件。
 * 支持分类筛选、进度跟踪、实时结果展示。
 */

import { useState, useEffect } from "react";
import { useChatStore } from "../store/chatStore";

export default function EvalRunner() {
    const runEvalSuite = useChatStore((s) => s.runEvalSuite);
    const evalRunState = useChatStore((s) => s.evalRunState);
    const fetchEvalReport = useChatStore((s) => s.fetchEvalReport);

    const [selectedCategories, setSelectedCategories] = useState([]);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState(null);

    const categories = [
        { key: "knowledge_qa", label: "知识问答" },
        { key: "web_search", label: "联网搜索" },
        { key: "multi_step", label: "多步推理" },
        { key: "memory_recall", label: "记忆召回" },
        { key: "code_generation", label: "代码生成" },
        { key: "creative", label: "创意任务" },
        { key: "tool_selection", label: "工具选择" },
        { key: "code_rules", label: "代码判定" },
        { key: "edge_case", label: "边界场景" },
    ];

    const toggleCategory = (cat) => {
        setSelectedCategories((prev) =>
            prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
        );
    };

    const selectAll = () => {
        if (selectedCategories.length === categories.length) {
            setSelectedCategories([]);
        } else {
            setSelectedCategories(categories.map((c) => c.key));
        }
    };

    const handleRun = async () => {
        setRunning(true);
        setResult(null);
        try {
            const report = await runEvalSuite(selectedCategories);
            setResult(report);
            // 刷新 dashboard 数据
            fetchEvalReport();
        } catch (err) {
            setResult({ error: err.message });
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="surface-subtle rounded-2xl p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">运行评估</h3>

            {/* Category picker */}
            <div className="mb-3">
                <button
                    type="button"
                    onClick={selectAll}
                    className="mb-2 text-xs text-[var(--brand)] hover:underline"
                >
                    {selectedCategories.length === categories.length ? "取消全选" : "全选"}
                </button>
                <div className="flex flex-wrap gap-1.5">
                    {categories.map((cat) => (
                        <button
                            key={cat.key}
                            type="button"
                            onClick={() => toggleCategory(cat.key)}
                            className={`rounded-lg px-2 py-1 text-xs transition ${
                                selectedCategories.includes(cat.key)
                                    ? "bg-[var(--brand-start)] text-white"
                                    : "border border-[var(--panel-border)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                            }`}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Run button */}
            <button
                type="button"
                onClick={handleRun}
                disabled={running || selectedCategories.length === 0}
                className="ui-button-primary rounded-xl px-4 py-2 text-sm transition disabled:opacity-50"
            >
                {running ? "运行中..." : `运行评估 (${selectedCategories.length > 0 ? selectedCategories.length + " 类" : "请选择分类"})`}
            </button>

            {/* Progress / Results */}
            {running && (
                <p className="mt-3 text-sm text-[var(--text-muted)]">评估运行中，请等待...</p>
            )}

            {result && !running && (
                <div className="mt-4 space-y-2">
                    {result.error ? (
                        <div className="status-badge-danger rounded-xl p-3 text-sm">
                            错误: {result.error}
                        </div>
                    ) : (
                        <>
                            <div className="flex gap-3 text-sm">
                                <span className="text-[var(--text-main)]">
                                    总计: <strong>{result.total}</strong>
                                </span>
                                <span className="text-[var(--status-success)]">
                                    通过: <strong>{result.passed}</strong>
                                </span>
                                <span className="text-[var(--status-danger)]">
                                    失败: <strong>{result.failed}</strong>
                                </span>
                            </div>
                            {/* Average scores */}
                            {result.avgScores && (
                                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                                    {Object.entries(result.avgScores).map(([key, val]) => (
                                        <div key={key} className="rounded-lg surface-card px-2 py-1 text-center">
                                            <span className="block text-[var(--text-muted)]">{key}</span>
                                            <span className="font-bold text-[var(--text-main)]">{val}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {/* Result list (top 10) */}
                            {result.results && result.results.length > 0 && (
                                <div className="max-h-60 overflow-auto surface-card rounded-xl">
                                    {result.results.slice(0, 10).map((r) => (
                                        <div
                                            key={r.testCaseId}
                                            className={`border-b border-[var(--panel-border)] px-3 py-2 text-xs last:border-b-0 ${
                                                r.passed ? "text-[var(--text-main)]" : "text-[var(--status-danger)]"
                                            }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="truncate font-medium">{r.testCaseId}</span>
                                                <span className="ml-2 shrink-0">{r.passed ? "✅" : "❌"}</span>
                                            </div>
                                            {/* Phase 6a G2: 代码判定摘要 */}
                                            {r.codeCheckSummary && r.codeCheckSummary.total > 0 && (
                                                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                                                    <span className="rounded-md bg-[var(--panel-soft)] px-1.5 py-0.5">
                                                        🔍 代码判定: {r.codeCheckSummary.passed}/{r.codeCheckSummary.total}
                                                    </span>
                                                    <span>
                                                        均分 {r.codeCheckSummary.avgScore}
                                                    </span>
                                                </div>
                                            )}
                                            {/* 各维度分数 */}
                                            {r.scores && (
                                                <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-[var(--text-muted)]">
                                                    {["correctness","tool_usage","tool_quality","conciseness","safety"].map((dim) => {
                                                        if (r.scores[dim] === undefined) return null;
                                                        const dimLabels = {correctness:"正确性",tool_usage:"工具选择",tool_quality:"工具质量",conciseness:"简洁",safety:"安全"};
                                                        return (
                                                            <span key={dim} className="rounded-md bg-[var(--panel-soft)] px-1.5 py-0.5">
                                                                {dimLabels[dim]}: <strong className="text-[var(--text-main)]">{r.scores[dim]}</strong>
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    {result.results.length > 10 && (
                                        <p className="px-3 py-1.5 text-xs text-[var(--text-muted)]">
                                            ... 还有 {result.results.length - 10} 条结果
                                        </p>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
