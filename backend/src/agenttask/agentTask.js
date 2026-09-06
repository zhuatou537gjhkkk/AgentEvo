/**
 * Phase 7 / R5 — internal AgentTask (agenttask/agentTask.js).
 *
 * A canonical, transport-neutral unit of agent work. Anything that "runs" inside
 * the platform — a main-Graph subTask, a LangGraph `Send`, an A2A task handed to
 * a peer agent, or an ANP-discovered capability — is first expressed as an
 * AgentTask, then *adapted* to the concrete protocol (roadmap R5 #6:
 * "定义内部 AgentTask；LangGraph Send、A2A、ANP 只做 adapter").
 *
 * Rules:
 *   - AgentTask is declarative: it names a goal, an optional agent type, an
 *     optional tool, and the capability surface (effects/agents) it is ALLOWED to
 *     touch. The server that creates a task always narrows capability; the task
 *     itself can never widen it.
 *   - Adapters live in this module for the main-Graph surface (subTask / Send)
 *     and in a2a/adapter.js + anp/adapter.js for the wire protocols, so no
 *     protocol dependency leaks into the core.
 *   - Pure, deterministic, no DB / no network / no LLM.
 */
import { codingError } from "../coding/util.js";

export const TASK_KINDS = Object.freeze(["internal", "subtask", "delegated"]);
export const TASK_STATUS = Object.freeze([
    "created", "queued", "running", "waiting_input", "succeeded", "failed", "cancelled",
]);
export const EFFECT_TYPES = Object.freeze(["read", "write", "exec", "network", "external"]);
export const KNOWN_AGENT_TYPES = Object.freeze(["search", "knowledge", "code", "general"]);

function cleanString(value, max = 500) {
    if (value == null) return "";
    let out = "";
    for (const ch of String(value)) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, max).trim();
}

function cleanEffects(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const e = cleanString(item, 32);
        if (EFFECT_TYPES.includes(e) && !seen.has(e)) seen.add(e);
    }
    return EFFECT_TYPES.filter((e) => seen.has(e));
}

function cleanAgents(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const a = cleanString(item, 32);
        if (KNOWN_AGENT_TYPES.includes(a) && !seen.has(a)) seen.add(a);
    }
    return seen.size ? KNOWN_AGENT_TYPES.filter((a) => seen.has(a)) : [];
}

/**
 * Build a canonical AgentTask. `id` is required (callers pass their own run-scoped
 * id); missing optional fields get safe defaults. Unknown input fields are kept
 * under `meta.extra`.
 */
export function createAgentTask({
    id = null, goal = "", agent = null, tool = null, input = {},
    capability = { effects: [], agents: [] }, context = {},
    parentTaskId = null, maxRounds = null, mode = null, kind = "internal",
    status = "created", meta = {},
} = {}) {
    if (id == null || String(id).trim() === "") {
        throw codingError("AGENT_TASK_ID_REQUIRED", "agent task id is required", 400);
    }
    return {
        id: String(id).slice(0, 128),
        goal: cleanString(goal, 4000),
        agent: agent == null ? null : cleanString(agent, 64),
        tool: tool == null ? null : cleanString(tool, 200),
        input: input && typeof input === "object" ? input : {},
        capability: {
            effects: cleanEffects(capability?.effects),
            agents: cleanAgents(capability?.agents),
        },
        context: context && typeof context === "object" ? context : {},
        parentTaskId: parentTaskId == null ? null : String(parentTaskId).slice(0, 128),
        maxRounds: maxRounds == null ? null : Math.max(1, Number(maxRounds) | 0),
        mode: mode == null ? null : cleanString(mode, 32),
        kind: TASK_KINDS.includes(cleanString(kind, 16)) ? cleanString(kind, 16) : "internal",
        status: TASK_STATUS.includes(cleanString(status, 16)) ? cleanString(status, 16) : "created",
        meta: meta && typeof meta === "object" ? meta : {},
    };
}

/** Re-shape an arbitrary object into a canonical AgentTask (unknown fields kept in meta.extra). */
export function normalizeAgentTask(input = {}) {
    if (!input || typeof input !== "object") return createAgentTask({ id: "invalid" });
    const { id, goal, agent, tool, input: taskInput, capability, context, parentTaskId, maxRounds, mode, kind, status, meta, ...extra } = input;
    return createAgentTask({
        id: id ?? input.taskId ?? input.subTaskId,
        goal: goal ?? input.goal ?? "",
        agent: agent ?? input.agent ?? null,
        tool: tool ?? input.toolName ?? input.tool ?? null,
        input: taskInput ?? input.input ?? {},
        capability,
        context,
        parentTaskId: parentTaskId ?? input.parentTaskId ?? input.causationId ?? null,
        maxRounds: maxRounds ?? input.maxRounds ?? null,
        mode: mode ?? input.mode ?? null,
        kind,
        status,
        meta: { ...(meta && typeof meta === "object" ? meta : {}), extra: extra && Object.keys(extra).length ? extra : {} },
    });
}

export function isAgentTask(value) {
    return Boolean(value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0);
}

/**
 * True when the task actually needs a particular effect (i.e. its capability
 * surface was granted it). Empty capability = the task may only read context.
 */
export function canEffect(task, effect) {
    return (task?.capability?.effects || []).includes(effect);
}

/**
 * Intersect a task's capability with a caller-supplied allow set. Delegation is
 * always a narrowing — the result can never claim an effect/agent the task did
 * not already carry. Throws 403 when the task asks for something the allow set
 * forbids (used by A2A/ANP before dispatching, roadmap R5 #7/#9).
 */
export function capabilitySubset(task, { effects = null, agents = null } = {}) {
    const t = normalizeAgentTask(task);
    const allowEffects = effects == null ? EFFECT_TYPES : cleanEffects(effects);
    const allowAgents = agents == null ? KNOWN_AGENT_TYPES : cleanAgents(agents);
    const denied = [...(t.capability?.effects || [])].filter((e) => !allowEffects.includes(e));
    if (denied.length) {
        throw codingError("CAPABILITY_NOT_GRANTED", `effect "${denied[0]}" is outside the delegated capability subset`, 403);
    }
    return {
        ...t,
        capability: {
            effects: allowEffects.filter((e) => (t.capability?.effects || []).includes(e)),
            agents: allowAgents.filter((a) => (t.capability?.agents || []).includes(a)),
        },
    };
}

// ─────────────────────────── main-Graph adapters ───────────────────────────

/** default agent for tool-only tasks (graph runs them through the executor). */
const DEFAULT_AGENT = "general";

/**
 * AgentTask → main-Graph subTask (agentContract shape). Agent type is restricted
 * to the known set so `normalizeSubTask` keeps it; unknown → general. Tool tasks
 * map to type:"tool" with no agent.
 */
export function agentTaskToSubTask(task, { id = null } = {}) {
    const t = normalizeAgentTask(task);
    const isTool = t.tool != null;
    return {
        id: id || t.id,
        type: isTool ? "tool" : "agent",
        agent: isTool ? undefined : (KNOWN_AGENT_TYPES.includes(t.agent || "") ? t.agent : DEFAULT_AGENT),
        tool: isTool ? t.tool : undefined,
        goal: t.goal,
        content: (t.context && t.context.content) || t.goal,
        dependsOn: Array.isArray(t.context?.dependsOn) ? t.context.dependsOn : [],
        status: "pending",
    };
}

/** main-Graph subTask → AgentTask (for reflection/synthesis/delegation). */
export function subTaskToAgentTask(sub, { extra = {} } = {}) {
    if (!sub || typeof sub !== "object") throw codingError("INVALID_SUBTASK", "subTask is required", 400);
    const isTool = sub.type === "tool" || sub.tool != null;
    const agent = isTool ? null : (KNOWN_AGENT_TYPES.includes(sub.agent) ? sub.agent : DEFAULT_AGENT);
    return createAgentTask({
        id: sub.id ?? sub.subTaskId ?? "sub",
        goal: sub.goal ?? sub.content ?? "",
        agent,
        tool: isTool ? (sub.tool ?? sub.toolName ?? null) : null,
        input: sub.input ?? {},
        context: { content: sub.content, dependsOn: sub.dependsOn },
        kind: "subtask",
        status: sub.status ?? "pending",
        meta: { source: "planner", ...extra },
    });
}

/**
 * AgentTask → LangGraph `Send` *spec*. The spec is a plain object so the module
 * stays protocol/library-neutral; the main Graph maps it to a real `Send` in its
 * fan-out helpers. `payload` spreads the incoming graph state and pins the task's
 * current subTask id, matching how planner fan-out nodes read `subTasks`/state.
 */
export function agentTaskToSendSpec(task, { node = null, state = {} } = {}) {
    const t = normalizeAgentTask(task);
    const nodeName = node || (KNOWN_AGENT_TYPES.includes(t.agent || "")
        ? `${t.agent}_agent`
        : t.agent === "tool" || t.tool
            ? "tool_executor"
            : "general_chat");
    return {
        node: nodeName,
        payload: {
            ...(state && typeof state === "object" ? state : {}),
            currentSubTask: t.id,
            userInput: t.goal,
            taskContext: t.context || {},
        },
    };
}

export default {
    TASK_KINDS, TASK_STATUS, EFFECT_TYPES, KNOWN_AGENT_TYPES,
    createAgentTask, normalizeAgentTask, isAgentTask, canEffect, capabilitySubset,
    agentTaskToSubTask, subTaskToAgentTask, agentTaskToSendSpec,
};
