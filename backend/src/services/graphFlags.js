/**
 * Phase 7 / R3 — Main-Graph feature flags.
 *
 * The R3 Agent-Framework-Beta capabilities are progressive and default to the
 * pre-R3 behavior. A flag is read at call time (never import time) so tests can
 * flip per scenario and the production singleton stays on the legacy path until
 * a flag is explicitly enabled.
 *
 *  - GRAPH_DAG_SCHEDULER_ENABLED : run the dependency-aware multi-wave subTask
 *    scheduler (planner → waves of ready agents → synthesizer) instead of the
 *    legacy "one fan-out → synthesize" path. Off = current behavior unchanged.
 *  - CONTEXT_PROVENANCE_ENABLED : have the ContextBuilder emit provenance
 *    packets (hash/range dedup, per-source budget, digest) alongside the string.
 *  - AGENT_RETRIEVAL_ENABLED : searchAgentNode 对 web_search 原始文本做去重/排序/
 *    引用标注的有界后处理（agentRetrieval.js）。Off = 原文逐字节透传（现状不变）。
 *  - GRAPH_GENERAL_REACT_LOOP_ENABLED : 让 general_chat 走统一有界 ReAct 编排器
 *    agentReactLoop.js（替代内联 ReAct 循环）。Off = 现状不变。
 *  - GRAPH_PLAN_SEND_STATE_ENABLED : use the generation-safe task dependency
 *    table lifecycle for Plan mode. Off = the R3 scheduler/legacy paths remain.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
}

export const dagSchedulerEnabled = () => flagEnabled("GRAPH_DAG_SCHEDULER_ENABLED");
export const contextProvenanceEnabled = () => flagEnabled("CONTEXT_PROVENANCE_ENABLED");
export const agentRetrievalEnabled = () => flagEnabled("AGENT_RETRIEVAL_ENABLED");
export const generalReactLoopEnabled = () => flagEnabled("GRAPH_GENERAL_REACT_LOOP_ENABLED");
export const planSendStateEnabled = () => flagEnabled("GRAPH_PLAN_SEND_STATE_ENABLED");
export const planSemanticCheckEnabled = () => flagEnabled("ENABLE_PLAN_SEMANTIC_CHECK");

export const GRAPH_FLAG_NAMES = [
    "GRAPH_DAG_SCHEDULER_ENABLED",
    "CONTEXT_PROVENANCE_ENABLED",
    "AGENT_RETRIEVAL_ENABLED",
    "GRAPH_GENERAL_REACT_LOOP_ENABLED",
    "GRAPH_PLAN_SEND_STATE_ENABLED",
    "ENABLE_PLAN_SEMANTIC_CHECK",
];

/** Clean the default-off expectation for a process that should have no flags set. */
export function clearGraphFlags() {
    for (const name of GRAPH_FLAG_NAMES) {
        delete process.env[name];
    }
}
