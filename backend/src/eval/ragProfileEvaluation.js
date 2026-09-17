/** K9 profile runner and quality gates. It accepts injected retrieval/answer drivers. */
import { evaluateRagCase } from "./ragEvaluation.js";
import { evaluateRagAnswer } from "./ragAnswerEvaluation.js";

export const RAG_PROFILES = Object.freeze(["lexical", "hybrid", "hybrid+rewrite", "hybrid+rerank", "full"]);

function number(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function usageTokens(usage) {
    return number(usage?.totalTokens ?? usage?.total_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens, 0)
        + (usage?.totalTokens == null && usage?.total_tokens == null ? number(usage?.outputTokens ?? usage?.completion_tokens, 0) : 0);
}

function average(rows, key) {
    const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(rows, key, ratio) {
    const values = rows.map((row) => Number(row[key])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function summarizeRows(rows) {
    const positive = rows.filter((row) => row.noAnswer !== true);
    const noAnswer = rows.filter((row) => row.noAnswerCorrect != null);
    const noAnswerCorrect = noAnswer.filter((row) => row.noAnswerCorrect === true).length;
    const answerRows = rows.filter((row) => row.answer);
    const faithfulnessRows = answerRows.filter((row) => Number.isFinite(row.answer.faithfulness?.score));
    return {
        sampleCount: rows.length,
        passed: rows.filter((row) => row.passed).length,
        failed: rows.filter((row) => !row.passed).length,
        recallAtK: average(positive, "recallAtK"),
        mrr: average(positive, "reciprocalRank"),
        ndcgAtK: average(positive, "ndcgAtK"),
        noAnswerPrecision: noAnswer.length ? noAnswerCorrect / noAnswer.length : null,
        noAnswerSamples: noAnswer.length,
        citationPageAccuracy: average(answerRows.map((row) => ({ value: row.answer.deterministic.pageAccuracy })).filter((row) => row.value != null), "value"),
        citationSamples: answerRows.filter((row) => row.answer.deterministic.pageAccuracy != null).length,
        faithfulness: average(faithfulnessRows.map((row) => ({ value: row.answer.faithfulness.score })), "value"),
        faithfulnessSamples: faithfulnessRows.length,
        unsupportedCriticalClaims: faithfulnessRows.reduce((sum, row) => sum + number(row.answer.faithfulness.unsupportedCriticalClaims), 0),
        p50LatencyMs: percentile(rows, "latencyMs", 0.5),
        p95LatencyMs: percentile(rows, "latencyMs", 0.95),
        llmCalls: rows.reduce((sum, row) => sum + number(row.metrics?.llmCalls) + number(row.answer?.faithfulness?.calls), 0),
        embeddingCalls: rows.reduce((sum, row) => sum + number(row.metrics?.embeddingCalls), 0),
        callCount: rows.reduce((sum, row) => sum + number(row.metrics?.llmCalls) + number(row.metrics?.embeddingCalls) + number(row.answer?.faithfulness?.calls), 0),
        tokenCount: rows.reduce((sum, row) => sum + number(row.metrics?.tokenCount) + usageTokens(row.answer?.faithfulness?.usage), 0),
        avgCompressionRatio: average(rows.map((row) => ({ value: row.metrics?.compression?.ratio })).filter((row) => row.value != null), "value"),
        deterministicSecurityFailures: rows.filter((row) => row.excludedPresent || row.answer?.deterministic?.ownerIsolationFailure || row.answer?.deterministic?.staleFailure).length,
        citationAllowlistFailures: rows.filter((row) => (row.answer?.deterministic?.unknownCitationRefs || []).length > 0).length,
    };
}

export async function runRagProfileEvaluation({ cases = [], profiles = RAG_PROFILES, retrieve, answer = null, judge = null, judgeDisabledReason = "JUDGE_DISABLED", now = () => Date.now() } = {}) {
    if (typeof retrieve !== "function") throw new Error("RAG profile evaluation requires an injected retriever");
    const reports = {};
    for (const profile of profiles) {
        if (!RAG_PROFILES.includes(profile)) throw new Error(`unknown RAG profile: ${profile}`);
        const rows = [];
        for (const testCase of cases) {
            const started = now();
            try {
                const response = await retrieve({ profile, testCase });
                const retrieval = evaluateRagCase(testCase, response, { latencyMs: now() - started });
                const answerResponse = answer ? await answer({ profile, testCase, response }) : response;
                const answerResult = answerResponse ? await evaluateRagAnswer(testCase, answerResponse, { judge, disabledReason: judgeDisabledReason }) : null;
                rows.push({
                    id: testCase.id,
                    category: testCase.category,
                    noAnswer: testCase.noAnswer === true,
                    passed: retrieval.passed && (!answerResult || answerResult.passed),
                    ...retrieval,
                    answer: answerResult,
                    metrics: response?.metrics || {},
                });
            } catch (error) {
                rows.push({
                    id: testCase.id,
                    category: testCase.category,
                    noAnswer: testCase.noAnswer === true,
                    passed: false,
                    recallAtK: 0,
                    reciprocalRank: 0,
                    ndcgAtK: 0,
                    noAnswerCorrect: testCase.noAnswer ? false : null,
                    pageAccuracy: null,
                    excludedPresent: false,
                    latencyMs: Math.max(0, now() - started),
                    metrics: {},
                    errorCode: String(error?.code || "RAG_EVAL_CASE_ERROR").slice(0, 80),
                });
            }
        }
        reports[profile] = { profile, summary: summarizeRows(rows), cases: rows };
    }
    return { profiles: reports, gates: compareRagProfiles(reports) };
}

export function compareRagProfiles(reports, { baseline = "hybrid", minSamples = 10 } = {}) {
    const baselineSummary = reports?.[baseline]?.summary;
    const fullSummary = reports?.full?.summary;
    if (!baselineSummary || !fullSummary) return { status: "insufficient_data", baseline, full: null };
    const sampleCount = Math.min(baselineSummary.sampleCount || 0, fullSummary.sampleCount || 0);
    const metricGate = (value, target) => sampleCount < minSamples ? { status: "insufficient_sample", value, target, sampleCount } : { status: value >= target ? "pass" : "fail", value, target, sampleCount };
    const gate = {
        securityIsolation: fullSummary.deterministicSecurityFailures === 0 ? "pass" : "fail",
        staleExclusion: fullSummary.deterministicSecurityFailures === 0 ? "pass" : "fail",
        citationAllowlist: fullSummary.citationAllowlistFailures === 0 ? "pass" : "fail",
        fullRecallVsHybrid: { status: fullSummary.recallAtK >= baselineSummary.recallAtK ? "pass" : "fail", value: fullSummary.recallAtK, target: baselineSummary.recallAtK },
        fullMrrVsHybrid: { status: fullSummary.mrr >= baselineSummary.mrr ? "pass" : "fail", value: fullSummary.mrr, target: baselineSummary.mrr },
        noAnswerPrecision: metricGate(fullSummary.noAnswerPrecision ?? 0, 0.9),
        citationPageAccuracy: metricGate(fullSummary.citationPageAccuracy ?? 0, 0.9),
        faithfulness: metricGate(fullSummary.faithfulness ?? 0, 0.85),
        unsupportedCriticalClaims: { status: fullSummary.unsupportedCriticalClaims === 0 ? "pass" : "fail", value: fullSummary.unsupportedCriticalClaims, target: 0 },
    };
    const statuses = Object.values(gate).map((value) => typeof value === "string" ? value : value.status);
    return { status: statuses.includes("fail") ? "fail" : statuses.includes("insufficient_sample") ? "insufficient_sample" : "pass", baseline, full: gate };
}

export default { RAG_PROFILES, runRagProfileEvaluation, compareRagProfiles };
