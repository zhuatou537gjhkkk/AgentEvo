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
            <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
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
                                regressedDims.includes(dim) ? "bg-red-50 dark:bg-red-950/20" : ""
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

export default function EvalDashboard() {
    const isOpen = useChatStore((s) => s.isEvalDashboardOpen);
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

    // 获取已有用例作为可选种子
    const availableCases = useChatStore((s) => {
        // 从 evalReportData 的 categories 获取分类信息
        return [];
    });

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

    // G7: 切换到生成 tab 时加载生成用例列表
    useEffect(() => {
        if (!isOpen || evalMode !== "generator") return;
        fetchGeneratedCases({
            category: genFilterCategory || null,
            reviewed: genFilterReviewed,
        });
    }, [isOpen, evalMode, genFilterCategory, genFilterReviewed]);

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
                <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">生成配置</h3>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {/* 分类 */}
                        <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">目标分类</label>
                            <select
                                value={genCategory}
                                onChange={(e) => setGenCategory(e.target.value)}
                                className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-xs text-[var(--text-main)] outline-none"
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
                                                className="w-14 rounded border border-[var(--panel-border)] bg-[var(--panel-bg)] px-1.5 py-0.5 text-xs text-[var(--text-main)] outline-none"
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
                                                className="rounded border border-[var(--panel-border)] bg-[var(--panel-bg)] px-1.5 py-0.5 text-xs"
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
                                            className="w-full rounded border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                                            rows={2}
                                            placeholder="用户输入..."
                                        />
                                        <textarea
                                            value={editForm.expectedBehavior}
                                            onChange={(e) => setEditForm({ ...editForm, expectedBehavior: e.target.value })}
                                            className="w-full rounded border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
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

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
            onClick={(e) => { if (e.target === e.currentTarget) toggleEvalDashboard(); }}
        >
            <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-2xl">
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
                                className="shrink-0 whitespace-nowrap rounded-xl bg-[#111827] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#0b1220] transition"
                            >
                                {showRunner ? "隐藏运行器" : "运行评估"}
                            </button>
                            <button
                                type="button"
                                onClick={toggleEvalDashboard}
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
                                            ? "bg-[var(--brand)] text-white"
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
                                                            ? "bg-[var(--brand)] text-white"
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
                                        className="shrink-0 whitespace-nowrap rounded-lg bg-[#111827] px-3 py-1 text-xs font-semibold text-white hover:bg-[#0b1220] disabled:opacity-50 transition"
                                    >
                                        {comparingLoading ? "对比中..." : "开始对比"}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {loading && evalMode !== "generator" && (
                    <p className="py-8 text-center text-sm text-[var(--text-muted)]">加载中...</p>
                )}

                {/* Eval Runner */}
                {showRunner && evalMode !== "generator" && (
                    <div className="mb-6">
                        <EvalRunner />
                    </div>
                )}

                {/* Phase 6b G8: 对比结果 */}
                {comparisonData && isCompareMode && evalMode !== "generator" && (
                    <CompareResults data={comparisonData} />
                )}

                {/* Phase 6a: 评估模式切换 + G7 生成 */}
                <div className="mb-4 flex gap-1 rounded-lg bg-[var(--panel-soft)] p-1">
                    {["offline", "online", "generator"].map((mode) => (
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
                            {mode === "offline" ? "📋 离线评估" : mode === "online" ? "🌐 在线采样" : "🤖 生成用例"}
                        </button>
                    ))}
                </div>

                {/* ── G7: 生成用例面板 ── */}
                {evalMode === "generator" && (
                    <GeneratorPanel />
                )}

                {/* Stat cards */}
                {evalMode !== "generator" && (
                <>
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

                {/* Phase 6a G3: 五维雷达图 */}
                {radarData && (
                    <div className="mb-6">
                        <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">
                            综合能力雷达
                            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                                ({evalMode === "online" ? "在线采样" : "离线评估"} · {trendData[0]?.date || "最新"})
                            </span>
                        </h3>
                        <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
                            {renderRadarChart()}
                        </div>
                    </div>
                )}

                {/* Trend chart */}
                <div className="mb-6">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--text-main)]">评分趋势</h3>
                    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-4">
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
                )}{/* end evalMode !== "generator" */}
            </div>
        </div>
    );
}
