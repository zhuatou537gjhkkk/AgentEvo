/**
 * Phase 7 / R0 — Coding feature flags.
 *
 * All five capabilities default to OFF. `CODING_WORKSPACE_ENABLED` is the master
 * switch for the coding registrar; the remaining flags describe capabilities that
 * are still unbuilt (runner/write/command) or independently gated (event log).
 * Reading env at call time (not import time) keeps tests able to flip them per
 * scenario and keeps the production singleton safely dark until explicitly enabled.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export const codingWorkspaceEnabled = () => flagEnabled("CODING_WORKSPACE_ENABLED");
export const codingEventLogEnabled = () => flagEnabled("CODING_EVENT_LOG_ENABLED");
export const codingRunnerEnabled = () => flagEnabled("CODING_RUNNER_ENABLED");
export const codingWriteToolsEnabled = () => flagEnabled("CODING_WRITE_TOOLS_ENABLED");
export const codingCommandToolsEnabled = () => flagEnabled("CODING_COMMAND_TOOLS_ENABLED");

export const CODING_FLAG_NAMES = [
    "CODING_WORKSPACE_ENABLED",
    "CODING_EVENT_LOG_ENABLED",
    "CODING_RUNNER_ENABLED",
    "CODING_WRITE_TOOLS_ENABLED",
    "CODING_COMMAND_TOOLS_ENABLED",
];

/** Server-decided capability snapshot — never computed from client/model input. */
export function codingCapabilities() {
    return {
        workspace: codingWorkspaceEnabled(),
        eventLog: codingEventLogEnabled(),
        runner: codingRunnerEnabled(),
        writeTools: codingWriteToolsEnabled(),
        commandTools: codingCommandToolsEnabled(),
    };
}

/** Clean the default-off expectation for a process that should have no flags set. */
export function clearCodingFlags() {
    for (const name of CODING_FLAG_NAMES) {
        delete process.env[name];
    }
}
