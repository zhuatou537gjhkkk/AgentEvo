/** MCP-specific rollout flags. Read process.env at call time for test isolation. */
export function mcpTelemetryEnabled() {
    return process.env.MCP_TELEMETRY_ENABLED === "true" || process.env.MCP_TELEMETRY_ENABLED === "1";
}

export function mcpEvalEnabled() {
    return process.env.MCP_EVAL_ENABLED === "true" || process.env.MCP_EVAL_ENABLED === "1";
}

export const MCP_FLAG_NAMES = ["MCP_TELEMETRY_ENABLED", "MCP_EVAL_ENABLED"];
