/**
 * Phase 7 / R5 (roadmap #6/#7) — AgentTask ↔ A2A ↔ LangGraph-Send adapters
 * (a2a/adapter.js). Pure, deterministic, transport-neutral transforms proving
 * that "LangGraph Send、A2A、ANP 只做 adapter": the internal AgentTask is the
 * single canonical shape, and every protocol boundary converts to/from it here.
 * No DB / no network / no LLM / no flags.
 */
import { createAgentTask, normalizeAgentTask, agentTaskToSendSpec } from "../agenttask/agentTask.js";
import { createA2ATask, fromWireStatus, A2A_TASK_STATUS } from "./task.js";

/**
 * AgentTask → A2A task. Builds a canonical A2A task (via createA2ATask cleanup
 * rules) carrying the task's goal/input/capability; agent defaults to "general"
 * when the AgentTask names no agent. `taskId` overrides the produced id (defaults
 * to the AgentTask's own id so a delegation can be traced back).
 */
export function agentTaskToA2ATask(task, { taskId = null } = {}) {
    const t = normalizeAgentTask(task);
    return createA2ATask({
        id: taskId || t.id,
        agent: t.agent || "general",
        goal: t.goal,
        input: t.input,
        capability: t.capability,
        parentTaskId: t.parentTaskId,
    });
}

/**
 * Map an A2A task status to the internal AgentTask status. Statuses that already
 * belong to the shared internal vocabulary pass through; wire-only vocabulary
 * (completed/canceled/working/input-required/unknown) is translated — a wire
 * `completed` maps to internal `succeeded`.
 */
function a2aStatusToAgentTaskStatus(status) {
    const s = String(status || "");
    if (A2A_TASK_STATUS.includes(s)) return s;
    return fromWireStatus(s);
}

/**
 * A2A task → AgentTask. The A2A record may carry either an internal status or a
 * wire status; both map onto the shared AgentTask status vocabulary.
 */
export function a2aTaskToAgentTask(a2a) {
    const t = a2a && typeof a2a === "object" ? a2a : {};
    return normalizeAgentTask({
        id: t.id,
        goal: t.goal,
        agent: t.agent,
        tool: null,
        input: t.input,
        capability: t.capability,
        parentTaskId: t.parentTaskId,
        status: a2aStatusToAgentTaskStatus(t.status),
        context: t.context,
        meta: { source: "a2a", ...(t.meta && typeof t.meta === "object" ? t.meta : {}) },
    });
}

/**
 * AgentTask → LangGraph `Send` spec. Re-exported one layer so A2A/ANP callers
 * have a single adapter surface: the produced spec is a plain object (the main
 * Graph maps it to a real `Send` in fan-out). `payload` pins the current subTask
 * and spreads `state`.
 */
export function toLangGraphSendAdapter(task, { node = null, state = {} } = {}) {
    return agentTaskToSendSpec(task, { node, state });
}

/**
 * Convenience builder so a fresh AgentTask can be handed to the A2A runtime
 * without first round-tripping — mirrors createAgentTask defaults.
 */
export function agentTaskFromA2A(id, a2aLike = {}) {
    return createAgentTask({
        id,
        goal: a2aLike.goal,
        agent: a2aLike.agent,
        tool: null,
        input: a2aLike.input,
        capability: a2aLike.capability,
        parentTaskId: a2aLike.parentTaskId,
        context: a2aLike.context,
    });
}

export default {
    agentTaskToA2ATask,
    a2aTaskToAgentTask,
    toLangGraphSendAdapter,
    agentTaskFromA2A,
};
