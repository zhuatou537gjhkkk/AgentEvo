/**
 * EvalDashboard.jsx — 评估仪表盘
 *
 * Phase 5: 对齐 AgentArts 观测评估面板。
 * 显示趋势图、统计卡片、最近分数、反馈汇总。
 */

import { useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";
import EvalRunner from "./EvalRunner.jsx";

/**
 * G8: 对比雷达图 + 维度差值表
 */
function CompareResults({ data }) {
    const { dims = [], dimLabels = [], baseline, comparisons = [], regressedDims = [] } = data;
    const RUN_COLORS = [
        "rgb(99, 102, 241)",  // indigo
        "rgb(20, 184, 166)",  // teal
        "rgb(245, 158, 11)",  // amber
        "rgb(244, 63, 94)",   // rose
        "rgb(16, 185, 129)",  // emerald
    ];
    const maxVal = 5;
    const n = dims.length;
    const cx = 130, cy = 130, r = 100;

    const getAngle = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
    const getPoint = (i, val) => {
        const ratio = val / maxVal;
        const angle = getAngle(i);
        return {
            x: cx + r * ratio * Math.cos(angle),
            y: cy + r * ratio * Math.sin(angle),
        };
    };

    // 网格
    const gridLevels = 5;
    const gridPolygons = [];
    for (let lv = 1; lv <= gridLevels; lv++) {
        const pts = [];
        for (let i = 0; i < n; i++) {
            const p = getPoint(i, lv);
            pts.push(`${p.x},${p.y}`);
        }
        gridPolygons.push(pts.join(" "));
    }

    return (
        <div className="mb-6 space-y-4">
            <h3 className="text-sm font-semibold text-[var(--text-main)]">
                📊 评估对比
                <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                    baseline: {baseline.runId.slice(0, 12)}...
                </span>
            </h3>

            {/* 叠加雷达图 */}
            <div className="surface-subtle rounded-2xl p-4">
                <div className="flex flex-col items-center">
                    <svg width="260" height="260" viewBox="0 0 260 260" className="overflow-visible">
                        {/* 网格 */}
                        {gridPolygons.map((pts, idx) => (
                            <polygon
                                key={`grid-${idx}`}
                                points={pts}
                                fill="none"
                                stroke="var(--panel-border)"
                                strokeWidth="1"
                                opacity={idx === gridLevels - 1 ? 0.6 : 0.35}
                            />
                        ))}
                        {/* 轴线 */}
                        {Array.from({ length: n }, (_, i) => {
                            const p = getPoint(i, maxVal);
                            return (
                                <line key={`axis-${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y}
                                    stroke="var(--panel-border)" strokeWidth="1" opacity="0.5" />
                            );
                        })}
                        {/* 每条 run 的多边形 */}
                        {comparisons.map((entry, idx) => {
                            const vals = dims.map(d => entry.avgScores[d] || 0);
                            const pts = vals.map((v, i) => {
                                const p = getPoint(i, v);
                                return `${p.x},${p.y}`;
                            }).join(" ");
                            const color = RUN_COLORS[idx % RUN_COLORS.length];
                            const isBaseline = entry.isBaseline;
                            return (
                                <polygon
                                    key={entry.runId}
                                    points={pts}
                                    fill={color}
                                    fillOpacity={isBaseline ? 0.10 : 0.05}
                                    stroke={color}
                                    strokeWidth={isBaseline ? "2.5" : "1.5"}
                                    strokeDasharray={isBaseline ? "none" : "4,3"}
                                    strokeOpacity={isBaseline ? 1 : 0.7}
                                />
                            );
                        })}
                        {/* 维度标签 */}
                        {Array.from({ length: n }, (_, i) => {
                            const p = getPoint(i, maxVal + 0.28);
                            return (
                                <text key={`label-${i}`} x={p.x} y={p.y} textAnchor="middle"
                                    dominantBaseline="middle" fill="var(--text-main)" fontSize="11" fontWeight="500">
                                    {dimLabels[i]}
                                </text>
                            );
                        })}
                    </svg>
                    {/* Legend */}
                    <div className="mt-3 flex flex-wrap justify-center gap-3">
                        {comparisons.map((entry, idx) => (
                            <div key={entry.runId} className="flex items-center gap-1.5 text-xs">
                                <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: RUN_COLORS[idx % RUN_COLORS.length] }} />
                                <span className={entry.isBaseline ? "font-semibold text-[var(--text-main)]" : "text-[var(--text-muted)]"}>
                                    {entry.runId.slice(0, 10)}...{entry.isBaseline ? " (baseline)" : ""}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* 维度差值表 */}
            <div className="overflow-auto rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)]">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="border-b border-[var(--panel-border)]">
                            <th className="px-3 py-2 text-left font-semibold text-[var(--text-main)]">维度</th>
                            {comparisons.map((entry) => (
                                <th key={entry.runId} className={`px-3 py-2 text-center font-semibold ${
                                    entry.isBaseline ? "text-[var(--brand)]" : "text-[var(--text-main)]"
                                }`}>
                                    {entry.isBaseline ? "基线" : entry.runId.slice(0, 8)}...
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {dims.map((dim, i) => (
                            <tr key={dim} className={`border-b border-[var(--panel-border)] ${
                                regressedDims.includes(dim) ? "bg-[var(--status-danger-soft)]" : ""
                            }`}>
                                <td className={`px-3 py-2 font-medium ${
                                    regressedDims.includes(dim) ? "text-red-600 dark:text-red-400" : "text-[var(--text-main)]"
                                }`}>
                                    {dimLabels[i] ?? dim}
                                    {regressedDims.includes(dim) && <span className="ml-1 text-[10px]">⚠</span>}
                                </td>
                                {comparisons.map((entry) => {
                                    const baselineVal = comparisons[0]?.avgScores[dim] || 0;
                                    const val = entry.avgScores[dim] || 0;
                                    const delta = val - baselineVal;
                                    const isRegressed = delta < -0.5;
                                    return (
                                        <td key={entry.runId} className={`px-3 py-2 text-center ${
                                            isRegressed ? "font-semibold text-red-600 dark:text-red-400" : "text-[var(--text-main)]"
                                        }`}>
                                            {val}
                                            {!entry.isBaseline && (
                                                <span className={`ml-1 text-[10px] ${
                                                    delta >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
                                                }`}>
                                                    {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
                                                </span>
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                        {/* 通过率行 */}
                        <tr className="border-b border-[var(--panel-border)]">
                            <td className="px-3 py-2 font-medium text-[var(--text-main)]">通过率</td>
                            {comparisons.map((entry) => (
                                <td key={entry.runId} className="px-3 py-2 text-center text-[var(--text-main)]">
                                    {(entry.passedRate * 100).toFixed(0)}% ({entry.passed}/{entry.total})
                                </td>
                            ))}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function EvalDashboard({ embedded = false, onBack }) {
    const isOpen = useChatStore((s) => s.isEvalDashboardOpen);
    const isVisible = embedded || isOpen;
    const toggleEvalDashboard = useChatStore((s) => s.toggleEvalDashboard);
    const evalReportData = useChatStore((s) => s.evalReportData);
    const fetchEvalReport = useChatStore((s) => s.fetchEvalReport);

    const [showRunner, setShowRunner] = useState(false);
    const [loading, setLoading] = useState(false);
    const [runs, setRuns] = useState([]);
    const [selectedRunId, setSelectedRunId] = useState(""); // "" = 全部
    const [evalMode, setEvalMode] = useState("offline"); // "offline" | "online" | "generator"

    // G7: 生成用例相关 state
    const generatedCases = useChatStore((s) => s.generatedCases);
    const generatedCasesLoading = useChatStore((s) => s.generatedCasesLoading);
    const fetchGeneratedCases = useChatStore((s) => s.fetchGeneratedCases);
    const generateTestCases = useChatStore((s) => s.generateTestCases);
    const updateGeneratedCase = useChatStore((s) => s.updateGeneratedCase);
    const deleteGeneratedCase = useChatStore((s) => s.deleteGeneratedCase);
    const approveGeneratedCases = useChatStore((s) => s.approveGeneratedCases);

    // G8: 评估对比
    const comparisonData = useChatStore((s) => s.comparisonData);
    const compareRunsAction = useChatStore((s) => s.compareRuns);

    const [isCompareMode, setIsCompareMode] = useState(false);
    const [compareRunIds, setCompareRunIds] = useState([]); // 选中的 run IDs
    const [comparingLoading, setComparingLoading] = useState(false);

    const [genSeeds, setGenSeeds] = useState([]); // selected seed IDs
    const [genCategory, setGenCategory] = useState("knowledge_qa");
    const [genCount, setGenCount] = useState(10);
    const [genEasy, setGenEasy] = useState(3);
    const [genMedium, setGenMedium] = useState(5);
    const [genHard, setGenHard] = useState(2);
    const [genResult, setGenResult] = useState(null); // last generation result
    const [genFilterReviewed, setGenFilterReviewed] = useState(null); // null=all, 0=pending, 1=reviewed
    const [genFilterCategory, setGenFilterCategory] = useState("");
    const [genLoading, setGenLoading] = useState(false);
    const [runningCaseId, setRunningCaseId] = useState(null); // 正在跑的单条用例 ID
    const [runResult, setRunResult] = useState({}); // { [caseId]: { passed, scores } }

    // 编辑状态
    const [editingCaseId, setEditingCaseId] = useState(null);
    const [editForm, setEditForm] = useState({ input: "", expectedBehavior: "", difficulty: "" });

    // G10: 优化闭环 state
    const [optSelectedRunId, setOptSelectedRunId] = useState("");
    const [optBadCases, setOptBadCases] = useState(null);
    const [optSuggestions, setOptSuggestions] = useState(null);
    const [optSelectedIds, setOptSelectedIds] = useState(new Set());
    const [optLabel, setOptLabel] = useState("");
    const [optLogId, setOptLogId] = useState(null);
    const [optResult, setOptResult] = useState(null); // { logId, configVersionId }
    const [optReevalResult, setOptReevalResult] = useState(null); // { newRunId, scoreAfter }
    const [optCompareResult, setOptCompareResult] = useState(null); // before/after comparison
    const [optLoading, setOptLoading] = useState(false);
    const [optLoadingMsg, setOptLoadingMsg] = useState("");
    const [optHistory, setOptHistory] = useState([]);
    const [optShowHistory, setOptShowHistory] = useState(false);

    // 获取已有用例作为可选种子
    const availableCases = useChatStore((s) => {
        // 从 evalReportData 的 categories 获取分类信息
        return [];
    });

    // 加载 run 列表 + 报告
    useEffect(() => {
        if (!isVisible) return;
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
    }, [isVisible]);

    // G7: 切换到生成 tab 时加载生成用例列表
    useEffect(() => {
        if (!isVisible || evalMode !== "generator") return;
        fetchGeneratedCases({
            category: genFilterCategory || null,
            reviewed: genFilterReviewed,
        });
    }, [isVisible, evalMode, genFilterCategory, genFilterReviewed]);

    // 切换 runId 时重新加载报告
    const handleRunChange = async (runId) => {
        setSelectedRunId(runId);
        setLoading(true);
        await fetchEvalReport(runId || null);
        setLoading(false);
    };

    // ESC dismiss
    useEffect(() => {
        if (!isVisible) return;
        const handleKey = (e) => {
            if (e.key === "Escape") toggleEvalDashboard();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [isVisible]);

    if (!isVisible) return null;

    const trendData = (evalReportData?.trendData || []).filter(d => d.score_type === evalMode || !d.score_type);
    const feedbackStats = evalReportData?.feedbackStats || { thumbs_up: 0, thumbs_down: 0, total: 0 };
    const categories = (evalReportData?.categories || []).filter(c => c.score_type === evalMode || !c.score_type);

    // Compute max score for bar scaling
    const maxScore = 5;

    // ── SVG 五维雷达图数据 ──
    const radarData = (() => {
        if (trendData.length === 0) return null;
        // 取最新一条趋势数据（trendData 最新在前）
        const latest = trendData[0];
        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
        const labels = ["正确性", "工具选择", "工具质量", "简洁度", "安全性"];
        const values = dims.map((d) => typeof latest[d] === "number" ? latest[d] : 0);
        if (values.every((v) => v === 0)) return null;
        return { dims, labels, values, maxVal: 5 };
    })();

    const renderRadarChart = () => {
        if (!radarData) return null;
        const { labels, values, maxVal } = radarData;
        const n = labels.length;
        const cx = 130, cy = 130, r = 100; // SVG 坐标系
        const levels = 5; // 5 层同心网格

        // 计算每个维度的角度 (从顶部顺时针)
        const getAngle = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
        const getPoint = (i, val) => {
            const ratio = val / maxVal;
            const angle = getAngle(i);
            return {
                x: cx + r * ratio * Math.cos(angle),
                y: cy + r * ratio * Math.sin(angle),
            };
        };

        // 网格多边形
        const gridPolygons = [];
        for (let lv = 1; lv <= levels; lv++) {
            const pts = [];
            for (let i = 0; i < n; i++) {
                const p = getPoint(i, lv);
                pts.push(`${p.x},${p.y}`);
            }
            gridPolygons.push(pts.join(" "));
        }

        // 数据多边形
        const dataPts = [];
        for (let i = 0; i < n; i++) {
            const p = getPoint(i, values[i]);
            dataPts.push(`${p.x},${p.y}`);
        }
        const dataPolygon = dataPts.join(" ");

        return (
            <div className="flex flex-col items-center">
                <svg width="260" height="260" viewBox="0 0 260 260" className="overflow-visible">
                    {/* 网格 */}
                    {gridPolygons.map((pts, idx) => (
                        <polygon
                            key={`grid-${idx}`}
                            points={pts}
                            fill="none"
                            stroke="var(--panel-border)"
                            strokeWidth="1"
                            opacity={idx === levels - 1 ? 0.6 : 0.35}
                        />
                    ))}
                    {/* 轴线 */}
                    {Array.from({ length: n }, (_, i) => {
                        const p = getPoint(i, maxVal);
                        return (
                            <line
                                key={`axis-${i}`}
                                x1={cx} y1={cy}
                                x2={p.x} y2={p.y}
                                stroke="var(--panel-border)"
                                strokeWidth="1"
                                opacity="0.5"
                            />
                        );
                    })}
                    {/* 数据区域 */}
                    <polygon
                        points={dataPolygon}
                        fill="rgba(99, 102, 241, 0.2)"
                        stroke="rgba(99, 102, 241, 0.7)"
                        strokeWidth="2"
                    />
                    {/* 数据点 */}
                    {Array.from({ length: n }, (_, i) => {
                        const p = getPoint(i, values[i]);
                        return (
                            <circle
                                key={`dot-${i}`}
                                cx={p.x} cy={p.y} r="3.5"
                                fill="rgb(99, 102, 241)"
                                stroke="white"
                                strokeWidth="1.5"
                            />
                        );
                    })}
                    {/* 标签 */}
                    {Array.from({ length: n }, (_, i) => {
                        const p = getPoint(i, maxVal + 0.28);
                        return (
                            <text
                                key={`label-${i}`}
                                x={p.x} y={p.y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="var(--text-main)"
                                fontSize="11"
                                fontWeight="500"
                            >
                                {labels[i]}
                            </text>
                        );
                    })}
                    {/* 分数标签：向内偏移避免与维度标签重叠 */}
                    {Array.from({ length: n }, (_, i) => {
                        const p = getPoint(i, values[i]);
                        const angle = getAngle(i);
                        // 向内（圆心方向）偏移，让分数显示在数据多边形内部
                        const offsetX = -Math.cos(angle) * 20;
                        const offsetY = -Math.sin(angle) * 20;
                        return (
                            <text
                                key={`score-${i}`}
                                x={p.x + offsetX} y={p.y + offsetY}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="var(--brand)"
                                fontSize="11"
                                fontWeight="700"
                            >
                                {values[i]}
                            </text>
                        );
                    })}
                </svg>
            </div>
        );
    };

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
                            {["correctness", "tool_usage", "tool_quality", "conciseness", "safety"].map((dim, i) => {
                                const colors = ["bg-blue-500", "bg-green-500", "bg-teal-500", "bg-amber-500", "bg-purple-500"];
                                const labels = ["正确性", "工具选择", "工具质量", "简洁", "安全"];
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

    // ── G10: 优化闭环面板 ──
    const OptimizationPanel = () => {
        const handleAnalyze = async () => {
            if (!optSelectedRunId) return;
            setOptLoading(true);
            setOptLoadingMsg("正在分析 BadCase...");
            setOptBadCases(null);
            setOptSuggestions(null);
            setOptResult(null);
            setOptReevalResult(null);
            setOptCompareResult(null);
            try {
                const { analyzeBadCases } = await import("../api/eval.js");
                const data = await analyzeBadCases(optSelectedRunId);
                if (data?.ok) {
                    setOptBadCases(data);
                } else {
                    // 后端返回 ok: false（如 run 不存在、无评分数据等）
                    setOptBadCases({ ok: false, error: data?.message || "分析失败，请检查该 run 是否有评估数据" });
                }
            } catch (err) {
                setOptBadCases({ ok: false, error: err.message });
            } finally {
                setOptLoading(false);
                setOptLoadingMsg("");
            }
        };

        const handleSuggest = async () => {
            if (!optBadCases?.badCases?.length) return;
            setOptLoading(true);
            setOptLoadingMsg("LLM 正在生成优化建议...");
            setOptSuggestions(null);
            try {
                const { suggestOptimizations } = await import("../api/eval.js");
                const data = await suggestOptimizations(optSelectedRunId, optBadCases.badCases);
                if (data?.ok) {
                    setOptSuggestions(data);
                    // 默认全选
                    setOptSelectedIds(new Set(data.suggestions.map((s, i) => i)));
                }
            } catch (err) {
                setOptSuggestions({ ok: false, error: err.message });
            } finally {
                setOptLoading(false);
                setOptLoadingMsg("");
            }
        };

        const handleApply = async () => {
            if (!optSuggestions?.suggestions?.length) return;
            const selectedSuggestions = optSuggestions.suggestions.filter((_, i) => optSelectedIds.has(i));
            if (selectedSuggestions.length === 0) return;

            const changes = selectedSuggestions.map(s => ({ key: s.configKey, value: s.suggestedValue }));
            const badCaseIds = optBadCases?.badCases?.map(bc => bc.testCaseId) || [];
            const scoreBefore = {
                weightedAvg: optBadCases?.summary?.avgWeightedScore || 0,
                badCount: optBadCases?.summary?.badCount || 0,
                total: optBadCases?.summary?.total || 0,
            };

            setOptLoading(true);
            setOptLoadingMsg("正在应用配置变更...");
            try {
                const { applyOptimizations } = await import("../api/eval.js");
                const data = await applyOptimizations({
                    sourceRunId: optSelectedRunId,
                    changes,
                    suggestions: selectedSuggestions,
                    badCaseIds,
                    scoreBefore,
                    label: optLabel || `优化 ${new Date().toLocaleDateString("zh-CN")}`,
                });
                setOptResult(data);
                if (data?.ok) {
                    setOptLogId(data.logId);
                }
            } catch (err) {
                setOptResult({ ok: false, error: err.message });
            } finally {
                setOptLoading(false);
                setOptLoadingMsg("");
            }
        };

        const handleReevaluate = async () => {
            if (!optLogId || !optBadCases?.badCases?.length) return;
            const testCaseIds = optBadCases.badCases.map(bc => bc.testCaseId);

            setOptLoading(true);
            setOptLoadingMsg("正在重新评估（可能需要几分钟）...");
            try {
                const { reevaluateOptimization } = await import("../api/eval.js");
                const data = await reevaluateOptimization(optLogId, testCaseIds);
                setOptReevalResult(data);

                // Step ⑥: 自动对比
                if (data?.ok && data.newRunId) {
                    setOptLoadingMsg("正在对比优化前后分数...");
                    const { compareRuns } = await import("../api/eval.js");
                    const comp = await compareRuns([optSelectedRunId, data.newRunId]);
                    if (comp?.ok) {
                        setOptCompareResult(comp);
                    }
                }
            } catch (err) {
                setOptReevalResult({ ok: false, error: err.message });
            } finally {
                setOptLoading(false);
                setOptLoadingMsg("");
            }
        };

        const handleLoadHistory = async () => {
            setOptShowHistory(!optShowHistory);
            if (!optShowHistory) {
                try {
                    const { fetchOptimizationHistory } = await import("../api/eval.js");
                    const data = await fetchOptimizationHistory(20);
                    if (data?.ok) setOptHistory(data.logs || []);
                } catch { /* 静默 */ }
            }
        };

        // 回滚：通过 restoreVersion 恢复旧配置
        const handleRollback = async (logId, configVersionId) => {
            if (!configVersionId) return;
            if (!window.confirm("确定回滚到此优化之前的配置版本吗？")) return;
            try {
                const { request } = await import("../api/chat.js");
                // 使用 agentConfig 的 restore 逻辑
                await request("/agent-config/rollback", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ versionId: configVersionId }),
                });
                alert("已回滚配置版本");
                handleLoadHistory();
            } catch (err) {
                alert("回滚失败: " + err.message);
            }
        };

        const dimLabels = ["正确性", "工具选择", "工具质量", "简洁度", "安全性"];
        const dimColors = ["text-blue-600", "text-green-600", "text-teal-600", "text-amber-600", "text-purple-600"];
        const dimBgColors = ["bg-blue-50 dark:bg-blue-900/20", "bg-[var(--status-success-soft)]", "bg-teal-50 dark:bg-teal-900/20", "bg-amber-50 dark:bg-amber-900/20", "bg-[var(--accent-soft)]"];
        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];

        const stepActive = (step) => {
            if (optLoading) return false;
            if (step === 1) return !!optSelectedRunId;
            if (step === 2) return !!optBadCases?.badCases?.length;
            if (step === 3) return !!optSuggestions?.suggestions?.length && optSelectedIds.size > 0;
            if (step === 4) return !!optResult?.ok && !!optLogId;
            return false;
        };

        return (
            <div className="space-y-4">
                {/* Step 1: 选择 Run */}
                <div className="surface-subtle rounded-2xl p-4">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                        ① 选择评估 Run
                    </h3>
                    <div className="flex items-center gap-3">
                        <select
                            value={optSelectedRunId}
                            onChange={(e) => {
                                setOptSelectedRunId(e.target.value);
                                setOptBadCases(null);
                                setOptSuggestions(null);
                                setOptResult(null);
                                setOptReevalResult(null);
                                setOptCompareResult(null);
                            }}
                            className="flex-1 surface-card rounded-xl px-3 py-2 text-sm text-[var(--text-main)] outline-none focus:border-[var(--brand)]"
                        >
                            <option value="">选择评估 Run...</option>
                            {runs.map((r) => (
                                <option key={r.run_id} value={r.run_id}>
                                    {r.run_id} ({new Date(r.created_at).toLocaleDateString("zh-CN")})
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={handleAnalyze}
                            disabled={!optSelectedRunId || optLoading}
                            className="shrink-0 rounded-xl bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
                        >
                            {optLoading && optLoadingMsg.includes("分析") ? "分析中..." : "② 分析 BadCase"}
                        </button>
                    </div>
                </div>

                {/* Loading indicator */}
                {optLoading && (
                    <div className="rounded-xl border border-[var(--brand)] bg-[var(--status-info-soft)] px-4 py-3 text-sm text-[var(--brand)] flex items-center gap-2">
                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        {optLoadingMsg || "处理中..."}
                    </div>
                )}

                {/* 分析结果：错误 / 空 / 成功 */}
                {optBadCases && !optBadCases.ok && (
                    <div className="rounded-xl border status-badge-danger rounded-xl px-4 py-3 text-xs">
                        ❌ 分析失败: {optBadCases.error || "未知错误"}
                    </div>
                )}

                {optBadCases?.ok && optBadCases.badCases?.length === 0 && (
                    <div className="rounded-xl border status-badge-warning rounded-xl px-4 py-3 text-xs">
                        📭 该 run 未发现 BadCase（所有用例加权分均 ≥ 3.0），无需优化。
                        {optBadCases.summary && (
                            <span className="ml-1 text-[var(--text-muted)]">
                                (共 {optBadCases.summary.total} 个用例，均分 {optBadCases.summary.avgWeightedScore})
                            </span>
                        )}
                    </div>
                )}

                {/* Step 2: BadCase 列表 */}
                {optBadCases?.ok && optBadCases.badCases?.length > 0 && (
                    <div className="surface-subtle rounded-2xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-semibold text-[var(--text-main)]">
                                ② BadCase 分析
                                <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                                    {optBadCases.badCases.length}/{optBadCases.summary.total} 用例低于阈值 ({optBadCases.summary.avgWeightedScore} 分)
                                </span>
                            </h3>
                            <button
                                type="button"
                                onClick={handleSuggest}
                                disabled={optLoading}
                                className="shrink-0 rounded-xl bg-[var(--brand-start)] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[var(--brand-mid)] disabled:opacity-50 transition"
                            >
                                {optLoading && optLoadingMsg.includes("建议") ? "生成中..." : "③ 生成优化建议"}
                            </button>
                        </div>

                        {/* 根因分布 */}
                        {optBadCases.summary.byRootCause && (
                            <div className="mb-3 flex gap-2 text-[11px]">
                                {Object.entries(optBadCases.summary.byRootCause).map(([cause, count], i) => (
                                    <span key={cause} className={`rounded-full px-2 py-0.5 font-medium ${dimBgColors[i % 5]} ${dimColors[i % 5]}`}>
                                        {dimLabels[dims.indexOf(cause)] || cause}: {count}
                                    </span>
                                ))}
                            </div>
                        )}

                        <div className="max-h-[40vh] space-y-1.5 overflow-auto">
                            {optBadCases.badCases.map((bc, i) => (
                                <div key={bc.testCaseId} className="rounded-lg surface-card p-2.5 text-xs">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <span className="font-mono text-[var(--text-muted)]">{bc.testCaseId}</span>
                                        <span className="rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                            {bc.weightedAvg} 分
                                        </span>
                                    </div>
                                    <p className="text-[var(--text-main)] truncate">{bc.description || bc.input || ""}</p>
                                    <div className="mt-1 flex gap-2 text-[11px]">
                                        {dims.map((dim, di) => {
                                            const score = bc.scores?.[dim];
                                            const low = score !== undefined && score < 3.0;
                                            return (
                                                <span key={dim} className={low ? "font-semibold text-red-600 dark:text-red-400" : "text-[var(--text-muted)]"}>
                                                    {dimLabels[di]}: {score ?? "-"}
                                                </span>
                                            );
                                        })}
                                    </div>
                                    {bc.rootCause && (
                                        <span className={`mt-0.5 inline-block rounded px-1 py-0.5 text-[10px] ${dimBgColors[dims.indexOf(bc.rootCause)]} ${dimColors[dims.indexOf(bc.rootCause)]}`}>
                                            根因: {dimLabels[dims.indexOf(bc.rootCause)] || bc.rootCause}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Step 3: LLM 优化建议 */}
                {optSuggestions?.ok && optSuggestions.suggestions?.length > 0 && (
                    <div className="surface-subtle rounded-2xl p-4">
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                            ③ 优化建议
                            {optSuggestions.summary && (
                                <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                                    {optSuggestions.summary}
                                </span>
                            )}
                        </h3>

                        <div className="space-y-2">
                            {optSuggestions.suggestions.map((s, i) => {
                                const isSelected = optSelectedIds.has(i);
                                return (
                                    <div
                                        key={i}
                                        className={`rounded-xl border p-3 text-xs cursor-pointer transition ${
                                            isSelected
                                                ? "border-[var(--brand)] bg-[var(--status-info-soft)]"
                                                : "border-[var(--panel-border)] bg-[var(--panel-bg)] opacity-70"
                                        }`}
                                        onClick={() => {
                                            const next = new Set(optSelectedIds);
                                            if (isSelected) next.delete(i);
                                            else next.add(i);
                                            setOptSelectedIds(next);
                                        }}
                                    >
                                        <div className="flex items-start gap-2">
                                            <input
                                                type="checkbox"
                                                checked={isSelected}
                                                onChange={() => {}}
                                                className="mt-0.5 shrink-0 accent-[var(--brand)]"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <code className="rounded bg-[var(--panel-soft)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--brand)]">
                                                        {s.configKey}
                                                    </code>
                                                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                                        置信度 {(s.confidence * 100).toFixed(0)}%
                                                    </span>
                                                </div>
                                                <div className="space-y-1 text-[var(--text-muted)]">
                                                    <p>
                                                        <span className="text-red-500 line-through">当前: {s.currentValue?.slice(0, 100) || "(空)"}</span>
                                                    </p>
                                                    <p>
                                                        <span className="text-green-600 dark:text-green-400">建议: {s.suggestedValue?.slice(0, 200)}</span>
                                                    </p>
                                                </div>
                                                {s.rationale && (
                                                    <p className="mt-1 text-[var(--text-muted)] italic">{s.rationale}</p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* 标签输入 + 应用按钮 */}
                        <div className="mt-4 flex items-center gap-3">
                            <input
                                type="text"
                                value={optLabel}
                                onChange={(e) => setOptLabel(e.target.value)}
                                placeholder={'优化标签（可选，如“修复 knowledge correctness”）'}
                                className="flex-1 surface-card rounded-xl px-3 py-2 text-xs text-[var(--text-main)] outline-none focus:border-[var(--brand)]"
                            />
                            <button
                                type="button"
                                onClick={handleApply}
                                disabled={optLoading || optSelectedIds.size === 0}
                                className="shrink-0 rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 transition"
                            >
                                {optLoading && optLoadingMsg.includes("应用") ? "应用中..." : `④ 应用选中建议 (${optSelectedIds.size})`}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 4: 应用结果 */}
                {optResult && (
                    <div className={`rounded-xl p-3 text-xs ${optResult.ok ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400" : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"}`}>
                        {optResult.ok
                            ? `✅ 已应用配置变更 (logId=${optResult.logId}, versionId=${optResult.configVersionId})`
                            : `❌ 应用失败: ${optResult.error || "未知错误"}`}
                    </div>
                )}

                {/* Step ⑤: 重评 */}
                {optResult?.ok && (
                    <div className="surface-subtle rounded-2xl p-4">
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                            ⑤ 重评验证
                        </h3>
                        <p className="mb-3 text-xs text-[var(--text-muted)]">
                            使用新配置重新评估 {optBadCases?.badCases?.length || 0} 个 BadCase
                        </p>
                        <button
                            type="button"
                            onClick={handleReevaluate}
                            disabled={optLoading}
                            className="rounded-xl bg-[var(--brand-start)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-mid)] disabled:opacity-50 transition"
                        >
                            {optLoading && optLoadingMsg.includes("评估") ? "评估中..." : "🔄 重评 BadCase"}
                        </button>
                    </div>
                )}

                {/* Step ⑥: 对比结果 */}
                {optCompareResult && (
                    <div className="surface-subtle rounded-2xl p-4">
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                            ⑥ 优化对比
                            {optReevalResult?.scoreAfter && (
                                <span className={`ml-2 text-xs font-normal ${optReevalResult.scoreAfter.weightedAvg > (optBadCases?.summary?.avgWeightedScore || 0) ? "text-green-600" : "text-red-600"}`}>
                                    {optReevalResult.scoreAfter.weightedAvg > (optBadCases?.summary?.avgWeightedScore || 0) ? "✅ " : "❌ "}
                                    {optBadCases?.summary?.avgWeightedScore || 0} → {optReevalResult.scoreAfter.weightedAvg?.toFixed(2) || "?"}
                                </span>
                            )}
                        </h3>

                        {/* 维度差值表 */}
                        {optCompareResult.comparisons && optCompareResult.comparisons.length >= 2 && (
                            <div className="overflow-auto rounded-xl border border-[var(--panel-border)]">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="border-b border-[var(--panel-border)]">
                                            <th className="px-3 py-2 text-left font-semibold text-[var(--text-main)]">维度</th>
                                            <th className="px-3 py-2 text-center text-[var(--text-muted)]">优化前</th>
                                            <th className="px-3 py-2 text-center text-[var(--text-muted)]">优化后</th>
                                            <th className="px-3 py-2 text-center text-[var(--text-muted)]">差值</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {dims.map((dim, i) => {
                                            const baseline = optCompareResult.comparisons[0];
                                            const after = optCompareResult.comparisons[1];
                                            const beforeVal = baseline?.avgScores?.[dim] || 0;
                                            const afterVal = after?.avgScores?.[dim] || 0;
                                            const delta = afterVal - beforeVal;
                                            return (
                                                <tr key={dim} className="border-b border-[var(--panel-border)]">
                                                    <td className="px-3 py-2 font-medium text-[var(--text-main)]">{dimLabels[i]}</td>
                                                    <td className="px-3 py-2 text-center text-[var(--text-main)]">{beforeVal}</td>
                                                    <td className="px-3 py-2 text-center text-[var(--text-main)]">{afterVal}</td>
                                                    <td className={`px-3 py-2 text-center font-semibold ${delta >= 0 ? "text-green-600" : "text-red-600"}`}>
                                                        {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}

                {/* 优化历史 Toggle */}
                <div>
                    <button
                        type="button"
                        onClick={handleLoadHistory}
                        className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--text-main)] hover:opacity-80 transition"
                    >
                        {optShowHistory ? "隐藏历史" : "📋 优化历史"}
                    </button>

                    {optShowHistory && (
                        <div className="mt-2 space-y-1">
                            {optHistory.length === 0 ? (
                                <p className="py-4 text-center text-xs text-[var(--text-muted)]">暂无优化记录</p>
                            ) : (
                                optHistory.map((log) => (
                                    <div key={log.id} className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] p-2.5 text-xs">
                                        <div className="flex items-center justify-between gap-2">
                                            <div>
                                                <span className="font-semibold text-[var(--text-main)]">{log.label || `优化 #${log.id}`}</span>
                                                <span className="ml-2 text-[var(--text-muted)]">
                                                    来源: {String(log.source_run_id).slice(0, 12)}...
                                                </span>
                                                {log.score_before && typeof log.score_before === "object" && log.score_after && typeof log.score_after === "object" && (
                                                    <span className={`ml-2 font-semibold ${
                                                        (log.score_after.weightedAvg || 0) > (log.score_before.weightedAvg || 0)
                                                            ? "text-green-600" : "text-red-600"
                                                    }`}>
                                                        {log.score_before.weightedAvg?.toFixed?.(2) || log.score_before.weightedAvg}
                                                        {" → "}
                                                        {log.score_after.weightedAvg?.toFixed?.(2) || log.score_after.weightedAvg}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                                    log.status === "applied" ? "bg-amber-100 text-amber-700" :
                                                    log.status === "reevaluated" ? "bg-green-100 text-green-700" :
                                                    "bg-gray-100 text-gray-600"
                                                }`}>
                                                    {log.status === "applied" ? "已应用" : log.status === "reevaluated" ? "已重评" : log.status}
                                                </span>
                                                <span className="text-[var(--text-muted)]">{new Date(log.created_at).toLocaleDateString("zh-CN")}</span>
                                                {log.config_version_before && log.status === "applied" && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRollback(log.id, log.config_version_before)}
                                                        className="rounded border border-red-200 px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-50 transition"
                                                    >
                                                        回滚
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // ── G7: 生成用例面板 ──
    const GeneratorPanel = () => {
        const handleGenerate = async () => {
            setGenLoading(true);
            setGenResult(null);
            try {
                // Build seeds from selected IDs using eval test cases
                const seedObjects = genSeeds.map(id => {
                    // Seeds can come from hardcoded testCases or from generated cases
                    const tc = generatedCases.find(c => c.id === id);
                    if (tc) return { id: tc.id, category: tc.category, difficulty: tc.difficulty, input: tc.input, expectedBehavior: tc.expected_behavior || tc.expectedBehavior, expectedTools: Array.isArray(tc.expected_tools) ? tc.expected_tools : tc.expectedTools, enableWebSearch: tc.enable_web_search || tc.enableWebSearch };
                    return null;
                }).filter(Boolean);

                const options = {
                    category: genCategory,
                    count: genCount,
                    difficultyMix: { easy: genEasy, medium: genMedium, hard: genHard },
                };
                const data = await generateTestCases(seedObjects, options);
                setGenResult(data);
            } catch (err) {
                setGenResult({ ok: false, error: err.message });
            } finally {
                setGenLoading(false);
            }
        };

        const handleReview = async (id) => {
            await updateGeneratedCase(id, { reviewed: 1 });
            fetchGeneratedCases({ category: genFilterCategory || null, reviewed: genFilterReviewed });
        };

        const handleDelete = async (id) => {
            if (!window.confirm("确定删除此用例？")) return;
            await deleteGeneratedCase(id);
            fetchGeneratedCases({ category: genFilterCategory || null, reviewed: genFilterReviewed });
        };

        const handleRunCase = async (tc) => {
            setRunningCaseId(tc.id);
            try {
                const { runEvalSuite } = await import("../api/eval.js");
                const report = await runEvalSuite({ testCaseIds: [tc.id] });
                if (report?.ok && report.results?.length > 0) {
                    const r = report.results[0];
                    setRunResult((prev) => ({
                        ...prev,
                        [tc.id]: { passed: r.passed, scores: r.scores, latencyMs: r.latencyMs, textPreview: r.textPreview, toolCalls: r.toolCalls },
                    }));
                } else {
                    setRunResult((prev) => ({
                        ...prev,
                        [tc.id]: { passed: false, scores: null, error: report?.message || "运行失败" },
                    }));
                }
            } catch (err) {
                setRunResult((prev) => ({
                    ...prev,
                    [tc.id]: { passed: false, scores: null, error: err.message },
                }));
            } finally {
                setRunningCaseId(null);
            }
        };

        const handleBatchApprove = async () => {
            const pending = generatedCases.filter(c => !c.reviewed).map(c => c.id);
            if (pending.length === 0) return;
            if (!window.confirm(`确定审核全部 ${pending.length} 条待审核用例？`)) return;
            await approveGeneratedCases(pending);
            fetchGeneratedCases({ category: genFilterCategory || null, reviewed: genFilterReviewed });
        };

        const startEdit = (tc) => {
            setEditingCaseId(tc.id);
            setEditForm({
                input: tc.input || "",
                expectedBehavior: tc.expected_behavior || tc.expectedBehavior || "",
                difficulty: tc.difficulty || "medium",
            });
        };

        const saveEdit = async (id) => {
            await updateGeneratedCase(id, editForm);
            setEditingCaseId(null);
            fetchGeneratedCases({ category: genFilterCategory || null, reviewed: genFilterReviewed });
        };

        const CATEGORIES = ["knowledge_qa", "web_search", "multi_step", "memory_recall", "code_generation", "creative", "tool_selection", "edge_case"];
        const DIFFICULTIES = ["easy", "medium", "hard"];

        return (
            <div className="space-y-4">
                {/* 生成配置 */}
                <div className="surface-subtle rounded-2xl p-4">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">生成配置</h3>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {/* 分类 */}
                        <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">目标分类</label>
                            <select
                                value={genCategory}
                                onChange={(e) => setGenCategory(e.target.value)}
                                className="w-full rounded-lg surface-card px-2.5 py-1.5 text-xs text-[var(--text-main)] outline-none"
                            >
                                {CATEGORIES.map(c => (
                                    <option key={c} value={c}>{c}</option>
                                ))}
                            </select>
                        </div>

                        {/* 数量 */}
                        <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">生成数量: {genCount}</label>
                            <input
                                type="range" min="1" max="50" value={genCount}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    setGenCount(v);
                                    setGenEasy(Math.round(v * 0.3));
                                    setGenMedium(Math.round(v * 0.5));
                                    setGenHard(Math.round(v * 0.2));
                                }}
                                className="w-full accent-[var(--brand)]"
                            />
                        </div>

                        {/* 难度配比 */}
                        <div className="col-span-2">
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">
                                难度配比: easy={genEasy} medium={genMedium} hard={genHard}
                            </label>
                            <div className="flex gap-2">
                                {DIFFICULTIES.map(d => {
                                    const val = d === "easy" ? genEasy : d === "medium" ? genMedium : genHard;
                                    const setVal = d === "easy" ? setGenEasy : d === "medium" ? setGenMedium : setGenHard;
                                    return (
                                        <label key={d} className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                                            <span className="w-12">{d}</span>
                                            <input
                                                type="number" min="0" max="50" value={val}
                                                onChange={(e) => setVal(Math.max(0, Number(e.target.value)))}
                                                className="w-14 rounded surface-card px-1.5 py-0.5 text-xs text-[var(--text-main)] outline-none"
                                            />
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={handleGenerate}
                        disabled={genLoading}
                        className="mt-4 w-full rounded-xl bg-[var(--brand)] py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
                    >
                        {genLoading ? "生成中..." : `🤖 生成 ${genCount} 条用例`}
                    </button>

                    {/* 生成结果提示 */}
                    {genResult && (
                        <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${genResult.ok ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400" : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"}`}>
                            {genResult.ok ? `✅ 成功生成 ${genResult.count} 条用例 (批次: ${genResult.batchId})` : `❌ ${genResult.error || "生成失败"}`}
                        </div>
                    )}
                </div>

                {/* 筛选栏 */}
                <div className="flex items-center gap-3">
                    <select
                        value={genFilterReviewed === null ? "all" : String(genFilterReviewed)}
                        onChange={(e) => setGenFilterReviewed(e.target.value === "all" ? null : Number(e.target.value))}
                        className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs text-[var(--text-main)] outline-none"
                    >
                        <option value="all">全部状态</option>
                        <option value="0">🟡 待审核</option>
                        <option value="1">🟢 已审核</option>
                    </select>
                    <select
                        value={genFilterCategory}
                        onChange={(e) => setGenFilterCategory(e.target.value)}
                        className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs text-[var(--text-main)] outline-none"
                    >
                        <option value="">全部分类</option>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <div className="flex-1" />
                    <span className="text-xs text-[var(--text-muted)]">{generatedCases.length} 条</span>
                    <button
                        type="button"
                        onClick={handleBatchApprove}
                        disabled={!generatedCases.some(c => !c.reviewed)}
                        className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-main)] hover:opacity-80 disabled:opacity-40 transition"
                    >
                        ☑️ 全部审核
                    </button>
                    <button
                        type="button"
                        onClick={() => fetchGeneratedCases({ category: genFilterCategory || null, reviewed: genFilterReviewed })}
                        className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-main)] hover:opacity-80 transition"
                    >
                        刷新
                    </button>
                </div>

                {/* 用例列表 */}
                {generatedCasesLoading ? (
                    <p className="py-8 text-center text-sm text-[var(--text-muted)]">加载中...</p>
                ) : generatedCases.length === 0 ? (
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-8 text-center">
                        <p className="text-sm text-[var(--text-muted)]">暂无生成用例</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">选择分类和数量后点击"生成"按钮</p>
                    </div>
                ) : (
                    <div className="max-h-[50vh] space-y-2 overflow-auto">
                        {generatedCases.map((tc) => (
                            <div
                                key={tc.id}
                                className={`rounded-xl border p-3 text-xs transition ${
                                    tc.reviewed
                                        ? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/10"
                                        : "border-[var(--panel-border)] bg-[var(--panel-soft)]"
                                }`}
                            >
                                {editingCaseId === tc.id ? (
                                    // ── 编辑模式 ──
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono text-[var(--text-muted)]">{tc.id}</span>
                                            <select
                                                value={editForm.difficulty}
                                                onChange={(e) => setEditForm({ ...editForm, difficulty: e.target.value })}
                                                className="rounded surface-card px-1.5 py-0.5 text-xs"
                                            >
                                                {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                                            </select>
                                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                                {tc.reviewed ? "🟢 已审核" : "🟡 待审核"}
                                            </span>
                                        </div>
                                        <textarea
                                            value={editForm.input}
                                            onChange={(e) => setEditForm({ ...editForm, input: e.target.value })}
                                            className="w-full rounded surface-card px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                                            rows={2}
                                            placeholder="用户输入..."
                                        />
                                        <textarea
                                            value={editForm.expectedBehavior}
                                            onChange={(e) => setEditForm({ ...editForm, expectedBehavior: e.target.value })}
                                            className="w-full rounded surface-card px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                                            rows={2}
                                            placeholder="期望行为..."
                                        />
                                        <div className="flex gap-2">
                                            <button onClick={() => saveEdit(tc.id)} className="rounded bg-[var(--brand)] px-3 py-1 text-white hover:opacity-90">保存</button>
                                            <button onClick={() => setEditingCaseId(null)} className="rounded border border-[var(--panel-border)] px-3 py-1 text-[var(--text-muted)] hover:text-[var(--text-main)]">取消</button>
                                        </div>
                                    </div>
                                ) : (
                                    // ── 展示模式 ──
                                    <>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="font-mono text-[var(--text-muted)]">{tc.id}</span>
                                                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                        tc.difficulty === "easy" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                                                        tc.difficulty === "hard" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                                                        "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                                    }`}>{tc.difficulty}</span>
                                                    <span className="text-[var(--text-muted)]">{tc.category}</span>
                                                    {tc.reviewed ? (
                                                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">🟢 已审核</span>
                                                    ) : (
                                                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">🟡 待审核</span>
                                                    )}
                                                </div>
                                                <p className="text-[var(--text-main)] font-medium truncate">{tc.input}</p>
                                                {tc.expected_behavior && (
                                                    <p className="mt-0.5 text-[var(--text-muted)] truncate">{tc.expected_behavior}</p>
                                                )}
                                                {Array.isArray(tc.expected_tools) && tc.expected_tools.length > 0 && (
                                                    <div className="mt-1 flex gap-1">
                                                        {tc.expected_tools.map(t => (
                                                            <span key={t} className="rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">{t}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* 运行结果 */}
                                                {runResult[tc.id] && (
                                                    <div className={`mt-2 rounded-lg px-2 py-1.5 text-[11px] ${
                                                        runResult[tc.id].passed
                                                            ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                                                            : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                                                    }`}>
                                                        {runResult[tc.id].scores ? (
                                                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                                                                <span>{runResult[tc.id].passed ? "✅" : "❌"}</span>
                                                                <span>正确性 {runResult[tc.id].scores.correctness}</span>
                                                                <span>工具选择 {runResult[tc.id].scores.tool_usage}</span>
                                                                <span>工具质量 {runResult[tc.id].scores.tool_quality}</span>
                                                                <span>简洁度 {runResult[tc.id].scores.conciseness}</span>
                                                                <span>安全性 {runResult[tc.id].scores.safety}</span>
                                                                <span className="text-[var(--text-muted)]">⏱ {runResult[tc.id].latencyMs}ms</span>
                                                            </div>
                                                        ) : (
                                                            <span>❌ {runResult[tc.id].error || "运行失败"}</span>
                                                        )}
                                                        {runResult[tc.id].textPreview && (
                                                            <p className="mt-0.5 truncate text-[var(--text-muted)]">输出: {runResult[tc.id].textPreview}</p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                            {/* 操作按钮 */}
                                            <div className="flex shrink-0 items-center gap-1">
                                                <button
                                                    onClick={() => handleRunCase(tc)}
                                                    disabled={runningCaseId === tc.id}
                                                    className="rounded p-1 text-[var(--brand)] hover:bg-indigo-100 dark:hover:bg-indigo-900/30 disabled:opacity-50"
                                                    title={runningCaseId === tc.id ? "运行中..." : "运行此用例"}
                                                >
                                                    {runningCaseId === tc.id ? (
                                                        <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                                        </svg>
                                                    ) : (
                                                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                                                            <path d="M8 5v14l11-7z" />
                                                        </svg>
                                                    )}
                                                </button>
                                                {!tc.reviewed && (
                                                    <button
                                                        onClick={() => handleReview(tc.id)}
                                                        className="rounded p-1 text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30"
                                                        title="审核通过"
                                                    >
                                                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                        </svg>
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => startEdit(tc)}
                                                    className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--panel-bg)]"
                                                    title="编辑"
                                                >
                                                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                                    </svg>
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(tc.id)}
                                                    className="rounded p-1 text-red-400 hover:text-red-600 hover:bg-red-100 dark:hover:bg-red-900/30"
                                                    title="删除"
                                                >
                                                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const content = (
            <div className={embedded ? 'tool-page-surface' : 'max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl surface-card p-6 shadow-2xl'}>
                {/* Header */}
                <div className="mb-6 space-y-3">
                    {/* Row 1: 标题 + 右侧按钮组 */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="shrink-0 text-lg font-bold text-[var(--text-main)] whitespace-nowrap">评估仪表盘</h2>
                        <div className="flex flex-wrap items-center gap-2">
                            {/* Run selector */}
                            {runs.length > 0 && (
                                <select
                                    value={selectedRunId}
                                    onChange={(e) => handleRunChange(e.target.value)}
                                    className="shrink-0 rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs text-[var(--text-main)] outline-none focus:border-[var(--brand)]"
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
                                    className="shrink-0 whitespace-nowrap text-xs text-[var(--brand)] hover:underline"
                                >
                                    清除筛选
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={async () => {
                                    try {
                                        const { fetchEvalRuns } = await import("../api/eval.js");
                                        const data = await fetchEvalRuns();
                                        if (data?.ok) setRuns(data.runs || []);
                                    } catch { /* 静默 */ }
                                    fetchEvalReport(selectedRunId || null);
                                    setShowRunner(false);
                                }}
                                className="shrink-0 whitespace-nowrap rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--text-main)] hover:opacity-80 transition"
                            >
                                刷新
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowRunner(!showRunner)}
                                className="shrink-0 whitespace-nowrap rounded-xl bg-[var(--brand-start)] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[var(--brand-mid)] transition"
                            >
                                {showRunner ? "隐藏运行器" : "运行评估"}
                            </button>
                            <button
                                type="button"
                                onClick={embedded ? onBack : toggleEvalDashboard}
                                className="shrink-0 rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                            >
                                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    {/* Row 2: G8 对比模式 Toggle */}
                    {runs.length > 1 && (
                        <div className="space-y-2">
                            {/* 对比开关 + 提示 */}
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const next = !isCompareMode;
                                        setIsCompareMode(next);
                                        setCompareRunIds([]);
                                        if (!next) useChatStore.setState({ comparisonData: null });
                                    }}
                                    className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                                        isCompareMode
                                            ? "bg-[var(--brand-start)] text-white"
                                            : "border border-[var(--panel-border)] bg-[var(--panel-soft)] text-[var(--text-main)]"
                                    }`}
                                >
                                    {isCompareMode ? "退出对比" : "🔍 对比"}
                                </button>
                                {isCompareMode && (
                                    <span className="shrink-0 whitespace-nowrap text-xs text-[var(--text-muted)]">
                                        选择 2-5 个 run：
                                    </span>
                                )}
                            </div>
                            {/* 对比激活时：run 标签 + 开始对比 */}
                            {isCompareMode && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex flex-wrap gap-1">
                                        {runs.map((r) => {
                                            const isSelected = compareRunIds.includes(r.run_id);
                                            return (
                                                <button
                                                    key={r.run_id}
                                                    type="button"
                                                    onClick={() => {
                                                        if (isSelected) {
                                                            setCompareRunIds(compareRunIds.filter(id => id !== r.run_id));
                                                        } else if (compareRunIds.length < 5) {
                                                            setCompareRunIds([...compareRunIds, r.run_id]);
                                                        }
                                                    }}
                                                    className={`shrink-0 whitespace-nowrap rounded-lg px-2 py-0.5 text-[10px] font-mono transition ${
                                                        isSelected
                                                            ? "bg-[var(--brand-start)] text-white"
                                                            : "border border-[var(--panel-border)] bg-[var(--panel-soft)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                                                    }`}
                                                >
                                                    {r.run_id.slice(0, 12)}...
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            if (compareRunIds.length < 2) return;
                                            setComparingLoading(true);
                                            await compareRunsAction(compareRunIds);
                                            setComparingLoading(false);
                                        }}
                                        disabled={compareRunIds.length < 2 || comparingLoading}
                                        className="shrink-0 whitespace-nowrap rounded-lg bg-[var(--brand-start)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--brand-mid)] disabled:opacity-50 transition"
                                    >
                                        {comparingLoading ? "对比中..." : "开始对比"}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {loading && evalMode !== "generator" && evalMode !== "optimizer" && (
                    <p className="py-8 text-center text-sm text-[var(--text-muted)]">加载中...</p>
                )}

                {/* Eval Runner */}
                {showRunner && evalMode !== "generator" && evalMode !== "optimizer" && (
                    <div className="mb-6">
                        <EvalRunner />
                    </div>
                )}

                {/* Phase 6b G8: 对比结果 */}
                {comparisonData && isCompareMode && evalMode !== "generator" && evalMode !== "optimizer" && (
                    <CompareResults data={comparisonData} />
                )}

                {/* Phase 6a: 评估模式切换 + G7 生成 + G10 优化 */}
                <div className="mb-4 flex gap-1 rounded-lg bg-[var(--panel-soft)] p-1">
                    {["offline", "online", "generator", "optimizer"].map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            onClick={() => setEvalMode(mode)}
                            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                                evalMode === mode
                                    ? "bg-[var(--panel-bg)] text-[var(--text-main)] shadow-sm"
                                    : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                            }`}
                        >
                            {mode === "offline" ? "📋 离线评估" : mode === "online" ? "🌐 在线采样" : mode === "generator" ? "🤖 生成用例" : "🔄 优化闭环"}
                        </button>
                    ))}
                </div>

                {/* ── G7: 生成用例面板 ── */}
                {evalMode === "generator" && (
                    <GeneratorPanel />
                )}

                {/* ── G10: 优化闭环面板 ── */}
                {evalMode === "optimizer" && (
                    <OptimizationPanel />
                )}

                {/* Stat cards */}
                {evalMode !== "generator" && evalMode !== "optimizer" && (
                <>
                <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="surface-subtle rounded-2xl p-4">
                        <p className="text-xs text-[var(--text-muted)]">总测试用例</p>
                        <p className="mt-1 text-2xl font-bold text-[var(--text-main)]">{evalReportData?.totalTestCases || 0}</p>
                    </div>
                    <div className="surface-subtle rounded-2xl p-4">
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

                {/* Phase 6a G3: 五维雷达图 */}
                {radarData && (
                    <div className="mb-6">
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                            综合能力雷达
                            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                                ({evalMode === "online" ? "在线采样" : "离线评估"} · {trendData[0]?.date || "最新"})
                            </span>
                        </h3>
                        <div className="surface-subtle rounded-2xl p-4">
                            {renderRadarChart()}
                        </div>
                    </div>
                )}

                {/* Trend chart */}
                <div className="mb-6">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">评分趋势</h3>
                    <div className="surface-subtle rounded-2xl p-4">
                        {/* Legend */}
                        <div className="mb-3 flex gap-4 text-xs text-[var(--text-muted)]">
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500" />正确性</span>
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500" />工具选择</span>
                            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" />工具质量</span>
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
                </>
                )}{/* end evalMode !== "generator" && evalMode !== "optimizer" */}
                {embedded && (
                    <button type="button" onClick={onBack} className="tool-page-back-link">
                        ← 返回聊天工作区
                    </button>
                )}
            </div>
    );

    if (embedded) {
        return content;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
            onClick={(e) => { if (e.target === e.currentTarget) toggleEvalDashboard(); }}
        >
            {content}
        </div>
    );
}
