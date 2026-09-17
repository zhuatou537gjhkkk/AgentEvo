export function checkResult(checks, passed, code, message, evidence = null) {
    checks.push({ passed: Boolean(passed), code, message, evidence });
    return Boolean(passed);
}

export function checksPassed(checks) {
    return checks.length > 0 && checks.every((check) => check.passed);
}

export function ratio(numerator, denominator) {
    return {
        numerator: Number(numerator) || 0,
        denominator: Number(denominator) || 0,
        value: denominator ? Math.round((Number(numerator) / Number(denominator)) * 10000) / 10000 : null,
    };
}

export function classifyMcpFailure({ status, toolSelected = true, argumentsCorrect = true, answerCorrect = true } = {}) {
    if (status === "unavailable" || status === "timeout" || status === "transport_error" || status === "aborted") return "call_failure/latency";
    if (status === "validation_error") return "discovery/schema";
    if (!toolSelected) return "wrong_tool";
    if (!argumentsCorrect) return "bad_arguments";
    if (!answerCorrect) return "answer_misuse";
    if (status === "protocol_error") return "call_failure/latency";
    return null;
}
