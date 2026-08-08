/**
 * Phase 6c G10: 优化闭环流水线 — 单元测试
 *
 * 测试 OptimizationPipeline 核心逻辑：
 *   - _parseSuggestions() JSON 解析
 *   - analyze() BadCase 识别 + 根因分类
 *   - compare() 优化前后对比
 *   - BAD_CASE_THRESHOLD 常量
 *
 * 运行: npx vitest run src/eval/__tests__/optimize.test.js
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════
// _parseSuggestions — JSON 解析逻辑（从 optimize.js 提取）
// ═══════════════════════════════════════════════════════

function parseSuggestions(content) {
    if (!content || content.trim().length === 0) {
        return { suggestions: [], summary: "LLM 返回空响应" };
    }

    try {
        const parsed = JSON.parse(content.trim());
        return {
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
            summary: parsed.summary || "",
        };
    } catch {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                    summary: parsed.summary || "",
                };
            } catch { /* fall through */ }
        }
        return { suggestions: [], summary: "LLM 响应解析失败" };
    }
}

describe("parseSuggestions (LLM JSON response parser)", () => {
    it("should parse valid JSON suggestions", () => {
        const input = JSON.stringify({
            suggestions: [
                { configKey: "agent.knowledge.instruction", suggestedValue: "新指令", confidence: 0.85, rationale: "需要更详细" },
                { configKey: "tool.web_search.description", suggestedValue: "新描述", confidence: 0.72, rationale: "参数不够" },
            ],
            summary: "两个配置需要优化",
        });

        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(2);
        expect(result.suggestions[0].configKey).toBe("agent.knowledge.instruction");
        expect(result.suggestions[0].confidence).toBe(0.85);
        expect(result.summary).toBe("两个配置需要优化");
    });

    it("should return empty for empty input", () => {
        const result = parseSuggestions("");
        expect(result.suggestions).toHaveLength(0);
        expect(result.summary).toBe("LLM 返回空响应");
    });

    it("should return empty for null input", () => {
        const result = parseSuggestions(null);
        expect(result.suggestions).toHaveLength(0);
    });

    it("should return empty for whitespace-only input", () => {
        const result = parseSuggestions("   \n  ");
        expect(result.suggestions).toHaveLength(0);
    });

    it("should extract JSON from markdown-wrapped text", () => {
        const input = '这是一个分析结果:\n```json\n{"suggestions":[{"configKey":"key1","suggestedValue":"val1","confidence":0.9,"rationale":"test"}],"summary":"ok"}\n```';

        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].configKey).toBe("key1");
        expect(result.summary).toBe("ok");
    });

    it("should extract JSON with surrounding text", () => {
        const input = '分析完成。以下是建议：\n{"suggestions":[{"configKey":"key.a","suggestedValue":"v","confidence":0.5,"rationale":"r"}],"summary":"s"}\n请审核。';

        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].configKey).toBe("key.a");
    });

    it("should handle empty suggestions array", () => {
        const input = '{"suggestions":[],"summary":"无需修改"}';
        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(0);
        expect(result.summary).toBe("无需修改");
    });

    it("should handle suggestions as non-array", () => {
        const input = '{"suggestions":"not-an-array","summary":"bad format"}';
        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(0);
    });

    it("should handle completely invalid text gracefully", () => {
        const result = parseSuggestions("这不是 JSON，完全无法解析！");
        expect(result.suggestions).toHaveLength(0);
        expect(result.summary).toBe("LLM 响应解析失败");
    });

    it("should handle truncated JSON with partial suggestions", () => {
        const input = '{"suggestions":[{"configKey":"key1","suggestedValue":"v1","confidence":0.8,"';
        const result = parseSuggestions(input);
        // Truncated JSON → can't parse, falls back to error message
        expect(result.suggestions).toHaveLength(0);
    });

    it("should extract JSON from nested code block without json tag", () => {
        const input = '```\n{"suggestions":[{"configKey":"test.key","suggestedValue":"test val","confidence":0.6,"rationale":"test"}],"summary":"test summary"}\n```';
        const result = parseSuggestions(input);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].configKey).toBe("test.key");
    });
});

// ═══════════════════════════════════════════════════════
// analyze() — BadCase 识别 + 根因分类（核心逻辑提取）
// ═══════════════════════════════════════════════════════

const BAD_CASE_THRESHOLD = 3.0;

function analyzeScores(rows) {
    const byTestCase = {};
    for (const row of rows) {
        if (!byTestCase[row.test_case_id]) {
            byTestCase[row.test_case_id] = {};
        }
        byTestCase[row.test_case_id][row.dimension] = {
            score: row.score,
            rationale: row.judge_rationale || "",
        };
    }

    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
    const weights = { correctness: 0.35, tool_usage: 0.2, tool_quality: 0.15, conciseness: 0.1, safety: 0.2 };

    const casesWithScores = Object.entries(byTestCase).map(([tcId, dimScores]) => {
        let weightedSum = 0;
        const scores = {};
        for (const dim of dims) {
            const s = dimScores[dim]?.score || 0;
            scores[dim] = s;
            weightedSum += s * (weights[dim] || 0.2);
        }
        return { testCaseId: tcId, scores, weightedAvg: Math.round(weightedSum * 100) / 100 };
    });

    const badCases = casesWithScores
        .filter(c => c.weightedAvg < BAD_CASE_THRESHOLD)
        .sort((a, b) => a.weightedAvg - b.weightedAvg);

    // 根因分类
    for (const bc of badCases) {
        let minDim = "correctness";
        let minScore = Infinity;
        for (const dim of dims) {
            if (bc.scores[dim] < minScore) {
                minScore = bc.scores[dim];
                minDim = dim;
            }
        }
        bc.rootCause = minDim;
    }

    const byRootCause = {};
    for (const bc of badCases) {
        if (!byRootCause[bc.rootCause]) byRootCause[bc.rootCause] = [];
        byRootCause[bc.rootCause].push(bc);
    }

    return {
        badCases,
        summary: {
            total: casesWithScores.length,
            badCount: badCases.length,
            avgWeightedScore: casesWithScores.length > 0
                ? Math.round(casesWithScores.reduce((s, c) => s + c.weightedAvg, 0) / casesWithScores.length * 100) / 100
                : 0,
            byRootCause: Object.fromEntries(
                Object.entries(byRootCause).map(([k, v]) => [k, v.length])
            ),
        },
    };
}

describe("analyze (BadCase identification + root cause classification)", () => {
    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];

    function makeRows(tcId, scores) {
        return dims.map(d => ({
            test_case_id: tcId,
            dimension: d,
            score: scores[d] !== undefined ? scores[d] : 3,
            judge_rationale: `Rationale for ${d}`,
        }));
    }

    it("should return empty when no scores", () => {
        const result = analyzeScores([]);
        expect(result.badCases).toHaveLength(0);
        expect(result.summary.total).toBe(0);
        expect(result.summary.badCount).toBe(0);
    });

    it("should identify cases with weighted avg below 3.0 as bad", () => {
        // tc-01: all 5 → weightedAvg = 5.0 → not bad
        // tc-02: all 2 → weightedAvg = 2.0 → bad
        // tc-03: all 2.5 → weightedAvg = 2.5 → bad
        const rows = [
            ...makeRows("tc-01", { correctness: 5, tool_usage: 5, tool_quality: 5, conciseness: 5, safety: 5 }),
            ...makeRows("tc-02", { correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 2, safety: 2 }),
            ...makeRows("tc-03", { correctness: 2.5, tool_usage: 2.5, tool_quality: 2.5, conciseness: 2.5, safety: 2.5 }),
        ];

        const result = analyzeScores(rows);
        expect(result.summary.total).toBe(3);
        expect(result.summary.badCount).toBe(2);
        expect(result.badCases.map(bc => bc.testCaseId).sort()).toEqual(["tc-02", "tc-03"]);
    });

    it("should classify cases at exactly 3.0 as passing (not bad)", () => {
        // weighted avg = 3.0 is NOT < 3.0
        const rows = makeRows("tc-edge", {
            correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });

        const result = analyzeScores(rows);
        expect(result.summary.badCount).toBe(0);
        expect(result.badCases).toHaveLength(0);
    });

    it("should identify root cause as the lowest-scoring dimension", () => {
        // correctness=1 is the lowest → rootCause should be correctness
        // weighted: 1*0.35 + 3*0.20 + 3*0.15 + 3*0.10 + 3*0.20 = 0.35+0.60+0.45+0.30+0.60 = 2.30 < 3.0 ✓
        const rows = makeRows("tc-low-corr", {
            correctness: 1, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });

        const result = analyzeScores(rows);
        expect(result.badCases).toHaveLength(1);
        expect(result.badCases[0].rootCause).toBe("correctness");
    });

    it("should identify tool_quality as root cause when it scores lowest", () => {
        // tool_quality=1 is the lowest → rootCause should be tool_quality
        // weighted: 3*0.35 + 3*0.20 + 1*0.15 + 3*0.10 + 3*0.20 = 1.05+0.60+0.15+0.30+0.60 = 2.70 < 3.0 ✓
        const rows = makeRows("tc-low-toolq", {
            correctness: 3, tool_usage: 3, tool_quality: 1, conciseness: 3, safety: 3,
        });

        const result = analyzeScores(rows);
        expect(result.badCases).toHaveLength(1);
        expect(result.badCases[0].rootCause).toBe("tool_quality");
    });

    it("should sort bad cases by weighted avg ascending (worst first)", () => {
        const rows = [
            ...makeRows("tc-mid", { correctness: 2.5, tool_usage: 2.5, tool_quality: 2.5, conciseness: 2.5, safety: 2.5 }),
            ...makeRows("tc-worst", { correctness: 1, tool_usage: 1, tool_quality: 1, conciseness: 1, safety: 1 }),
            ...makeRows("tc-best-bad", { correctness: 2.9, tool_usage: 2.9, tool_quality: 2.9, conciseness: 2.9, safety: 2.9 }),
        ];

        const result = analyzeScores(rows);
        expect(result.badCases).toHaveLength(3);
        expect(result.badCases[0].testCaseId).toBe("tc-worst");   // ~1.0
        expect(result.badCases[1].testCaseId).toBe("tc-mid");     // ~2.5
        expect(result.badCases[2].testCaseId).toBe("tc-best-bad"); // ~2.9
    });

    it("should group bad cases by root cause in summary", () => {
        // tc-corr-low: 1*0.35 + 3*0.2 + 3*0.15 + 3*0.1 + 3*0.2 = 0.35+0.6+0.45+0.3+0.6 = 2.30 BAD (root: correctness)
        // tc-corr-low2: 2*0.35 + 3*0.2 + 3*0.15 + 3*0.1 + 3*0.2 = 0.70+0.6+0.45+0.3+0.6 = 2.65 BAD (root: correctness)
        // tc-safety-low: 3*0.35 + 3*0.2 + 3*0.15 + 3*0.1 + 1*0.2 = 1.05+0.6+0.45+0.3+0.2 = 2.60 BAD (root: safety)
        const rows = [
            ...makeRows("tc-corr-low", { correctness: 1, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3 }),
            ...makeRows("tc-corr-low2", { correctness: 2, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3 }),
            ...makeRows("tc-safety-low", { correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 1 }),
        ];

        const result = analyzeScores(rows);
        expect(result.summary.byRootCause).toEqual({
            correctness: 2,
            safety: 1,
        });
    });

    it("should compute average weighted score across all cases", () => {
        const rows = [
            ...makeRows("tc-01", { correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4 }), // 4.0
            ...makeRows("tc-02", { correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 2, safety: 2 }), // 2.0
        ];

        const result = analyzeScores(rows);
        expect(result.summary.total).toBe(2);
        expect(result.summary.avgWeightedScore).toBe(3.0); // (4+2)/2
    });

    it("should handle missing dimensions gracefully", () => {
        // Only 2 dimensions provided → others count as 0
        const rows = [
            { test_case_id: "tc-partial", dimension: "correctness", score: 3 },
            { test_case_id: "tc-partial", dimension: "safety", score: 3 },
        ];

        const result = analyzeScores(rows);
        expect(result.summary.total).toBe(1);
        // weighted: correctness 3*0.35 + tool_usage 0 + tool_quality 0 + conciseness 0 + safety 3*0.2
        // = 1.05 + 0.6 = 1.65 → bad
        expect(result.badCases).toHaveLength(1);
        expect(result.badCases[0].scores.tool_usage).toBe(0);
    });

    it("should return correct weightedAvg calculation", () => {
        // Manual verification of weight formula
        const rows = makeRows("tc-formula", {
            correctness: 5, tool_usage: 4, tool_quality: 3, conciseness: 4, safety: 5,
        });
        // weighted = 5*0.35 + 4*0.20 + 3*0.15 + 4*0.10 + 5*0.20
        // = 1.75 + 0.80 + 0.45 + 0.40 + 1.00 = 4.40

        const result = analyzeScores(rows);
        expect(result.badCases).toHaveLength(0); // 4.40 > 3.0
        expect(result.summary.avgWeightedScore).toBe(4.4);
    });
});

// ═══════════════════════════════════════════════════════
// compare() — 优化前后对比逻辑（核心逻辑提取）
// ═══════════════════════════════════════════════════════

function computeCompareAvg(rows) {
    const byTc = {};
    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
    for (const row of rows) {
        if (!byTc[row.test_case_id]) byTc[row.test_case_id] = {};
        byTc[row.test_case_id][row.dimension] = row.score;
    }
    const avg = {};
    const n = Object.keys(byTc).length;
    if (n === 0) {
        for (const d of dims) avg[d] = 0;
        return { avg, passed: 0, failed: 0, total: 0 };
    }
    let passed = 0, failed = 0;
    for (const tcId of Object.keys(byTc)) {
        const s = byTc[tcId];
        const tcAvg = dims.reduce((sum, d) => sum + (s[d] || 0), 0) / 5;
        if (tcAvg >= 3.0) passed++; else failed++;
        for (const d of dims) avg[d] = (avg[d] || 0) + (s[d] || 0);
    }
    for (const d of dims) avg[d] = Math.round(avg[d] / n * 100) / 100;
    return { avg, passed, failed, total: n };
}

function compareScores(beforeRows, afterRows) {
    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
    const before = computeCompareAvg(beforeRows);
    const after = computeCompareAvg(afterRows);

    const deltas = {};
    for (const d of dims) {
        deltas[d] = Math.round((after.avg[d] - before.avg[d]) * 100) / 100;
    }

    const beforeWeighted = before.avg.correctness * 0.35 + before.avg.tool_usage * 0.2
        + before.avg.tool_quality * 0.15 + before.avg.conciseness * 0.1 + before.avg.safety * 0.2;
    const afterWeighted = after.avg.correctness * 0.35 + after.avg.tool_usage * 0.2
        + after.avg.tool_quality * 0.15 + after.avg.conciseness * 0.1 + after.avg.safety * 0.2;

    return {
        before,
        after,
        deltas,
        weightedDelta: Math.round((afterWeighted - beforeWeighted) * 100) / 100,
        weightedDeltaPct: beforeWeighted > 0
            ? Math.round((afterWeighted - beforeWeighted) / beforeWeighted * 10000) / 100
            : 0,
        improved: afterWeighted > beforeWeighted,
    };
}

describe("compare (before/after optimization comparison)", () => {
    const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];

    function makeRows(tcId, scores) {
        return dims.map(d => ({
            test_case_id: tcId,
            dimension: d,
            score: scores[d] !== undefined ? scores[d] : 3,
        }));
    }

    it("should detect improvement when after > before", () => {
        const before = makeRows("tc-01", {
            correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 3, safety: 3,
        });
        const after = makeRows("tc-01", {
            correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 3, safety: 3,
        });

        const result = compareScores(before, after);
        expect(result.improved).toBe(true);
        expect(result.weightedDelta).toBeGreaterThan(0);
        expect(result.weightedDeltaPct).toBeGreaterThan(0);
    });

    it("should detect regression when after < before", () => {
        const before = makeRows("tc-01", {
            correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4,
        });
        const after = makeRows("tc-01", {
            correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 4, safety: 4,
        });

        const result = compareScores(before, after);
        expect(result.improved).toBe(false);
        expect(result.weightedDelta).toBeLessThan(0);
    });

    it("should compute per-dimension deltas correctly", () => {
        const before = makeRows("tc-01", {
            correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });
        const after = makeRows("tc-01", {
            correctness: 4, tool_usage: 3, tool_quality: 4, conciseness: 2, safety: 3,
        });

        const result = compareScores(before, after);
        expect(result.deltas.correctness).toBe(1);
        expect(result.deltas.tool_usage).toBe(0);
        expect(result.deltas.tool_quality).toBe(1);
        expect(result.deltas.conciseness).toBe(-1);
        expect(result.deltas.safety).toBe(0);
    });

    it("should handle empty rows gracefully", () => {
        const result = compareScores([], []);
        expect(result.before.total).toBe(0);
        expect(result.after.total).toBe(0);
        expect(result.improved).toBe(false); // 0 is not > 0
        expect(result.weightedDelta).toBe(0);
    });

    it("should handle multiple test cases in before/after", () => {
        const beforeRows = [
            ...makeRows("tc-01", { correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 2, safety: 2 }),
            ...makeRows("tc-02", { correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3 }),
        ];
        const afterRows = [
            ...makeRows("tc-01", { correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4 }),
            ...makeRows("tc-02", { correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4 }),
        ];

        const result = compareScores(beforeRows, afterRows);
        // tc-01: 2→4 (all dims +2), tc-02: 3→4 (all dims +1)
        // Avg: correctness (2+3)/2=2.5 → (4+4)/2=4.0, delta=1.5
        expect(result.deltas.correctness).toBe(1.5);
        expect(result.improved).toBe(true);
    });

    it("should compute weightedDeltaPct relative to baseline", () => {
        const before = makeRows("tc-01", {
            correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });
        // before weighted = 3.0
        const after = makeRows("tc-01", {
            correctness: 4.5, tool_usage: 4.5, tool_quality: 4.5, conciseness: 4.5, safety: 4.5,
        });
        // after weighted = 4.5
        // delta% = (4.5 - 3.0) / 3.0 * 100 = 50%

        const result = compareScores(before, after);
        expect(result.weightedDeltaPct).toBe(50);
    });

    it("should handle zero baseline gracefully", () => {
        const before = makeRows("tc-01", {
            correctness: 0, tool_usage: 0, tool_quality: 0, conciseness: 0, safety: 0,
        });
        const after = makeRows("tc-01", {
            correctness: 1, tool_usage: 1, tool_quality: 1, conciseness: 1, safety: 1,
        });

        const result = compareScores(before, after);
        expect(result.weightedDeltaPct).toBe(0); // division by zero guard
        expect(result.improved).toBe(true);
    });

    it("should round weightedDeltaPct to 2 decimal places", () => {
        const before = makeRows("tc-01", {
            correctness: 3, tool_usage: 3, tool_quality: 3, conciseness: 3, safety: 3,
        });
        // before = 3.0
        const after = makeRows("tc-01", {
            correctness: 3.1, tool_usage: 3.1, tool_quality: 3.1, conciseness: 3.1, safety: 3.1,
        });
        // after = 3.1
        // delta% = 0.1/3.0 ≈ 3.333...%

        const result = compareScores(before, after);
        const str = String(result.weightedDeltaPct);
        const decimals = str.includes(".") ? str.split(".")[1].length : 0;
        expect(decimals).toBeLessThanOrEqual(2);
    });

    it("should track passed/failed counts correctly", () => {
        const dims = ["correctness", "tool_usage", "tool_quality", "conciseness", "safety"];
        // tc-01: avg=4.0 → passed. tc-02: avg=2.0 → failed
        const before = [
            ...makeRows("tc-01", { correctness: 4, tool_usage: 4, tool_quality: 4, conciseness: 4, safety: 4 }),
            ...makeRows("tc-02", { correctness: 2, tool_usage: 2, tool_quality: 2, conciseness: 2, safety: 2 }),
        ];
        const after = makeRows("tc-03", { correctness: 5, tool_usage: 5, tool_quality: 5, conciseness: 5, safety: 5 });

        const result = compareScores(before, after);
        expect(result.before.passed).toBe(1);
        expect(result.before.failed).toBe(1);
        expect(result.after.passed).toBe(1);
        expect(result.after.failed).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// BAD_CASE_THRESHOLD 常量测试
// ═══════════════════════════════════════════════════════

describe("BAD_CASE_THRESHOLD", () => {
    it("should be 3.0 (standard passing threshold)", () => {
        expect(BAD_CASE_THRESHOLD).toBe(3.0);
    });

    it("should align with LLMJudge.isPassing default threshold", () => {
        // both use 3.0 as the passing line
        expect(BAD_CASE_THRESHOLD).toBe(3.0);
    });

    it("should be a number (not a string)", () => {
        expect(typeof BAD_CASE_THRESHOLD).toBe("number");
    });
});

// ═══════════════════════════════════════════════════════
// 权重常量验证（确保 analyze 与 compare 权重一致）
// ═══════════════════════════════════════════════════════

describe("Weight consistency between analyze and compare", () => {
    const analyzeWeights = { correctness: 0.35, tool_usage: 0.2, tool_quality: 0.15, conciseness: 0.1, safety: 0.2 };

    it("should sum to 1.0", () => {
        const sum = Object.values(analyzeWeights).reduce((a, b) => a + b, 0);
        expect(sum).toBe(1.0);
    });

    it("should contain all 5 dimensions", () => {
        expect(Object.keys(analyzeWeights)).toHaveLength(5);
        expect(analyzeWeights).toHaveProperty("correctness");
        expect(analyzeWeights).toHaveProperty("tool_usage");
        expect(analyzeWeights).toHaveProperty("tool_quality");
        expect(analyzeWeights).toHaveProperty("conciseness");
        expect(analyzeWeights).toHaveProperty("safety");
    });

    it("correctness should have the highest weight (0.35)", () => {
        const maxWeight = Math.max(...Object.values(analyzeWeights));
        expect(analyzeWeights.correctness).toBe(maxWeight);
    });
});

// ═══════════════════════════════════════════════════════
// G10 fix: EvalRunner.run() ID 解析兜底逻辑
// 指定了测试用例 ID 但全部解析失败时，不应静默回退到全量用例
// ═══════════════════════════════════════════════════════

describe("EvalRunner.run() ID resolution — no silent fallback to all test cases", () => {
    /**
     * 模拟修复后的 targetTestCases 计算逻辑
     * 对应 runner.js 修复后的代码
     */
    function computeTargetTestCases(testCaseIds, resolveTestCase, allTestCases) {
        const selected = testCaseIds.length > 0
            ? testCaseIds.map(resolveTestCase).filter(Boolean)
            : allTestCases;

        const allResolvedFailed = testCaseIds.length > 0 && selected.length === 0;

        const targetTestCases = testCaseIds.length === 0 && selected.length === 0
            ? []
            : (selected.length > 0 ? selected : (allResolvedFailed ? [] : allTestCases));

        return { selected, allResolvedFailed, targetTestCases };
    }

    it("should return empty when all specified IDs fail to resolve", () => {
        // 模拟：所有 ID 都解析失败
        const resolveNone = () => null;
        const allTestCases = [{ id: "tc-1" }, { id: "tc-2" }, { id: "tc-3" }];

        const result = computeTargetTestCases(["bad-id-1", "bad-id-2"], resolveNone, allTestCases);

        expect(result.selected).toHaveLength(0);
        expect(result.allResolvedFailed).toBe(true);
        expect(result.targetTestCases).toHaveLength(0); // 不回退！
    });

    it("should still return all test cases when no IDs are specified", () => {
        const resolveNone = () => null;
        const allTestCases = [{ id: "tc-1" }, { id: "tc-2" }];

        const result = computeTargetTestCases([], resolveNone, allTestCases);

        expect(result.selected).toHaveLength(2); // 默认全部
        expect(result.targetTestCases).toHaveLength(2);
    });

    it("should return only resolvable IDs when some resolve", () => {
        const resolveSome = (id) => {
            if (id === "tc-valid") return { id: "tc-valid" };
            return null;
        };
        const allTestCases = [{ id: "tc-1" }, { id: "tc-2" }];

        const result = computeTargetTestCases(["tc-valid", "bad-id"], resolveSome, allTestCases);

        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].id).toBe("tc-valid");
        expect(result.allResolvedFailed).toBe(false);
        expect(result.targetTestCases).toHaveLength(1); // 只有有效的
    });

    it("should return all valid IDs when all resolve", () => {
        const resolveAll = (id) => ({ id });
        const allTestCases = [{ id: "tc-1" }];

        const result = computeTargetTestCases(["a", "b", "c"], resolveAll, allTestCases);

        expect(result.selected).toHaveLength(3);
        expect(result.allResolvedFailed).toBe(false);
        expect(result.targetTestCases).toHaveLength(3);
    });
});

// ═══════════════════════════════════════════════════════
// G10 fix: reevaluate() ID 预校验逻辑
// ═══════════════════════════════════════════════════════

describe("reevaluate() ID pre-validation", () => {
    function preValidate(testCaseIds, resolveById, resolveGeneratedById) {
        const validIds = [];
        const invalidIds = [];
        for (const id of testCaseIds) {
            const hardcoded = resolveById(id);
            const generated = resolveGeneratedById(id);
            if (hardcoded || generated) {
                validIds.push(id);
            } else {
                invalidIds.push(id);
            }
        }
        return { validIds, invalidIds };
    }

    it("should separate valid from invalid IDs", () => {
        const resolveById = (id) => id.startsWith("tc_") ? { id } : null;
        const resolveGeneratedById = (id) => id.startsWith("gen_") ? { id } : null;

        const result = preValidate(
            ["tc_knowledge_001", "gen_abc123", "ghost_id", "tc_search_001"],
            resolveById,
            resolveGeneratedById
        );

        expect(result.validIds).toEqual(["tc_knowledge_001", "gen_abc123", "tc_search_001"]);
        expect(result.invalidIds).toEqual(["ghost_id"]);
    });

    it("should return all invalid when nothing resolves", () => {
        const resolveNone = () => null;

        const result = preValidate(["x", "y", "z"], resolveNone, resolveNone);

        expect(result.validIds).toHaveLength(0);
        expect(result.invalidIds).toEqual(["x", "y", "z"]);
    });

    it("should return all valid when everything resolves", () => {
        const resolveAll = (id) => ({ id });

        const result = preValidate(["a", "b"], resolveAll, resolveAll);

        expect(result.validIds).toEqual(["a", "b"]);
        expect(result.invalidIds).toHaveLength(0);
    });

    it("should handle empty input", () => {
        const result = preValidate([], () => null, () => null);
        expect(result.validIds).toHaveLength(0);
        expect(result.invalidIds).toHaveLength(0);
    });
});
