/**
 * Phase 7 / R5 (roadmap #7) — same-instance A2A runtime tests (a2a/runtime.test.js).
 *
 * Core executor proof for the local trusted A2A runtime. Everything DEFAULT OFF:
 * with A2A_ENABLED unset delegateTask answers 403 A2A_DISABLED. When enabled the
 * runtime narrows delegation to the card's declared capability subset, refuses
 * out-of-subset claims, runs deterministic injected executors (no LLM/network),
 * supports abort-aware cancellation, and scopes all state per owner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2ARuntime } from "./runtime.js";
import { createA2ARegistry, localTrustedCards } from "./registry.js";
import { clearExtensibilityFlags } from "../extensibility/flags.js";

const ALICE = { userId: 1, tenantId: "user:1" };
const BOB = { userId: 2, tenantId: "user:2" };

afterEach(() => {
    vi.restoreAllMocks();
    clearExtensibilityFlags();
});

function makeRuntime(cards = localTrustedCards()) {
    return new A2ARuntime({ registry: createA2ARegistry({ cards }) });
}

async function captureReject(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return null;
}

function enableA2A() {
    process.env.A2A_ENABLED = "1";
}

describe("feature gate — default OFF", () => {
    it("delegateTask answers 403 A2A_DISABLED while the flag is dark", async () => {
        const runtime = makeRuntime();
        const error = await captureReject(runtime.delegateTask(ALICE, { agent: "local-status", goal: "g" }));
        expect(error?.code).toBe("A2A_DISABLED");
        expect(error?.statusCode).toBe(403);
    });

    it("the module singleton exists and is flag-dark until enabled (methods gate at call time)", async () => {
        const { defaultA2ARuntime } = await import("./runtime.js");
        const error = await captureReject(defaultA2ARuntime.delegateTask(ALICE, { agent: "local-status" }));
        expect(error?.code).toBe("A2A_DISABLED");
    });
});

describe("delegation validation — cards, capability narrowing", () => {
    it("404 A2A_AGENT_NOT_FOUND for an unknown agent", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const error = await captureReject(runtime.delegateTask(ALICE, { agent: "ghost", goal: "g" }));
        expect(error?.code).toBe("A2A_AGENT_NOT_FOUND");
        expect(error?.statusCode).toBe(404);
    });

    it("403 A2A_AGENT_NO_CAPABILITY when the card declares nothing", async () => {
        enableA2A();
        const runtime = makeRuntime();
        runtime.registerCard({ name: "local-nothing", capabilities: { effects: [], agents: [] } });
        const error = await captureReject(runtime.delegateTask(ALICE, { agent: "local-nothing", goal: "g" }));
        expect(error?.code).toBe("A2A_AGENT_NO_CAPABILITY");
        expect(error?.statusCode).toBe(403);
    });

    it("403 CAPABILITY_NOT_GRANTED when the task claims a write effect a read-only card never grants", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const error = await captureReject(runtime.delegateTask(ALICE, {
            agent: "agent-evo-self",
            goal: "write something",
            capability: { effects: ["write"], agents: ["knowledge"] },
        }));
        expect(error?.code).toBe("CAPABILITY_NOT_GRANTED");
        expect(error?.statusCode).toBe(403);
    });

    it("403 AGENT_NOT_GRANTED when the task claims an agent type outside the card subset", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const error = await captureReject(runtime.delegateTask(ALICE, {
            agent: "agent-evo-self",
            goal: "code review",
            capability: { effects: ["read"], agents: ["code"] },
        }));
        expect(error?.code).toBe("AGENT_NOT_GRANTED");
        expect(error?.statusCode).toBe(403);
    });
});

describe("execution — default + injected executors", () => {
    it("runs the default local-status executor to succeeded and stores an artifact", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const task = await runtime.delegateTask(ALICE, {
            agent: "local-status",
            goal: "are you up?",
            capability: { effects: ["read"], agents: ["general"] },
        });
        expect(task.status).toBe("succeeded");
        expect(task.artifacts).toHaveLength(1);
        expect(task.artifacts[0].contentPreview).toContain("local-status (read-only) ok");
        expect(task.capability).toEqual({ effects: ["read"], agents: ["general"] });
    });

    it("executor missing (local-memory) → failed with AGENT_EXECUTOR_UNAVAILABLE", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const task = await runtime.delegateTask(ALICE, {
            agent: "local-memory",
            goal: "read project memory",
            capability: { effects: ["read"], agents: ["knowledge"] },
        });
        expect(task.status).toBe("failed");
        expect(task.error?.errorCode).toBe("AGENT_EXECUTOR_UNAVAILABLE");
    });

    it("runs an injected executor for a custom card and narrows capability before dispatch", async () => {
        enableA2A();
        const runtime = makeRuntime();
        runtime.registerCard({ name: "half-agent", capabilities: { effects: ["read", "write"], agents: ["general"] } });
        let seenTask = null;
        runtime.registerExecutor("half-agent", async ({ task, signal }) => {
            expect(signal).toBeTruthy();
            seenTask = task;
            return { artifact: { ok: true } };
        });
        const task = await runtime.delegateTask(ALICE, {
            agent: "half-agent",
            goal: "narrow me",
            capability: { effects: ["read"], agents: ["general"] },
        });
        expect(task.status).toBe("succeeded");
        // The executor only ever saw the read subset — never the card's write effect.
        expect(seenTask.capability.effects).toEqual(["read"]);
        expect(seenTask.agent).toBe("half-agent");
        expect(task.capability.effects).toEqual(["read"]);
    });

    it("times out a hung executor → failed A2A_EXECUTION_TIMEOUT", async () => {
        enableA2A();
        const runtime = makeRuntime();
        runtime.registerCard({ name: "slow-card", capabilities: { effects: ["read"], agents: ["general"] } });
        runtime.registerExecutor("slow-card", async () => new Promise(() => {}));
        const task = await runtime.delegateTask(ALICE, {
            agent: "slow-card",
            goal: "wait forever",
            timeoutMs: 5,
        });
        expect(task.status).toBe("failed");
        expect(task.error?.errorCode).toBe("A2A_EXECUTION_TIMEOUT");
    });
});

describe("cancel — abort-aware, immutable terminals", () => {
    it("cancels a running task and the executor observes the abort signal", async () => {
        enableA2A();
        const runtime = makeRuntime();
        runtime.registerCard({ name: "block-agent", capabilities: { effects: ["read"], agents: ["general"] } });
        let seenSignal = null;
        runtime.registerExecutor("block-agent", async ({ task, signal }) => {
            seenSignal = signal;
            await new Promise((resolve) => {
                if (signal.aborted) return resolve();
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return { artifact: { late: true } };
        });
        const pending = runtime.delegateTask(ALICE, { agent: "block-agent", goal: "hold", capability: { effects: ["read"], agents: ["general"] } });
        const running = runtime.listTasks(ALICE)[0];
        expect(running.status).toBe("running");
        // Let the executor actually start (microtask) so it has captured its signal.
        await new Promise((resolve) => setImmediate(resolve));
        expect(seenSignal).not.toBeNull();

        const cancelled = runtime.cancelTask(ALICE, running.id, { reason: "user stopped" });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.meta?.cancelReason).toBe("user stopped");
        expect(seenSignal.aborted).toBe(true);

        const finalTask = await pending;
        expect(finalTask.status).toBe("cancelled");
    });

    it("409 INVALID_TASK_TRANSITION when cancelling a terminal task", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const task = await runtime.delegateTask(ALICE, { agent: "local-status", goal: "done" });
        expect(task.status).toBe("succeeded");
        let error = null;
        try {
            runtime.cancelTask(ALICE, task.id);
        } catch (e) {
            error = e;
        }
        expect(error?.code).toBe("INVALID_TASK_TRANSITION");
        expect(error?.statusCode).toBe(409);
    });

    it("404 A2A_TASK_NOT_FOUND when cancelling an unknown task", () => {
        enableA2A();
        const runtime = makeRuntime();
        expect(() => runtime.cancelTask(ALICE, "a2a_missing")).toThrowError(
            expect.objectContaining({ code: "A2A_TASK_NOT_FOUND", statusCode: 404 }),
        );
    });
});

describe("owner scoping — read isolation", () => {
    it("getTask returns the owner's sanitized task or throws A2A_TASK_NOT_FOUND", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const created = await runtime.delegateTask(ALICE, { agent: "local-status", goal: "g" });
        const fetched = runtime.getTask(ALICE, created.id);
        expect(fetched.id).toBe(created.id);
        expect(fetched.status).toBe("succeeded");
        expect(() => runtime.getTask(ALICE, "a2a_nope")).toThrowError(
            expect.objectContaining({ code: "A2A_TASK_NOT_FOUND" }),
        );
    });

    it("BOB cannot see or touch ALICE's tasks", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const aliceTask = await runtime.delegateTask(ALICE, { agent: "local-status", goal: "alice" });
        expect(runtime.listTasks(ALICE)).toHaveLength(1);
        expect(runtime.listTasks(BOB)).toEqual([]);
        expect(() => runtime.getTask(BOB, aliceTask.id)).toThrowError(
            expect.objectContaining({ code: "A2A_TASK_NOT_FOUND" }),
        );
        expect(() => runtime.cancelTask(BOB, aliceTask.id)).toThrowError(
            expect.objectContaining({ code: "A2A_TASK_NOT_FOUND" }),
        );
        expect(() => runtime.taskDiagnostics(BOB, aliceTask.id)).toThrowError(
            expect.objectContaining({ code: "A2A_TASK_NOT_FOUND" }),
        );
    });

    it("listTasks honours limit and orders newest first", async () => {
        enableA2A();
        const runtime = makeRuntime();
        await runtime.delegateTask(ALICE, { agent: "local-status", goal: "first" });
        const second = await runtime.delegateTask(ALICE, { agent: "local-status", goal: "second" });
        const all = runtime.listTasks(ALICE);
        expect(all).toHaveLength(2);
        expect(all[0].goal).toBe("second");
        expect(all[1].goal).toBe("first");
        expect(runtime.listTasks(ALICE, { limit: 1 })).toHaveLength(1);
        expect(second.id).toBeTruthy();
    });
});

describe("hygiene + diagnostics", () => {
    it("never leaks credential-like keys from input on the returned task", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const task = await runtime.delegateTask(ALICE, {
            agent: "local-status",
            goal: "safe",
            input: { apiKey: "sk-live", nested: { password: "hunter2", keep: 1 }, plain: "ok" },
        });
        expect(task.input.apiKey).toBeUndefined();
        expect(task.input.nested).toEqual({ keep: 1 });
        expect(task.input.plain).toBe("ok");
        expect(JSON.stringify(task)).not.toContain("sk-live");
        expect(JSON.stringify(task)).not.toContain("hunter2");
    });

    it("emits a secret-free [a2a] console line when a runId is provided", async () => {
        enableA2A();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const runtime = makeRuntime();
        const task = await runtime.delegateTask(ALICE, {
            agent: "local-status",
            goal: "audited",
            runId: "run_42",
        });
        expect(task.status).toBe("succeeded");
        expect(task.runId).toBe("run_42");
        expect(log.mock.calls.some((args) => String(args[0]).includes("[a2a]"))).toBe(true);
        expect(log.mock.calls.every((args) => !String(args[0]).toLowerCase().includes("secret"))).toBe(true);
    });

    it("taskDiagnostics exposes attribution fields and the transition count", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const created = await runtime.delegateTask(ALICE, {
            agent: "local-status",
            goal: "diag",
            requestId: "req_1",
            runId: "run_1",
        });
        const diag = runtime.taskDiagnostics(ALICE, created.id);
        expect(diag.taskId).toBe(created.id);
        expect(diag.agent).toBe("local-status");
        expect(diag.status).toBe("succeeded");
        expect(diag.wireStatus).toBe("completed");
        expect(diag.requestId).toBe("req_1");
        expect(diag.runId).toBe("run_1");
        expect(diag.createdAt).toBeTruthy();
        expect(diag.updatedAt).toBeTruthy();
        // three transitions: created→queued, queued→running, running→succeeded
        expect(diag.transitionCount).toBe(3);
    });

    it("registers/inspects executors and rejects non-function executors", () => {
        const runtime = makeRuntime();
        runtime.registerExecutor("local-status", async () => ({ artifact: { ok: true } }));
        expect(runtime.listExecutors()).toContain("local-status");
        expect(() => runtime.registerExecutor("x", "not-a-fn")).toThrowError(
            expect.objectContaining({ code: "INVALID_EXECUTOR", statusCode: 400 }),
        );
        expect(() => runtime.registerExecutor("", () => {})).toThrowError(
            expect.objectContaining({ code: "INVALID_EXECUTOR" }),
        );
    });

    it("requires an owner scope on every owner-scoped method", async () => {
        enableA2A();
        const runtime = makeRuntime();
        const error = await captureReject(runtime.delegateTask({}, { agent: "local-status" }));
        expect(error?.code).toBe("INVALID_CODING_SCOPE");
        expect(() => runtime.listTasks({})).toThrowError(
            expect.objectContaining({ code: "INVALID_CODING_SCOPE" }),
        );
    });
});
