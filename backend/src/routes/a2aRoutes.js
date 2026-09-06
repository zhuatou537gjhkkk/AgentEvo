/**
 * Phase 7 / R5 (roadmap #7/#8) — same-instance A2A HTTP surface (a2aRoutes.js).
 *
 * The controlled surface a caller (or the future main-Graph proxy node) uses to
 * delegate tasks to local trusted agent cards: card listing, task create/status,
 * cancel and attribution diagnostics. The whole tree is DEFAULT OFF — with
 * A2A_ENABLED unset every /a2a route answers 403 A2A_DISABLED; nothing here
 * touches the runtime while the flag is dark.
 *
 * The runtime is resolved per request: an injected dependency-bag service first
 * (createApp dependencies.services.a2aRuntime), else a lazy import() of the
 * sibling a2a/runtime.js defaultA2ARuntime singleton. Owner scope comes only
 * from the authenticated request (req.user / req.userId) — never the body.
 *
 * This registrar is intentionally NOT mounted from app.js yet (a controlled
 * proxy node mounts it when A2A_ENABLED); registerA2ARoutes is import-safe and
 * flag-dark safe so the seam can be wired up without changing app.js.
 */
import express from "express";
import { sendError, svcFn } from "./deps.js";
import { a2aEnabled } from "../extensibility/flags.js";
import { sanitizeCardForWire } from "../a2a/registry.js";

function disabledResponse(req, res) {
    return res.status(403).json({
        ok: false,
        error: "A2A_DISABLED",
        errorCode: "A2A_DISABLED",
        message: "a2a is disabled",
        retryable: false,
        requestId: req.requestId || null,
    });
}

function a2aGate(req, res, next) {
    if (!a2aEnabled()) return disabledResponse(req, res);
    return next();
}

/** Owner scope from server-authenticated identity only. */
function ownerScope(req) {
    const userId = Number(req?.userId ?? req?.user?.id ?? NaN);
    const tenantId = req?.tenantId ?? req?.user?.tenantId ?? (Number.isInteger(userId) && userId > 0 ? `user:${userId}` : "");
    return { userId, tenantId };
}

/** Resolve the runtime: injected bag service first, else the lazy singleton. */
async function runtimeFor(req) {
    try {
        const injected = svcFn(req, "a2aRuntime");
        if (injected) return injected;
    } catch {
        // absent bag dependency → fall through to the module singleton
    }
    const mod = await import("../a2a/runtime.js");
    return mod.defaultA2ARuntime;
}

export function registerA2ARoutes(router, { requireAuth }) {
    const a2a = express.Router();

    a2a.use(requireAuth);
    a2a.use(a2aGate);

    // GET /a2a/cards — server-declared local trusted cards (wire-safe view,
    // capabilities as-declared, trust always explicit).
    a2a.get("/cards", async (req, res) => {
        try {
            const runtime = await runtimeFor(req);
            const cards = runtime.listCards().map((card) => sanitizeCardForWire(card));
            return res.json({ ok: true, cards });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // POST /a2a/tasks — delegate a task body {agent, goal, input, capability}.
    // Delegation narrows capability to the card's declared subset.
    a2a.post("/tasks", async (req, res) => {
        try {
            const runtime = await runtimeFor(req);
            const body = req.body || {};
            const task = await runtime.delegateTask(ownerScope(req), {
                agent: body.agent,
                goal: body.goal,
                input: body.input || {},
                capability: {
                    effects: body.capability?.effects == null ? null : body.capability.effects,
                    agents: body.capability?.agents == null ? null : body.capability.agents,
                },
                requestId: req.requestId || null,
                runId: body.runId ?? body.run_id ?? null,
                timeoutMs: Number.isFinite(Number(body.timeoutMs)) ? Number(body.timeoutMs) : 15000,
            });
            return res.status(201).json({ ok: true, task });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // GET /a2a/tasks/:taskId — task state (owner-scoped).
    a2a.get("/tasks/:taskId", async (req, res) => {
        try {
            const runtime = await runtimeFor(req);
            const task = runtime.getTask(ownerScope(req), req.params.taskId);
            return res.json({ ok: true, task });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // POST /a2a/tasks/:taskId/cancel — cancel a queued/running task.
    a2a.post("/tasks/:taskId/cancel", async (req, res) => {
        try {
            const runtime = await runtimeFor(req);
            const task = runtime.cancelTask(ownerScope(req), req.params.taskId, {
                reason: req.body?.reason ?? null,
            });
            return res.json({ ok: true, task });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // GET /a2a/diagnostics/:taskId — attribution snapshot (requestId/runId/counts).
    a2a.get("/diagnostics/:taskId", async (req, res) => {
        try {
            const runtime = await runtimeFor(req);
            const diagnostics = runtime.taskDiagnostics(ownerScope(req), req.params.taskId);
            return res.json({ ok: true, diagnostics });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    router.use("/a2a", a2a);
}
