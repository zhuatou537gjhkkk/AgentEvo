/**
 * Phase 7 / R6 — offline coding benchmark feature flags.
 *
 * The whole benchmark surface is DEFAULT OFF. `BENCH_ENABLED` gates the HTTP
 * registrar (scenarios / run / list / detail / export) and the harness entry; a
 * benchmark RUN additionally inherits the coding-domain capability flags it
 * needs at call time (CODING_WORKSPACE_ENABLED / CODING_WRITE_TOOLS_ENABLED /
 * CODING_COMMAND_TOOLS_ENABLED + allowed-roots/worktree-base + command
 * allowlist), so turning bench on never by itself opens file writes or command
 * execution.
 *
 * `BENCH_REAL_MODEL_ENABLED` marks the (not yet shipped) real-model driver opt-in
 * for a candidate benchmark. Everything else in R6 is deterministic: scripted
 * (fake) drivers keep contract/safety tests reproducible without a model.
 *
 * Reading env at call time (never import time) keeps the production singleton
 * safely dark until explicitly enabled, matching coding/flags.js + R5 style.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export const benchEnabled = () => flagEnabled("BENCH_ENABLED");
export const benchRealModelEnabled = () => flagEnabled("BENCH_REAL_MODEL_ENABLED");

export const BENCH_FLAG_NAMES = [
    "BENCH_ENABLED",
    "BENCH_REAL_MODEL_ENABLED",
];

/** Server-decided capability snapshot — never derived from client/model input. */
export function benchCapabilities() {
    return {
        enabled: benchEnabled(),
        realModel: benchRealModelEnabled(),
    };
}

/** Clean the default-off expectation for a process that should have no flags set. */
export function clearBenchFlags() {
    for (const name of BENCH_FLAG_NAMES) {
        delete process.env[name];
    }
}
