import { svcFn, sendError } from "./deps.js";

function memoryFor(req) {
    return svcFn(req, "createMemoryService")(req.user.id);
}

/**
 * Memory CRUD is per-user. The registrar creates a scoped MemoryService via the
 * injectable `createMemoryService` factory so factory instances can verify the
 * service is always bound to the authenticated user (two-user isolation).
 */
export function registerMemoryRoutes(router, { requireAuth }) {
    router.get("/memory", requireAuth, (req, res) => {
        const { limit = 50, memory_type, status = "all" } = req.query;
        try {
            const memory = memoryFor(req);
            const memoryTypes = memory_type ? [memory_type] : null;
            const statuses = status === "all" || !status ? null : String(status).split(",").filter(Boolean);
            if (req.query.query || memoryTypes) {
                const results = memory.search(req.query.query || "", memoryTypes, Number(limit), 0.1, statuses || ["active", "pending", "rejected", "superseded", "invalidated"]);
                return res.json({ memories: results, count: results.length });
            }
            const items = typeof memory.list === "function"
                ? memory.list(Number(limit), statuses)
                : memory.summary(Number(limit));
            return res.json({ memories: items, count: items.length });
        } catch (error) {
            console.error("[memory] GET failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.get("/memory/stats", requireAuth, (req, res) => {
        try {
            return res.json(memoryFor(req).stats());
        } catch (error) {
            console.error("[memory] GET /stats failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.get("/memory/retention", requireAuth, (req, res) => {
        try {
            const result = memoryFor(req).retentionSweep({ dryRun: true });
            return res.json({ enabled: result.enabled, policy: result.policy });
        } catch (error) {
            console.error("[memory] GET /retention failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.post("/memory/retention/run", requireAuth, (req, res) => {
        try {
            const result = memoryFor(req).retentionSweep({ dryRun: Boolean(req.body?.dry_run) });
            return res.json(result);
        } catch (error) {
            console.error("[memory] POST /retention/run failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.get("/memory/export", requireAuth, (req, res) => {
        try {
            return res.json(memoryFor(req).exportData());
        } catch (error) {
            console.error("[memory] GET /export failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.post("/memory/batch", requireAuth, (req, res) => {
        try {
            const body = req.body || {};
            const result = memoryFor(req).batchTransition(body.ids, body.action, body.reason);
            if (result.errorCode) {
                return sendError(res, req.requestId, Object.assign(new Error("unsupported memory action"), {
                    statusCode: 400,
                    code: result.errorCode,
                }));
            }
            return res.json(result);
        } catch (error) {
            console.error("[memory] POST /batch failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.post("/memory/cleanup", requireAuth, (req, res) => {
        try {
            const result = memoryFor(req).cleanup(req.body?.ids, req.body?.confirm);
            if (result.errorCode) {
                return sendError(res, req.requestId, Object.assign(new Error("explicit confirmation required"), {
                    statusCode: 400,
                    code: result.errorCode,
                }));
            }
            return res.json(result);
        } catch (error) {
            console.error("[memory] POST /cleanup failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.get("/memory/:id/lineage", requireAuth, (req, res) => {
        try {
            const result = memoryFor(req).lineage(Number(req.params.id));
            if (!result) {
                return sendError(res, req.requestId, Object.assign(new Error("memory not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json(result);
        } catch (error) {
            console.error("[memory] GET /:id/lineage failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.delete("/memory/:id", requireAuth, (req, res) => {
        try {
            const deleted = memoryFor(req).remove(Number(req.params.id));
            if (!deleted) {
                return sendError(res, req.requestId, Object.assign(new Error("memory not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json({ ok: true });
        } catch (error) {
            console.error("[memory] DELETE /:id failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.patch("/memory/:id", requireAuth, (req, res) => {
        const memory = memoryFor(req);
        const id = Number(req.params.id);
        const body = req.body || {};
        try {
            let ok = false;
            if (body.action === "approve") ok = memory.approve(id);
            else if (body.action === "reject") ok = memory.reject(id, body.reason || "user_rejected");
            else if (body.action === "invalidate") ok = memory.invalidate(id, body.reason || "user_invalidated");
            else if (body.action === "restore") ok = memory.restore(id);
            else if (body.action === "update" || body.content || body.importance != null || body.memory_type || body.pinned != null || body.category || body.memory_key !== undefined) {
                ok = (typeof memory.edit === "function" ? memory.edit : memory.update).call(memory, id, {
                    content: body.content,
                    importance: body.importance,
                    memory_type: body.memory_type,
                    pinned: body.pinned,
                    category: body.category,
                    memory_key: body.memory_key,
                });
            } else {
                return sendError(res, req.requestId, Object.assign(new Error("unsupported memory action"), { code: "INVALID_MEMORY_ACTION", statusCode: 400 }));
            }
            if (!ok) {
                return sendError(res, req.requestId, Object.assign(new Error("memory not found"), { code: "NOT_FOUND", statusCode: 404 }));
            }
            return res.json({ ok: true });
        } catch (error) {
            console.error("[memory] PATCH failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.delete("/memory", requireAuth, (req, res) => {
        try {
            const deleted = memoryFor(req).forget("all");
            return res.json({ ok: true, deleted });
        } catch (error) {
            console.error("[memory] DELETE failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });

    router.post("/memory/consolidate", requireAuth, (req, res) => {
        const { from_type = "working", to_type = "episodic", importance_threshold = 0.7 } = req.body || {};
        try {
            const result = memoryFor(req).consolidate(from_type, to_type, importance_threshold);
            return res.json({ ok: true, ...result });
        } catch (error) {
            console.error("[memory] POST /consolidate failed:", error.message);
            return sendError(res, req.requestId, error);
        }
    });
}
