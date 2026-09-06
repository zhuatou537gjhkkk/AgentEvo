/**
 * Phase 7 / R4 — durable knowledge / project RAG / project memory flags.
 *
 * Every getter reads `process.env` at call time (never import time), so tests
 * can flip a scenario per call and `clearRagFlags()` restores default-off.
 * All R4 capabilities are default OFF and roll back by unsetting the env var
 * (the durable store is additive; reads then fall back to the legacy in-memory
 * adapter untouched).
 *
 * Flag split (mirrors roadmap R4 checklist #9 + W5 hardening):
 *   - RAG_DURABLE_ENABLED  — durable *document* store infra: uploads are written
 *     to both the legacy in-memory adapter AND the durable DB store (dual-write)
 *     and read back through a dual-read compare while the canary is OFF.
 *   - DURABLE_RAG_READ     — canary switch: when ALSO set, reads are served from
 *     the durable index instead of the legacy memory adapter (rollback = unset).
 *   - PROJECT_RAG_ENABLED  — per-project *code* RAG: file-hash incremental index
 *     + hybrid lexical/embedding retrieval + knowledge/code agent reuse.
 *   - PROJECT_MEMORY_ENABLED — run working / project episodic / project semantic
 *     memory layers separated from the existing user-level agent_memory.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export function durableRagEnabled() {
    return flagEnabled("RAG_DURABLE_ENABLED");
}

export function durableRagReadCanary() {
    return flagEnabled("DURABLE_RAG_READ");
}

export function projectRagEnabled() {
    return flagEnabled("PROJECT_RAG_ENABLED");
}

export function projectMemoryEnabled() {
    return flagEnabled("PROJECT_MEMORY_ENABLED");
}

export const RAG_FLAG_NAMES = [
    "RAG_DURABLE_ENABLED",
    "DURABLE_RAG_READ",
    "PROJECT_RAG_ENABLED",
    "PROJECT_MEMORY_ENABLED",
];

export function clearRagFlags() {
    for (const name of RAG_FLAG_NAMES) {
        delete process.env[name];
    }
}

export default { durableRagEnabled, durableRagReadCanary, projectRagEnabled, projectMemoryEnabled, RAG_FLAG_NAMES, clearRagFlags };
