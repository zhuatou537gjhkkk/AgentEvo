/**
 * Phase 7 / R5 (roadmap #7/#8) — A2A HTTP contract (routes/a2aRoutes.test.js).
 *
 * Mounts registerA2ARoutes on a fresh express app with a stubbed requireAuth
 * (injects req.userId/tenantId/requestId from headers) and an injected a2a
 * runtime in the dependency bag — no real express-app services beyond that, no
 * DB, no network. Everything is DEFAULT OFF: with A2A_ENABLED unset the whole
 * /a2a tree is 403 A2A_DISABLED (and 401 without an identity header). When ON
 * the routes delegate to the injected runtime's deterministic executors.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import express from "express";
import { registerA2ARoutes } from "./a2aRoutes.js";
import { A2ARuntime } from "../a2a/runtime.js";
import { createA2ARegistry, localTrustedCards } from "../a2a/registry.js";
import { clearExtensibilityFlags } from "../extensibility/flags.js";

const servers = [];

afterEach(async () => {
    clearExtensibilityFlags();
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
});

function userScope(userId) {
    return { userId, tenantId: `user:${userId}` };
}

/** Stub auth: real identity comes only from the server-authenticated header. */
function stubAuth(req, res, next) {
    const raw = req.headers["x-user-id"];
    if (!raw) {
        return res.status(401).json({
            ok: false,
            error: "UNAUTHORIZED",
            errorCode: "UNAUTHORIZED",
            message: "unauthorized",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    const id = Number(raw);
    req.userId = id;
    req.tenantId = `user:${id}`;
    req.requestId = String(req.headers["x-request-id"] || "").trim() || `req-${id}`;
    return next();
}

function buildApp(runtime) {
    const app = express();
    app.locals.dependencies = { services: { a2aRuntime: runtime } };
    app.use(express.json({ limit: "1mb" }));
    const router = express.Router();
    registerA2ARoutes(router, { requireAuth: stubAuth });
    app.use(router);
    return app;
}

async function open(app) {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

function headers(userId, extra = {}) {
    const headersObj = { "x-user-id": String(userId), "Content-Type": "application/json" };
    return { ...headersObj, ...extra };
}

async function get(base, path, userId) {
    const response = await fetch(`${base}${path}`, { headers: headers(userId) });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body };
}

async function post(base, path, userId, body) {
    const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: headers(userId),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body: json, text };
}

function makeRuntime() {
    const runtime = new A2ARuntime({ registry: createA2ARegistry({ cards: localTrustedCards() }) });
    runtime.registerCard({ name: "route-echo", capabilities: { effects: ["read"], agents: ["general"] } });
    runtime.registerExecutor("route-echo", async ({ task }) => ({
        artifact: { ok: true, echo: task.input?.echo ?? null },
    }));
    return runtime;
}

describe("A2A HTTP — default dark (A2A_ENABLED off)", () => {
    let runtime;
    beforeEach(() => {
        runtime = makeRuntime();
    });

    it("401 without an identity header on /a2a", async () => {
        const app = buildApp(runtime);
        const base = await open(app);
        const response = await fetch(`${base}/a2a/cards`);
        expect(response.status).toBe(401);
        // with an identity header the gate decides (403 while dark)
        const cards = await get(base, "/a2a/cards", 1);
        expect(cards.status).toBe(403);
        expect(cards.body.errorCode).toBe("A2A_DISABLED");
    });

    it("flags off → every /a2a route answers 403 A2A_DISABLED", async () => {
        const app = buildApp(runtime);
        const base = await open(app);
        const cards = await get(base, "/a2a/cards", 1);
        expect(cards.status).toBe(403);
        expect(cards.body.errorCode).toBe("A2A_DISABLED");
        expect(cards.body.retryable).toBe(false);

        const create = await post(base, "/a2a/tasks", 1, { agent: "route-echo", goal: "g" });
        expect(create.status).toBe(403);
        expect(create.body.errorCode).toBe("A2A_DISABLED");

        const cancel = await post(base, "/a2a/tasks/a2a_x/cancel", 1, {});
        expect(cancel.status).toBe(403);
        expect(cancel.body.errorCode).toBe("A2A_DISABLED");
    });
});

describe("A2A HTTP — enabled with injected runtime", () => {
    let runtime;
    let base;
    let app;

    beforeEach(async () => {
        process.env.A2A_ENABLED = "1";
        runtime = makeRuntime();
        app = buildApp(runtime);
        base = await open(app);
    });

    it("GET /a2a/cards lists the local trusted cards (no extra payload)", async () => {
        const response = await get(base, "/a2a/cards", 1);
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        const names = response.body.cards.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(["agent-evo-self", "local-status", "local-memory", "route-echo"]));
        const byName = Object.fromEntries(response.body.cards.map((c) => [c.name, c]));
        for (const local of ["agent-evo-self", "local-status", "local-memory"]) {
            expect(byName[local].trust).toBe("explicit");
        }
        for (const card of response.body.cards) {
            expect(card.extra).toBeUndefined();
        }
    });

    it("POST /a2a/tasks delegates and returns 201 with a completed task", async () => {
        const response = await post(base, "/a2a/tasks", 7, {
            agent: "route-echo",
            goal: "echo me",
            input: { echo: "hello-a2a" },
            capability: { effects: ["read"], agents: ["general"] },
        });
        expect(response.status).toBe(201);
        expect(response.body.ok).toBe(true);
        expect(response.body.task.status).toBe("succeeded");
        expect(response.body.task.agent).toBe("route-echo");
        expect(response.body.task.goal).toBe("echo me");
        expect(response.body.task.artifacts[0].contentPreview).toContain("hello-a2a");
        expect(response.body.task.requestId).toBeTruthy();
    });

    it("GET /a2a/tasks/:taskId returns the task; unknown id → 404 A2A_TASK_NOT_FOUND", async () => {
        const created = await post(base, "/a2a/tasks", 7, { agent: "route-echo", goal: "g" });
        const fetched = await get(base, `/a2a/tasks/${created.body.task.id}`, 7);
        expect(fetched.status).toBe(200);
        expect(fetched.body.task.id).toBe(created.body.task.id);
        expect(fetched.body.task.status).toBe("succeeded");

        const missing = await get(base, "/a2a/tasks/a2a_does_not_exist", 7);
        expect(missing.status).toBe(404);
        expect(missing.body.errorCode).toBe("A2A_TASK_NOT_FOUND");
    });

    it("POST /a2a/tasks rejects a capability outside the card subset → 403 CAPABILITY_NOT_GRANTED", async () => {
        const response = await post(base, "/a2a/tasks", 7, {
            agent: "agent-evo-self",
            goal: "take over",
            capability: { effects: ["write"], agents: ["knowledge"] },
        });
        expect(response.status).toBe(403);
        expect(response.body.errorCode).toBe("CAPABILITY_NOT_GRANTED");
    });

    it("POST /a2a/tasks with an unknown agent → 404 A2A_AGENT_NOT_FOUND", async () => {
        const response = await post(base, "/a2a/tasks", 7, { agent: "ghost", goal: "g" });
        expect(response.status).toBe(404);
        expect(response.body.errorCode).toBe("A2A_AGENT_NOT_FOUND");
    });

    it("POST /a2a/tasks/:taskId/cancel cancels a running task", async () => {
        // Seed a running task through the real runtime with a blocking executor.
        runtime.registerCard({ name: "route-block", capabilities: { effects: ["read"], agents: ["general"] } });
        runtime.registerExecutor("route-block", async ({ task, signal }) => {
            await new Promise((resolve) => {
                if (signal.aborted) return resolve();
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return { artifact: { stopped: true } };
        });
        const seeded = runtime.delegateTask(userScope(7), {
            agent: "route-block",
            goal: "hold",
            capability: { effects: ["read"], agents: ["general"] },
        });
        const running = runtime.listTasks(userScope(7)).find((t) => t.agent === "route-block");
        expect(running.status).toBe("running");

        const cancelled = await post(base, `/a2a/tasks/${running.id}/cancel`, 7, { reason: "user abort" });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.ok).toBe(true);
        expect(cancelled.body.task.status).toBe("cancelled");
        expect(cancelled.body.task.meta?.cancelReason).toBe("user abort");
        await seeded;
    });

    it("cancel of a terminal (succeeded) task → 409 INVALID_TASK_TRANSITION", async () => {
        const created = await post(base, "/a2a/tasks", 7, { agent: "route-echo", goal: "g" });
        const response = await post(base, `/a2a/tasks/${created.body.task.id}/cancel`, 7, {});
        expect(response.status).toBe(409);
        expect(response.body.errorCode).toBe("INVALID_TASK_TRANSITION");
    });

    it("cancel of an unknown task → 404 A2A_TASK_NOT_FOUND", async () => {
        const response = await post(base, "/a2a/tasks/a2a_ghost/cancel", 7, {});
        expect(response.status).toBe(404);
        expect(response.body.errorCode).toBe("A2A_TASK_NOT_FOUND");
    });

    it("GET /a2a/diagnostics/:taskId reports attribution fields", async () => {
        const created = await post(base, "/a2a/tasks", 7, {
            agent: "route-echo",
            goal: "diag",
            runId: "run-http-1",
        });
        const response = await get(base, `/a2a/diagnostics/${created.body.task.id}`, 7);
        expect(response.status).toBe(200);
        expect(response.body.diagnostics).toMatchObject({
            taskId: created.body.task.id,
            agent: "route-echo",
            status: "succeeded",
            wireStatus: "completed",
            runId: "run-http-1",
        });
        expect(response.body.diagnostics.transitionCount).toBe(3);
    });
});
