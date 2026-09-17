/**
 * M10 — deterministic cross-source recall quality.
 *
 * The evaluator consumes only answer text and sanitized Trace metadata. It
 * never reads memory/RAG storage and never calls a model, so it is safe to
 * use in offline runs and in regression tests.
 */

function clamp01(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function average(values) {
    const valid = values.filter((value) => Number.isFinite(value));
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function includesTerm(text, term) {
    return String(text || "").toLowerCase().includes(String(term).toLowerCase());
}

function containsAll(text, terms = []) {
    return terms.every((term) => includesTerm(text, term));
}

function containsAny(text, terms = []) {
    return terms.length === 0 || terms.some((term) => includesTerm(text, term));
}

function parseRootSpan(rootSpan) {
    if (!rootSpan) return null;
    if (typeof rootSpan === "object") return rootSpan;
    try { return JSON.parse(rootSpan); } catch { return null; }
}

function traceMetadata(trace) {
    if (!trace || typeof trace !== "object") return null;
    if (trace.metadata && typeof trace.metadata === "object") return trace.metadata;
    const rootSpan = parseRootSpan(trace.rootSpan || trace.root_span);
    return rootSpan?.metadata && typeof rootSpan.metadata === "object" ? rootSpan.metadata : null;
}

function diagnosticsFromTrace(trace) {
    const metadata = traceMetadata(trace);
    const diagnostics = metadata?.cross_source_recall;
    return diagnostics && typeof diagnostics === "object" ? diagnostics : null;
}

function selectedItems(diagnostics) {
    return Array.isArray(diagnostics?.selected) ? diagnostics.selected.filter(Boolean) : [];
}

function selectedSourceCounts(items) {
    return items.reduce((counts, item) => {
        const source = String(item.sourceType || item.source_type || "unknown");
        counts[source] = (counts[source] || 0) + 1;
        return counts;
    }, {});
}

/**
 * Evaluate a cross-source scenario.
 *
 * Supported `testCase.crossSourceChecks` fields are intentionally declarative:
 * requiredSourceTypes, forbiddenSourceTypes, requiredIds, forbiddenIds,
 * outputAny, outputAll, outputNone, maxSelectedPerSource and minScore.
 */
export function evaluateCrossSourceQuality(testCase, observed = {}) {
    if (testCase?.category !== "cross_source_recall") return null;
    const checks = testCase.crossSourceChecks || {};
    const diagnostics = diagnosticsFromTrace(observed.trace);
    const output = String(observed.text || "");
    const selected = selectedItems(diagnostics);
    const selectedIds = new Set(selected.map((item) => String(item.id ?? item.memoryId ?? "")));
    const selectedSources = new Set(selected.map((item) => String(item.sourceType || item.source_type || "unknown")));
    const counts = selectedSourceCounts(selected);
    const results = [];

    if (!diagnostics) {
        return {
            version: "cross-source-quality-v1",
            testCaseId: testCase.id,
            status: "unavailable",
            passed: false,
            score: 0,
            checks: [{ name: "trace_diagnostics", pass: false, detail: "cross-source recall trace is unavailable" }],
            metrics: { isolation: 0, sourceCoverage: 0, budgetCompliance: 0, helpfulness: 0 },
            selectedSources: [],
        };
    }

    const requiredSources = checks.requiredSourceTypes || [];
    const forbiddenSources = checks.forbiddenSourceTypes || [];
    const requiredIds = (checks.requiredIds || []).map(String);
    const forbiddenIds = (checks.forbiddenIds || []).map(String);

    for (const source of requiredSources) {
        results.push({
            name: `required_source:${source}`,
            pass: selectedSources.has(String(source)),
            detail: "required source appears in selected candidates",
        });
    }
    for (const source of forbiddenSources) {
        results.push({
            name: `forbidden_source:${source}`,
            pass: !selectedSources.has(String(source)),
            detail: "forbidden source is absent from selected candidates",
        });
    }
    for (const id of requiredIds) {
        results.push({ name: `required_id:${id}`, pass: selectedIds.has(id), detail: "required candidate is selected" });
    }
    for (const id of forbiddenIds) {
        results.push({ name: `forbidden_id:${id}`, pass: !selectedIds.has(id), detail: "forbidden candidate is absent" });
    }

    const expectedScore = Number(checks.minScore);
    if (Number.isFinite(expectedScore)) {
        results.push({
            name: "minimum_score",
            pass: selected.length === 0 || selected.every((item) => Number(item.score) >= expectedScore),
            detail: `selected scores should be >= ${expectedScore}`,
        });
    }
    for (const [source, cap] of Object.entries(checks.maxSelectedPerSource || {})) {
        results.push({
            name: `source_cap:${source}`,
            pass: (counts[source] || 0) <= Number(cap),
            detail: `selected=${counts[source] || 0}, cap=${cap}`,
        });
    }

    if (checks.outputAny?.length) results.push({ name: "helpfulness_any", pass: containsAny(output, checks.outputAny), detail: "answer contains useful evidence" });
    if (checks.outputAll?.length) results.push({ name: "helpfulness_all", pass: containsAll(output, checks.outputAll), detail: "answer contains all required evidence" });
    if (checks.outputNone?.length) results.push({ name: "answer_isolation", pass: !checks.outputNone.some((term) => includesTerm(output, term)), detail: "answer omits forbidden content" });

    const config = diagnostics.config || {};
    const bySource = diagnostics.bySource || {};
    const configItemsOk = !Number.isFinite(Number(config.maxItems)) || selected.length <= Number(config.maxItems);
    const configTokensOk = !Number.isFinite(Number(config.maxTokens)) || Number(diagnostics.selectedTokens || 0) <= Number(config.maxTokens);
    const sourceCapsOk = Object.entries(bySource).every(([source, value]) => Number(value?.selected || 0) <= Number(value?.cap ?? Infinity));
    const budgetCompliance = configItemsOk && configTokensOk && sourceCapsOk ? 1 : 0;
    const isolationChecks = results.filter((item) => item.name.startsWith("forbidden_") || item.name === "answer_isolation");
    const coverage = requiredSources.length === 0 ? 1 : requiredSources.filter((source) => selectedSources.has(String(source))).length / requiredSources.length;
    const helpfulnessChecks = results.filter((item) => item.name.startsWith("helpfulness_") || item.name === "answer_isolation");
    const score = average([
        coverage,
        budgetCompliance,
        isolationChecks.length ? average(isolationChecks.map((item) => item.pass ? 1 : 0)) : 1,
        helpfulnessChecks.length ? average(helpfulnessChecks.map((item) => item.pass ? 1 : 0)) : 1,
    ]) || 0;
    const passed = results.every((item) => item.pass !== false) && budgetCompliance === 1;

    return {
        version: "cross-source-quality-v1",
        testCaseId: testCase.id,
        status: "evaluated",
        passed,
        score: Math.round(clamp01(score) * 100) / 100,
        checks: results,
        metrics: {
            isolation: Math.round(clamp01(isolationChecks.length ? average(isolationChecks.map((item) => item.pass ? 1 : 0)) : 1) * 100) / 100,
            sourceCoverage: Math.round(clamp01(coverage) * 100) / 100,
            budgetCompliance,
            helpfulness: Math.round(clamp01(helpfulnessChecks.length ? average(helpfulnessChecks.map((item) => item.pass ? 1 : 0)) : 1) * 100) / 100,
        },
        selectedSources: [...selectedSources],
        selectedCount: selected.length,
        errors: diagnostics.errors || {},
    };
}

export function aggregateCrossSourceQuality(results = []) {
    const items = results.map((result) => result?.crossSourceQuality).filter(Boolean);
    if (items.length === 0) return null;
    const evaluated = items.filter((item) => item.status === "evaluated");
    const averageMetric = (key) => average(evaluated.map((item) => item.metrics?.[key]).filter(Number.isFinite));
    return {
        version: "cross-source-quality-v1",
        total: items.length,
        evaluated: evaluated.length,
        unavailable: items.filter((item) => item.status === "unavailable").length,
        passed: evaluated.filter((item) => item.passed).length,
        failed: evaluated.filter((item) => !item.passed).length,
        passRate: evaluated.length ? Math.round(evaluated.filter((item) => item.passed).length / evaluated.length * 100) / 100 : null,
        averageScore: average(evaluated.map((item) => item.score)),
        isolation: averageMetric("isolation"),
        sourceCoverage: averageMetric("sourceCoverage"),
        budgetCompliance: averageMetric("budgetCompliance"),
        helpfulness: averageMetric("helpfulness"),
        byCase: items.map((item) => ({ testCaseId: item.testCaseId, status: item.status, passed: item.passed, score: item.score })),
    };
}

export default { evaluateCrossSourceQuality, aggregateCrossSourceQuality };
