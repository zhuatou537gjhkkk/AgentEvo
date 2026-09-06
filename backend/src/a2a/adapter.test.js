/**
 * Phase 7 / R5 (roadmap #6/#7) — A2A adapter tests (a2a/adapter.test.js).
 *
 * Pure round-trip proof that the internal AgentTask is the canonical shape and
 * the A2A boundary converts to/from it (and to the LangGraph Send spec) without
 * touching any protocol internals. No flags / DB / network.
 */
import { describe, expect, it } from "vitest";
import { createAgentTask } from "../agenttask/agentTask.js";
import {
    agentTaskToA2ATask,
    a2aTaskToAgentTask,
    toLangGraphSendAdapter,
    agentTaskFromA2A,
} from "./adapter.js";
import { createA2ATask } from "./task.js";

const agentTask = () => createAgentTask({
    id: "main-1",
    goal: "look up project memory",
    agent: "knowledge",
    input: { topic: "rag" },
    capability: { effects: ["read"], agents: ["knowledge"] },
    parentTaskId: "parent-9",
});

describe("agentTaskToA2ATask — internal AgentTask → A2A task", () => {
    it("maps goal/agent/input/capability/parentTaskId and keeps the task id", () => {
        const a2a = agentTaskToA2ATask(agentTask());
        expect(a2a.kind).toBe("a2a.task");
        expect(a2a.id).toBe("main-1");
        expect(a2a.agent).toBe("knowledge");
        expect(a2a.goal).toBe("look up project memory");
        expect(a2a.input).toEqual({ topic: "rag" });
        expect(a2a.capability).toEqual({ effects: ["read"], agents: ["knowledge"] });
        expect(a2a.parentTaskId).toBe("parent-9");
        expect(a2a.status).toBe("created");
    });

    it("defaults an agent-less AgentTask to the general agent and honours taskId override", () => {
        const toolTask = createAgentTask({ id: "tool-1", tool: "web_search", goal: "g", context: {} });
        const a2a = agentTaskToA2ATask(toolTask, { taskId: "delegated-88" });
        expect(a2a.id).toBe("delegated-88");
        expect(a2a.agent).toBe("general");
    });
});

describe("a2aTaskToAgentTask — A2A task → internal AgentTask", () => {
    it("maps an internal-status A2A task back to an AgentTask preserving goal/agent/capability", () => {
        const a2a = createA2ATask({
            id: "a2a_1",
            agent: "knowledge",
            goal: "g",
            capability: { effects: ["read"], agents: ["knowledge"] },
            input: { topic: "rag" },
            parentTaskId: "p",
        });
        const task = a2aTaskToAgentTask(a2a);
        expect(task.id).toBe("a2a_1");
        expect(task.agent).toBe("knowledge");
        expect(task.goal).toBe("g");
        expect(task.capability).toEqual({ effects: ["read"], agents: ["knowledge"] });
        expect(task.meta.source).toBe("a2a");
    });

    it("maps a wire `completed` status to internal succeeded", () => {
        const wireTask = { id: "w1", goal: "g", status: "completed" };
        const task = a2aTaskToAgentTask(wireTask);
        expect(task.status).toBe("succeeded");
    });

    it("maps wire canceled/working to internal cancelled/running and unknown to created", () => {
        expect(a2aTaskToAgentTask({ id: "c1", status: "canceled" }).status).toBe("cancelled");
        expect(a2aTaskToAgentTask({ id: "c2", status: "working" }).status).toBe("running");
        expect(a2aTaskToAgentTask({ id: "c3", status: "mystery" }).status).toBe("created");
    });
});

describe("toLangGraphSendAdapter / agentTaskFromA2A", () => {
    it("re-exports the LangGraph Send spec (node + payload) from an AgentTask", () => {
        const spec = toLangGraphSendAdapter(agentTask(), { state: { conversationId: "cv" } });
        expect(spec.node).toBe("knowledge_agent");
        expect(spec.payload.conversationId).toBe("cv");
        expect(spec.payload.currentSubTask).toBe("main-1");
        expect(spec.payload.userInput).toBe("look up project memory");
        expect(spec.payload.taskContext).toEqual({});
    });

    it("builds a fresh AgentTask from A2A-like fields with a caller-chosen id", () => {
        const task = agentTaskFromA2A("fresh-1", {
            goal: "g",
            agent: "local-status",
            input: { x: 1 },
            capability: { effects: ["read"], agents: ["general"] },
        });
        expect(task.id).toBe("fresh-1");
        expect(task.agent).toBe("local-status");
        expect(task.tool).toBeNull();
        expect(task.goal).toBe("g");
        expect(task.capability.effects).toEqual(["read"]);
    });
});
