/**
 * Phase 7 / R5 — Extensible-Agent feature flags (Skills / MCP run-scope / remote
 * MCP / A2A / ANP).
 *
 * Every getter reads `process.env` at call time (never import time), so tests can
 * flip a scenario per call and `clearExtensibilityFlags()` restores default-off.
 * All R5 capabilities are default OFF and roll back by unsetting the env var; with
 * a flag dark the corresponding registrar tree answers 403 EXT_*_DISABLED and the
 * legacy main-Graph path is byte-for-byte identical.
 *
 * Flag split (mirrors roadmap R5 checklist #1/#4/#5/#7/#9):
 *   - SKILLS_ENABLED         — product Skills Runtime: manifest registry + the
 *     Router/Planner skill-guidance hook. Skills only ever add process/rules/
 *     knowledge; they never grant a tool or a new agent type.
 *   - MCP_RUN_SCOPE_ENABLED  — stdio-origin MCP tools run under a coding-run
 *     scope: effect classification → preset policy → approval/timeout → unified
 *     result → audit (mcp/runScope.js). Off = raw tool calls unchanged.
 *   - REMOTE_MCP_ENABLED     — allows registering *remote* (Streamable HTTP/URL)
 *     MCP servers. Preconditions (trust, vault/OAuth secret indirection, SSRF/
 *     redirect/IP policy, health lifecycle) are always enforced before any remote
 *     server is accepted; the flag is the master switch.
 *   - A2A_ENABLED            — same-instance / local-trusted agent cards + task/
 *     status/artifact/cancel runtime; delegation sends only a capability subset.
 *   - ANP_ENABLED            — default-off discovery/identity experiment. ANP
 *     discovery is identity only and is NEVER authorization.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export const skillsEnabled = () => flagEnabled("SKILLS_ENABLED");
export const mcpRunScopeEnabled = () => flagEnabled("MCP_RUN_SCOPE_ENABLED");
export const remoteMcpEnabled = () => flagEnabled("REMOTE_MCP_ENABLED");
export const a2aEnabled = () => flagEnabled("A2A_ENABLED");
export const anpEnabled = () => flagEnabled("ANP_ENABLED");

export const EXTENSIBILITY_FLAG_NAMES = [
    "SKILLS_ENABLED",
    "MCP_RUN_SCOPE_ENABLED",
    "REMOTE_MCP_ENABLED",
    "A2A_ENABLED",
    "ANP_ENABLED",
];

/** Server-decided R5 capability snapshot — never computed from client/model input. */
export function extensibilityCapabilities() {
    return {
        skills: skillsEnabled(),
        mcpRunScope: mcpRunScopeEnabled(),
        remoteMcp: remoteMcpEnabled(),
        a2a: a2aEnabled(),
        anp: anpEnabled(),
    };
}

/** Clean the default-off expectation for a process that should have no flags set. */
export function clearExtensibilityFlags() {
    for (const name of EXTENSIBILITY_FLAG_NAMES) {
        delete process.env[name];
    }
}

export default {
    skillsEnabled, mcpRunScopeEnabled, remoteMcpEnabled, a2aEnabled, anpEnabled,
    EXTENSIBILITY_FLAG_NAMES, extensibilityCapabilities, clearExtensibilityFlags,
};
