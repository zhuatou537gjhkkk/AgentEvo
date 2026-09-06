/**
 * Phase 7 / R5 (roadmap #6/#7) — keystone AgentTask coverage (agenttask/test).
 *
 * Pure-function proof for the canonical internal AgentTask: defaults/validation,
 * normalization from planner/tool subTask-ish inputs, capability narrowing vs
 * privilege refusal, and the three adapters this module owns — AgentTask→subTask,
 * subTask→AgentTask, and AgentTask→LangGraph-Send spec. A2A/ANP adapters live in
 * their own modules (a2a/adapter.js) but build on the same shapes tested here.
 * No flags / DB / network are involved.
 */
import { describe, expect, it } from "vitest";
import {
    createAgentTask,
    normalizeAgentTask,
    isAgentTask,
    canEffect,
    capabilitySubset,
    agentTaskToSubTask,
    subTaskToAgentTask,
    agentTaskToSendSpec,
    TASK_STATUS,
    TASK_KINDS,
    EFFECT_TYPES,
    KNOWN_AGENT_TYPES,
} from "./agentTask.js";

function sampleTask(overrides = {}) {
    return createAgentTask({
        id: "t-1",
        goal: "summarize docs",
        agent: "knowledge",
        input: { q: "x" },
        capability: { effects: ["read"], agents: ["knowledge", "general"] },
        ...overrides,
    });
}

describe("createAgentTask — defaults + validation", () => {
    it("throws AGENT_TASK_ID_REQUIRED when id is missing or blank", () => {
        expect(() => createAgentTask()).toThrowError(expect.objectContaining({ code: "AGENT_TASK_ID_REQUIRED" }));
        expect(() => createAgentTask({ id: "" })).toThrowError(expect.objectContaining({ code: "AGENT_TASK_ID_REQUIRED" }));
    });

    it("fills safe defaults for every optional field", () => {
        const task = createAgentTask({ id: "t0" });
        expect(task).toMatchObject({
            id: "t0",
            goal: "",
            agent: null,
            tool: null,
            input: {},
            capability: { effects: [], agents: [] },
            context: {},
            parentTaskId: null,
            maxRounds: null,
            mode: null,
            kind: "internal",
            status: "created",
            meta: {},
        });
    });

    it("drops unknown status/kind/effects/agents and clips overlong strings", () => {
        const task = createAgentTask({
            id: "x".repeat(500),
            goal: "line1\nline2\u0000ok",
            status: "nonsense",
            kind: "bogus",
            capability: { effects: ["read", "teleport"], agents: ["knowledge", "martian"] },
            maxRounds: -3,
        });
        expect(task.id).toHaveLength(128);
        expect(task.goal).toBe("line1\nline2ok");
        expect(task.status).toBe("created");
        expect(task.kind).toBe("internal");
        expect(task.capability.effects).toEqual(["read"]);
        expect(task.capability.agents).toEqual(["knowledge"]);
        expect(task.maxRounds).toBe(1);
    });

    it("keeps arbitrary agent/tool names (the adapters restrict them later)", () => {
        const task = createAgentTask({ id: "t-x", agent: "super-planner", tool: "calc", goal: "g" });
        expect(task.agent).toBe("super-planner");
        expect(task.tool).toBe("calc");
    });

    it("exports the frozen canonical vocabularies", () => {
        expect(TASK_STATUS).toContain("waiting_input");
        expect(TASK_KINDS).toEqual(expect.arrayContaining(["internal", "subtask", "delegated"]));
        expect(EFFECT_TYPES).toEqual(expect.arrayContaining(["read", "write", "exec", "network", "external"]));
        expect(KNOWN_AGENT_TYPES).toEqual(expect.arrayContaining(["search", "knowledge", "code", "general"]));
    });
});

describe("normalizeAgentTask — restore id / agent / tool aliases", () => {
    it("recovers id, tool and agent from subTask/taskId/toolName aliases", () => {
        const task = normalizeAgentTask({
            taskId: "run-42",
            toolName: "web_search",
            subTaskId: "ignored-because-taskId-wins",
            goal: "fetch the news",
        });
        expect(task.id).toBe("run-42");
        expect(task.tool).toBe("web_search");
        expect(task.goal).toBe("fetch the news");
    });

    it("falls back to subTaskId when taskId is absent", () => {
        const task = normalizeAgentTask({ subTaskId: "sub-7", goal: "g" });
        expect(task.id).toBe("sub-7");
    });

    it("keeps unknown fields under meta.extra and preserves meta", () => {
        const task = normalizeAgentTask({ id: "k1", goal: "g", sourceRun: "r1", depth: 2, meta: { label: "x" } });
        expect(task.meta.extra).toEqual({ sourceRun: "r1", depth: 2 });
        expect(task.meta.label).toBe("x");
    });

    it("normalizes a full AgentTask into an identical canonical task", () => {
        const original = sampleTask({ tool: null });
        const again = normalizeAgentTask(original);
        expect(again.id).toBe(original.id);
        expect(again.capability).toEqual(original.capability);
        expect(again.status).toBe("created");
    });

    it("handles a non-object input safely", () => {
        const task = normalizeAgentTask(null);
        expect(task.id).toBe("invalid");
    });
});

describe("isAgentTask / canEffect", () => {
    it("isAgentTask only accepts objects with a non-empty id", () => {
        expect(isAgentTask(sampleTask())).toBe(true);
        expect(isAgentTask({ goal: "x" })).toBe(false);
        expect(isAgentTask(null)).toBe(false);
        expect(isAgentTask("t-1")).toBe(false);
    });

    it("canEffect reports an effect already granted by the capability surface", () => {
        const read = sampleTask();
        expect(canEffect(read, "read")).toBe(true);
        expect(canEffect(read, "write")).toBe(false);
        expect(canEffect(createAgentTask({ id: "e" }), "read")).toBe(false);
    });
});

describe("capabilitySubset — narrow or refuse", () => {
    it("narrows agents/effects to the intersection of task capability and allow set", () => {
        const task = sampleTask({ capability: { effects: ["read", "write"], agents: ["search", "knowledge"] } });
        const narrowed = capabilitySubset(task, { effects: ["read", "write"], agents: ["search"] });
        expect(narrowed.capability.effects).toEqual(["read", "write"]);
        expect(narrowed.capability.agents).toEqual(["search"]);
        expect(narrowed.id).toBe("t-1");
    });

    it("is identity when the allow set is omitted", () => {
        const task = sampleTask({ capability: { effects: ["read"], agents: ["knowledge"] } });
        const result = capabilitySubset(task);
        expect(result.capability).toEqual({ effects: ["read"], agents: ["knowledge"] });
    });

    it("throws CAPABILITY_NOT_GRANTED when the task claims an effect outside the allow set", () => {
        const task = sampleTask({ capability: { effects: ["read", "write"], agents: [] } });
        expect(() => capabilitySubset(task, { effects: ["read"] })).toThrowError(
            expect.objectContaining({ code: "CAPABILITY_NOT_GRANTED", statusCode: 403 }),
        );
    });
});

describe("agentTaskToSubTask — internal AgentTask → planner subTask", () => {
    it("maps a tool task to type tool with the tool and no agent", () => {
        const task = createAgentTask({ id: "t-tool", goal: "run tool", tool: "web_search", context: {} });
        const sub = agentTaskToSubTask(task);
        expect(sub).toMatchObject({
            id: "t-tool",
            type: "tool",
            tool: "web_search",
            goal: "run tool",
            content: "run tool",
            status: "pending",
        });
        expect(sub.agent).toBeUndefined();
        expect(sub.dependsOn).toEqual([]);
    });

    it("uses context.content over goal for the subTask content field", () => {
        const task = createAgentTask({
            id: "t-ctx",
            goal: "goal-text",
            agent: "knowledge",
            context: { content: "rich-context", dependsOn: ["a"] },
        });
        const sub = agentTaskToSubTask(task);
        expect(sub.content).toBe("rich-context");
        expect(sub.dependsOn).toEqual(["a"]);
    });

    it("keeps a known agent type as agent", () => {
        const sub = agentTaskToSubTask(sampleTask({ id: "k" }));
        expect(sub.type).toBe("agent");
        expect(sub.agent).toBe("knowledge");
    });

    it("falls back an out-of-vocabulary agent to general", () => {
        const task = createAgentTask({ id: "u", agent: "super-agent", goal: "g" });
        const sub = agentTaskToSubTask(task);
        expect(sub.type).toBe("agent");
        expect(sub.agent).toBe("general");
    });
});

describe("subTaskToAgentTask — planner subTask → internal AgentTask", () => {
    it("round-trips an agent subTask back to an AgentTask with context", () => {
        const original = agentTaskToSubTask(sampleTask({ id: "round", context: { content: "c", dependsOn: ["d1"] } }));
        const task = subTaskToAgentTask(original);
        expect(task.id).toBe("round");
        expect(task.agent).toBe("knowledge");
        expect(task.tool).toBeNull();
        expect(task.goal).toBe("summarize docs");
        expect(task.context).toEqual({ content: "c", dependsOn: ["d1"] });
        expect(task.kind).toBe("subtask");
        expect(task.meta.source).toBe("planner");
    });

    it("restores a tool subTask as a tool task with no agent", () => {
        const sub = { id: "s-tool", type: "tool", tool: "get_system_time", goal: "time", content: "c" };
        const task = subTaskToAgentTask(sub);
        expect(task.id).toBe("s-tool");
        expect(task.tool).toBe("get_system_time");
        expect(task.agent).toBeNull();
        expect(task.context.content).toBe("c");
    });

    it("throws INVALID_SUBTASK for a non-object subTask", () => {
        expect(() => subTaskToAgentTask(null)).toThrowError(expect.objectContaining({ code: "INVALID_SUBTASK" }));
    });
});

describe("agentTaskToSendSpec — internal AgentTask → LangGraph Send spec", () => {
    it("routes a known agent to <agent>_agent and pins payload", () => {
        const task = sampleTask({ id: "send-1" });
        const spec = agentTaskToSendSpec(task);
        expect(spec.node).toBe("knowledge_agent");
        expect(spec.payload).toMatchObject({
            currentSubTask: "send-1",
            userInput: "summarize docs",
            taskContext: {},
        });
    });

    it("routes a tool task to tool_executor", () => {
        const task = createAgentTask({ id: "send-2", tool: "web_search", goal: "g" });
        expect(agentTaskToSendSpec(task).node).toBe("tool_executor");
    });

    it("routes an unknown no-tool agent to general_chat", () => {
        const task = createAgentTask({ id: "send-3", agent: "weird", goal: "g" });
        expect(agentTaskToSendSpec(task).node).toBe("general_chat");
    });

    it("honours an explicit node override and spreads incoming state", () => {
        const task = sampleTask({ id: "send-4" });
        const spec = agentTaskToSendSpec(task, { node: "custom_node", state: { conversationId: "c9" } });
        expect(spec.node).toBe("custom_node");
        expect(spec.payload.conversationId).toBe("c9");
        expect(spec.payload.currentSubTask).toBe("send-4");
    });
});
