/**
 * M7 — deterministic memory-quality evaluator.
 *
 * The generic LLM judge remains useful for answer quality, but memory
 * correctness needs reproducible checks for actions, evidence and safety.
 * This module is pure: it never reads the database or calls a model.
 */

function parseInput(input) {
    if (input && typeof input === "object") return input;
    try { return JSON.parse(input || "{}"); } catch { return {}; }
}

function memoryCalls(toolCalls = []) {
    return (Array.isArray(toolCalls) ? toolCalls : [])
        .filter((call) => call?.toolName === "memory")
        .map((call) => ({
            ...call,
            args: parseInput(call.input),
            outputText: typeof call.output === "string" ? call.output : JSON.stringify(call.output || ""),
        }));
}

function countAction(calls, action) {
    return calls.filter((call) => String(call.args.action || "search") === action).length;
}

function containsAll(text, terms = []) {
    return terms.every((term) => text.toLowerCase().includes(String(term).toLowerCase()));
}

function containsAny(text, terms = []) {
    return terms.length === 0 || terms.some((term) => text.toLowerCase().includes(String(term).toLowerCase()));
}

function checkActionOrder(calls, order = []) {
    let cursor = -1;
    for (const action of order) {
        const next = calls.findIndex((call, index) => index > cursor && String(call.args.action || "search") === action);
        if (next < 0) return false;
        cursor = next;
    }
    return true;
}

export function evaluateMemoryQuality(testCase, observed = {}) {
    if (testCase?.category !== "memory_recall") return null;
    const checks = testCase.memoryChecks || {};
    const calls = memoryCalls(observed.toolCalls);
    const output = [observed.text || "", ...calls.map((call) => call.outputText)].join("\n");
    const inputs = calls.map((call) => JSON.stringify(call.args)).join("\n");
    const results = [];

    for (const requirement of checks.requiredActions || []) {
        const action = typeof requirement === "string" ? requirement : requirement.action;
        const minCount = typeof requirement === "string" ? 1 : Number(requirement.minCount || 1);
        const count = countAction(calls, action);
        results.push({
            name: `action:${action}`,
            pass: count >= minCount,
            detail: `expected >= ${minCount}, observed ${count}`,
        });
    }

    if (checks.toolInputContains?.length) {
        results.push({
            name: "memory_input_evidence",
            pass: containsAll(inputs, checks.toolInputContains),
            detail: "required memory facts appear in tool inputs",
        });
    }
    if (checks.outputAll?.length) {
        results.push({
            name: "response_evidence_all",
            pass: containsAll(output, checks.outputAll),
            detail: "all expected facts appear in the response/tool evidence",
        });
    }
    if (checks.outputAny?.length) {
        results.push({
            name: "response_evidence_any",
            pass: containsAny(output, checks.outputAny),
            detail: "an honest response marker appears",
        });
    }
    if (checks.outputNone?.length) {
        results.push({
            name: "response_safety",
            pass: !checks.outputNone.some((term) => output.toLowerCase().includes(String(term).toLowerCase())),
            detail: "forbidden content is absent",
        });
    }
    if (checks.actionOrder?.length) {
        results.push({
            name: "action_order",
            pass: checkActionOrder(calls, checks.actionOrder),
            detail: `expected order: ${checks.actionOrder.join(" → ")}`,
        });
    }

    const traceRecall = observed.trace?.metadata?.memory_recall || observed.trace?.memory_recall || null;
    const recallAdoption = traceRecall && Array.isArray(traceRecall.selected) && traceRecall.selected.length > 0
        ? (Array.isArray(traceRecall.contextSelected) ? traceRecall.contextSelected.length : 0) / traceRecall.selected.length
        : null;
    if (checks.requiresRecallEvidence) {
        results.push({
            name: "recall_adoption",
            pass: recallAdoption == null ? null : recallAdoption > 0,
            evaluated: recallAdoption != null,
            detail: recallAdoption == null ? "no recall trace attached" : `adoption=${recallAdoption.toFixed(2)}`,
        });
    }

    const evaluatedChecks = results.filter((item) => item.pass !== null);
    const passedChecks = evaluatedChecks.filter((item) => item.pass).length;
    const score = evaluatedChecks.length > 0 ? passedChecks / evaluatedChecks.length : 0;
    return {
        version: "memory-quality-v1",
        testCaseId: testCase.id,
        passed: score >= 0.75,
        score: Math.round(score * 100) / 100,
        checks: results,
        metrics: {
            actionCompliance: averageChecks(results.filter((item) => item.name.startsWith("action:"))),
            responseEvidence: averageChecks(results.filter((item) => item.name.startsWith("response_evidence"))),
            safety: averageChecks(results.filter((item) => item.name === "response_safety")),
            recallAdoption,
        },
        observedActions: [...new Set(calls.map((call) => String(call.args.action || "search")))],
    };
}

function averageChecks(items) {
    const evaluated = items.filter((item) => item.pass !== null);
    if (evaluated.length === 0) return null;
    return evaluated.filter((item) => item.pass).length / evaluated.length;
}

export function aggregateMemoryQuality(results = []) {
    const items = results.map((result) => result?.memoryQuality).filter(Boolean);
    if (items.length === 0) return null;
    const average = (values) => {
        const valid = values.filter((value) => Number.isFinite(value));
        return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length * 100) / 100 : null;
    };
    return {
        version: "memory-quality-v1",
        total: items.length,
        passed: items.filter((item) => item.passed).length,
        failed: items.filter((item) => !item.passed).length,
        passRate: Math.round(items.filter((item) => item.passed).length / items.length * 100) / 100,
        averageScore: average(items.map((item) => item.score)),
        actionCompliance: average(items.map((item) => item.metrics.actionCompliance)),
        responseEvidence: average(items.map((item) => item.metrics.responseEvidence)),
        safety: average(items.map((item) => item.metrics.safety)),
        recallAdoption: average(items.map((item) => item.metrics.recallAdoption)),
        byCase: items.map((item) => ({ testCaseId: item.testCaseId, passed: item.passed, score: item.score })),
    };
}

export default { evaluateMemoryQuality, aggregateMemoryQuality };
