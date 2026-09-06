/**
 * Phase 7 / R5 (roadmap #7) — A2A task model tests (a2a/task.test.js).
 *
 * Pure-function proof for the internal A2A task record: internal/wire status
 * vocabularies, legal transition machine (terminal states immutable), artifact
 * and message append with caps/truncation, and the secret-free sanitize view.
 * No flags / DB / network.
 */
import { describe, expect, it } from "vitest";
import {
    A2A_TASK_STATUS,
    A2A_WIRE_STATUS,
    toWireStatus,
    fromWireStatus,
    ALLOWED_TRANSITIONS,
    transitionTask,
    createA2ATask,
    addArtifact,
    addMessage,
    sanitizeTask,
} from "./task.js";

function sample(overrides = {}) {
    return createA2ATask({ id: "a2a_test_1", agent: "local-status", goal: "ping", ...overrides });
}

describe("createA2ATask — shape + cleanup", () => {
    it("assigns a random uuid id when omitted and pins kind", () => {
        const task = createA2ATask({});
        expect(task.id).toBeTruthy();
        expect(task.kind).toBe("a2a.task");
        expect(task.status).toBe("created");
        expect(task.artifacts).toEqual([]);
        expect(task.messages).toEqual([]);
    });

    it("cleans strings and strips control bytes from goal/agent/id", () => {
        const task = createA2ATask({
            id: "x".repeat(300),
            agent: "  local-status  ",
            goal: "go\u0000al\nnext",
            runId: "r\u00001",
        });
        expect(task.id).toHaveLength(128);
        expect(task.agent).toBe("local-status");
        expect(task.goal).toBe("goal\nnext");
        expect(task.runId).toBe("r1");
    });

    it("deep-cleans input so credential-like keys never survive at any depth", () => {
        const task = createA2ATask({
            id: "t-secret",
            input: {
                question: "q",
                apiKey: "sk-live",
                nested: { password: "hunter2", note: "keep", tokens: ["a"] },
                ok: [{ secret_token: "x" }, "fine"],
                date: new Date("2026-01-01T00:00:00Z"),
            },
        });
        expect(task.input.question).toBe("q");
        expect(task.input.apiKey).toBeUndefined();
        expect(task.input.nested).toEqual({ note: "keep" });
        expect(task.input.ok).toEqual(["fine"]);
        expect(task.input.date).toBe("2026-01-01T00:00:00.000Z");
    });

    it("intersects capability with the known effects/agents vocabularies", () => {
        const task = createA2ATask({
            id: "t-cap",
            capability: { effects: ["read", "teleport", "write"], agents: ["knowledge", "skynet"] },
        });
        expect(task.capability.effects).toEqual(["read", "write"]);
        expect(task.capability.agents).toEqual(["knowledge"]);
        expect(task.capability.effects).toEqual(task.capability.effects.filter((e) => ["read", "write", "exec", "network", "external"].includes(e)));
    });

    it("defaults capability to an empty surface", () => {
        const task = createA2ATask({ id: "t-empty" });
        expect(task.capability).toEqual({ effects: [], agents: [] });
    });
});

describe("status vocabularies — internal ↔ wire", () => {
    it("internal statuses mirror the AgentTask set exactly", () => {
        expect(A2A_TASK_STATUS).toEqual([
            "created", "queued", "running", "waiting_input", "succeeded", "failed", "cancelled",
        ]);
    });

    it("maps internal → wire statuses", () => {
        expect(A2A_WIRE_STATUS.created).toBe("created");
        expect(toWireStatus("queued")).toBe("working");
        expect(toWireStatus("running")).toBe("working");
        expect(toWireStatus("waiting_input")).toBe("input-required");
        expect(toWireStatus("succeeded")).toBe("completed");
        expect(toWireStatus("failed")).toBe("failed");
        expect(toWireStatus("cancelled")).toBe("canceled");
        expect(toWireStatus("bogus")).toBe("unknown");
    });

    it("maps wire → internal statuses, unknown → created", () => {
        expect(fromWireStatus("completed")).toBe("succeeded");
        expect(fromWireStatus("canceled")).toBe("cancelled");
        expect(fromWireStatus("working")).toBe("running");
        expect(fromWireStatus("input-required")).toBe("waiting_input");
        expect(fromWireStatus("created")).toBe("created");
        expect(fromWireStatus("failed")).toBe("failed");
        expect(fromWireStatus("wat")).toBe("created");
        expect(fromWireStatus(undefined)).toBe("created");
    });
});

describe("transitionTask — legal transitions only", () => {
    it("exposes the allowed-transition table with terminal states immutable", () => {
        expect(ALLOWED_TRANSITIONS.created).toEqual(["queued", "cancelled"]);
        expect(ALLOWED_TRANSITIONS.queued).toEqual(["running", "cancelled"]);
        expect(ALLOWED_TRANSITIONS.running).toEqual(["succeeded", "failed", "cancelled", "waiting_input"]);
        expect(ALLOWED_TRANSITIONS.waiting_input).toEqual(["running", "cancelled"]);
        expect(ALLOWED_TRANSITIONS.succeeded).toEqual([]);
        expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
        expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    });

    it("advances through a legal run and bumps updatedAt", () => {
        let task = createA2ATask({ id: "t-run" });
        const t0 = task.updatedAt;
        task = transitionTask(task, "queued", { at: "2026-01-01T00:00:01Z" });
        task = transitionTask(task, "running", { at: "2026-01-01T00:00:02Z" });
        task = transitionTask(task, "succeeded", { at: "2026-01-01T00:00:03Z" });
        expect(task.status).toBe("succeeded");
        expect(task.updatedAt).toBe("2026-01-01T00:00:03Z");
        expect(task.updatedAt).not.toBe(t0);
    });

    it("throws INVALID_TASK_TRANSITION for an illegal step", () => {
        const task = createA2ATask({ id: "t-illegal" });
        expect(() => transitionTask(task, "succeeded")).toThrowError(
            expect.objectContaining({ code: "INVALID_TASK_TRANSITION", statusCode: 409 }),
        );
        expect(() => transitionTask(task, "flying")).toThrowError(
            expect.objectContaining({ code: "INVALID_TASK_TRANSITION" }),
        );
    });

    it("refuses to mutate a terminal task", () => {
        const terminal = transitionTask(createA2ATask({ id: "t-term" }), "cancelled");
        expect(() => transitionTask(terminal, "queued")).toThrowError(
            expect.objectContaining({ code: "INVALID_TASK_TRANSITION" }),
        );
    });
});

describe("addArtifact — bounded, truncated", () => {
    it("appends an artifact with preview capped at 500 chars", () => {
        let task = sample();
        const long = "x".repeat(1200);
        task = addArtifact(task, { id: "a1", name: "outcome", uri: "https://x/y", contentPreview: long, bytes: 42 });
        expect(task.artifacts).toHaveLength(1);
        expect(task.artifacts[0].name).toBe("outcome");
        expect(task.artifacts[0].contentPreview).toHaveLength(500);
        expect(task.artifacts[0].bytes).toBe(42);
    });

    it("keeps at most 20 artifacts (drops oldest)", () => {
        let task = sample();
        for (let i = 0; i < 25; i += 1) task = addArtifact(task, { id: `a${i}`, name: `n${i}` });
        expect(task.artifacts).toHaveLength(20);
        expect(task.artifacts[0].name).toBe("n5");
        expect(task.artifacts[19].name).toBe("n24");
    });

    it("cleans the artifact name and leaves uri/mimeType optional", () => {
        const task = addArtifact(sample(), { id: "a2", name: "  o\u0000k  " });
        expect(task.artifacts[0].name).toBe("ok");
        expect(task.artifacts[0].uri).toBeUndefined();
    });
});

describe("addMessage — role-gated, bounded", () => {
    it("appends a message for role user|agent", () => {
        let task = sample();
        task = addMessage(task, { role: "user", parts: ["who are you?"] });
        task = addMessage(task, { role: "agent", parts: ["local-status"] });
        expect(task.messages).toHaveLength(2);
        expect(task.messages[0].role).toBe("user");
        expect(task.messages[1].role).toBe("agent");
        expect(task.messages[0].messageId).toBeTruthy();
        expect(task.messages[0].at).toBeTruthy();
    });

    it("throws INVALID_A2A_MESSAGE_ROLE for any other role", () => {
        expect(() => addMessage(sample(), { role: "system", parts: [] })).toThrowError(
            expect.objectContaining({ code: "INVALID_A2A_MESSAGE_ROLE", statusCode: 400 }),
        );
    });

    it("sanitises parts (control chars stripped, credential keys dropped)", () => {
        const task = addMessage(sample(), { role: "user", parts: ["a\u0000b", { text: "keep", secret: "nope" }] });
        expect(task.messages[0].parts).toEqual(["ab", { text: "keep" }]);
    });
});

describe("sanitizeTask — secret-free external view", () => {
    it("never leaks credential-like keys from input or failed-task errors", () => {
        let task = sample({ input: { apiKey: "sk-x", safe: { value: 1 }, nested: { token: "abc", name: "ok" } } });
        task = { ...task, error: { errorCode: "AGENT_EXECUTOR_UNAVAILABLE", message: "no secrets here" } };
        const view = sanitizeTask(task);
        expect(view.input).toEqual({ safe: { value: 1 }, nested: { name: "ok" } });
        expect(JSON.stringify(view)).not.toContain("sk-x");
        expect(JSON.stringify(view)).not.toContain("abc");
        expect(view.error).toEqual({ errorCode: "AGENT_EXECUTOR_UNAVAILABLE" });
    });

    it("truncates artifact previews and message parts to safe bounds", () => {
        let task = sample();
        task = addArtifact(task, { id: "a", name: "a", contentPreview: "y".repeat(900) });
        task = addMessage(task, { role: "agent", parts: ["z".repeat(9000)] });
        const view = sanitizeTask(task);
        expect(view.artifacts[0].contentPreview).toHaveLength(500);
        expect(view.messages[0].parts[0]).toHaveLength(4000);
    });

    it("is a pure copy — mutating the view does not touch the source", () => {
        const task = sample({ input: { keep: 1 } });
        const view = sanitizeTask(task);
        view.input.keep = 2;
        view.status = "failed";
        expect(task.input.keep).toBe(1);
        expect(task.status).toBe("created");
    });
});
