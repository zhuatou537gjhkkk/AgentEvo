import { toErrorEnvelope } from "../services/resilience.js";

function dependency(req, name) {
    const db = req.locals?.dependencies?.db || req.app?.locals?.dependencies?.db;
    const fn = db?.[name];
    if (typeof fn !== "function") {
        throw Object.assign(new Error(`missing dependency: db.${name}`), {
            code: "DEPENDENCY_UNAVAILABLE",
            statusCode: 503,
        });
    }
    return fn;
}

function invalidSession(res, requestId) {
    return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), {
        code: "INVALID_SESSION",
        statusCode: 400,
    }), requestId));
}

/**
 * Incremental core registrar used by createApp(). The legacy singleton keeps
 * the remaining routes; these session/auth read paths are registered directly
 * on each factory instance and therefore consume its dependency bag.
 */
export function registerCoreRoutes(router, { requireAuth }) {
    router.get("/ping", (req, res) => res.json({ ok: true, message: "pong", time: new Date().toISOString() }));
    router.get("/auth/me", requireAuth, (req, res) => res.json({ ok: true, user: req.user }));

    router.get("/sessions", requireAuth, (req, res) => {
        const sessions = dependency(req, "getSessions")(req.user.id);
        return res.json({ ok: true, sessions });
    });

    router.post("/sessions", requireAuth, (req, res) => {
        const title = req.body?.title || "新对话";
        const id = dependency(req, "createSession")(req.user.id, title);
        return res.json({ ok: true, id });
    });

    router.patch("/sessions/:id", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalidSession(res, req.requestId);
        const title = String(req.body?.title || "").trim();
        if (!title) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("title is required"), {
                code: "INVALID_TITLE",
                statusCode: 400,
            }), req.requestId));
        }
        const result = dependency(req, "renameSession")(req.user.id, sessionId, title);
        if (!result?.changes) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), {
                code: "SESSION_NOT_FOUND",
                statusCode: 404,
            }), req.requestId));
        }
        return res.json({ ok: true });
    });

    router.delete("/sessions/:id", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalidSession(res, req.requestId);
        const result = dependency(req, "removeSession")(req.user.id, sessionId);
        if (!result?.changes) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), {
                code: "SESSION_NOT_FOUND",
                statusCode: 404,
            }), req.requestId));
        }
        return res.json({ ok: true });
    });

    router.patch("/sessions/:id/pin", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalidSession(res, req.requestId);
        const result = dependency(req, "toggleSessionPin")(req.user.id, sessionId, Boolean(req.body?.pinned));
        if (!result?.changes) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), {
                code: "SESSION_NOT_FOUND",
                statusCode: 404,
            }), req.requestId));
        }
        return res.json({ ok: true });
    });

    router.get("/sessions/:id/messages", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalidSession(res, req.requestId);
        const messages = dependency(req, "getHistoryMessages")(req.user.id, sessionId, 100);
        return res.json({ ok: true, messages });
    });
}
