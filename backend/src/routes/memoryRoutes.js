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
        const { limit = 50, memory_type } = req.query;
        try {
            const memory = memoryFor(req);
            const memoryTypes = memory_type ? [memory_type] : null;
            if (req.query.query || memoryTypes) {
                const results = memory.search(req.query.query || "", memoryTypes, Number(limit), 0.1);
                return res.json({ memories: results, count: results.length });
            }
            const items = memory.summary(Number(limit));
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
