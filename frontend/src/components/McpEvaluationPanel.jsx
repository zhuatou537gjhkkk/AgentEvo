import { useEffect, useMemo, useState } from "react";
import { compareMcpEvalRuns, fetchMcpEvalCases, fetchMcpEvalRuns, runMcpEval } from "../api/eval.js";

function rateText(rate) {
    if (!rate || rate.value == null) return "无样本";
    return `${(rate.value * 100).toFixed(1)}% (${rate.numerator}/${rate.denominator})`;
}

export default function McpEvaluationPanel({ visible = true }) {
    const [cases, setCases] = useState([]);
    const [runs, setRuns] = useState([]);
    const [selected, setSelected] = useState([]);
    const [variant, setVariant] = useState("candidate");
    const [report, setReport] = useState(null);
    const [comparison, setComparison] = useState(null);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState("");

    const selectableCases = useMemo(() => cases.filter((item) => !item.requiresModel), [cases]);

    useEffect(() => {
        if (!visible) return;
        (async () => {
            try {
                const [caseData, runData] = await Promise.all([fetchMcpEvalCases(), fetchMcpEvalRuns()]);
                setCases(caseData?.cases || []);
                setRuns(runData?.runs || []);
            } catch (error) {
                setMessage(error.message || "MCP 评测不可用");
            }
        })();
    }, [visible]);

    const run = async (nextVariant = variant) => {
        setLoading(true);
        setMessage("");
        setComparison(null);
        try {
            const data = await runMcpEval({ caseIds: selected.length ? selected : null, variant: nextVariant });
            if (data?.ok) {
                setReport(data);
                const history = await fetchMcpEvalRuns();
                setRuns(history?.runs || []);
            } else setMessage(data?.message || "MCP 评测失败");
        } catch (error) {
            setMessage(error.message || "MCP 评测失败");
        } finally {
            setLoading(false);
        }
    };

    const compare = async () => {
        const baseline = runs.find((item) => item.variant === "baseline");
        const candidate = runs.find((item) => item.variant === "candidate");
        if (!baseline || !candidate) {
            setMessage("需要同一数据集的 baseline 与 candidate Run 才能比较");
            return;
        }
        setLoading(true);
        try { setComparison(await compareMcpEvalRuns(baseline.run_id, candidate.run_id)); }
        catch (error) { setMessage(error.message || "比较失败"); }
        finally { setLoading(false); }
    };

    return (
        <div className="space-y-4">
            <div className="surface-subtle rounded-2xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 className="text-sm font-semibold text-[var(--text-main)]">🧪 MCP 专项评测</h3>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">受控本地 fixture；真实模型用例没有配置时保持 not_run。</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <select value={variant} onChange={(event) => setVariant(event.target.value)} className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2 py-1 text-xs text-[var(--text-main)]">
                            <option value="candidate">candidate</option>
                            <option value="baseline">baseline（旧语义模拟）</option>
                        </select>
                        <button type="button" disabled={loading} onClick={() => run()} className="rounded-lg bg-[var(--brand-start)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{loading ? "运行中..." : "运行 fixture"}</button>
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {selectableCases.map((item) => {
                        const checked = selected.includes(item.id);
                        return <button key={item.id} type="button" onClick={() => setSelected(checked ? selected.filter((id) => id !== item.id) : [...selected, item.id])} className={`rounded-md px-2 py-1 text-[10px] ${checked ? "bg-[var(--brand-start)] text-white" : "border border-[var(--panel-border)] text-[var(--text-muted)]"}`}>{item.id}</button>;
                    })}
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                    <span>未选 = 全部受控用例</span>
                    <button type="button" onClick={compare} disabled={loading} className="text-[var(--brand)] hover:underline">比较最近 baseline/candidate</button>
                </div>
                {message && <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">{message}</p>}
            </div>

            {report?.summary && (
                <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        {report.summary.layers.map((layer) => <div key={layer.layer} className="surface-subtle rounded-xl p-3"><p className="text-[10px] text-[var(--text-muted)]">{layer.layer}</p><p className="mt-1 text-lg font-semibold text-[var(--text-main)]">{rateText(layer.passRate)}</p><p className="text-[10px] text-[var(--text-muted)]">not_run {layer.notRun} · fail {layer.failed}</p></div>)}
                    </div>
                    <div className="overflow-auto rounded-xl border border-[var(--panel-border)]">
                        <table className="w-full text-xs"><thead><tr className="border-b border-[var(--panel-border)] text-left text-[var(--text-muted)]"><th className="px-3 py-2">Case</th><th className="px-3 py-2">层</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">根因/证据</th></tr></thead><tbody>{report.cases.map((item) => <tr key={item.case_id} className="border-b border-[var(--panel-border)]"><td className="px-3 py-2 font-mono">{item.case_id}</td><td className="px-3 py-2">{item.layer}</td><td className={`px-3 py-2 font-semibold ${item.status === "pass" ? "text-emerald-600" : item.status === "not_run" ? "text-amber-600" : "text-red-600"}`}>{item.status}</td><td className="max-w-xs px-3 py-2 text-[var(--text-muted)]">{item.failureClass || item.evidence?.reason || item.evidence?.actualStatus || "-"}</td></tr>)}</tbody></table>
                    </div>
                </div>
            )}

            {comparison && <div className="surface-subtle rounded-xl p-3 text-xs"><p className="font-semibold text-[var(--text-main)]">两次 Run 对比：{comparison.comparable ? "可比" : `不可比（${comparison.reason}）`}</p>{comparison.comparable && comparison.perCase.map((item) => <div key={item.caseId} className="mt-1 flex gap-2 text-[var(--text-muted)]"><span className="font-mono">{item.caseId}</span><span>{item.baseline?.status} → {item.candidate?.status}</span></div>)}</div>}
        </div>
    );
}

export { rateText };
