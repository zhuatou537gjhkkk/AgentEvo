import { ratio } from "./checks.js";

function layerReport(results, layer) {
    const cases = results.filter((item) => item.layer === layer);
    const executed = cases.filter((item) => item.status !== "not_run");
    const passed = executed.filter((item) => item.status === "pass");
    return {
        layer,
        total: cases.length,
        notRun: cases.length - executed.length,
        passRate: ratio(passed.length, executed.length),
        passed: passed.length,
        failed: executed.length - passed.length,
    };
}

export function summarizeMcpResults(results = []) {
    const layers = ["protocol", "tool_call", "end_to_end"].map((layer) => layerReport(results, layer));
    return {
        totalCases: results.length,
        pass: results.filter((item) => item.status === "pass").length,
        fail: results.filter((item) => item.status === "fail").length,
        notRun: results.filter((item) => item.status === "not_run").length,
        layers,
        failureClasses: results.reduce((acc, item) => {
            if (item.failureClass) acc[item.failureClass] = (acc[item.failureClass] || 0) + 1;
            return acc;
        }, {}),
        observations: {
            sampleSize: results.reduce((sum, item) => sum + (item.observationIds?.length || 0), 0),
        },
    };
}

export function compareMcpSummaries(baseline, candidate) {
    const baselineLayers = new Map((baseline?.layers || []).map((item) => [item.layer, item]));
    return (candidate?.layers || []).map((item) => {
        const before = baselineLayers.get(item.layer);
        return {
            layer: item.layer,
            baseline: before?.passRate || ratio(0, 0),
            candidate: item.passRate,
            delta: before?.passRate?.value == null || item.passRate?.value == null ? null : Math.round((item.passRate.value - before.passRate.value) * 10000) / 10000,
        };
    });
}
