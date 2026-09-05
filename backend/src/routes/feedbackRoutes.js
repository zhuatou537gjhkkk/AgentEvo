import { toErrorEnvelope } from "../services/resilience.js";

function dependency(req, name) {
    const db = req.locals?.dependencies?.db || req.app?.locals?.dependencies?.db;
    const fn = db?.[name];
    if (typeof fn !== "function") {
        throw Object.assign(new Error(`missing dependency: db.${name}`), { code: "DEPENDENCY_UNAVAILABLE", statusCode: 503 });
    }
    return fn;
}

function invalid(req, res, message = "message_id and rating are required") {
    return res.status(400).json(toErrorEnvelope(Object.assign(new Error(message), {
        code: "INVALID_ARGUMENT", statusCode: 400,
    }), req.requestId));
}

export function registerFeedbackRoutes(router, { requireAuth }) {
    router.post("/chat/feedback", requireAuth, (req, res) => {
        const { message_id, rating, comment } = req.body || {};
        const messageId = Number(message_id);
        if (!messageId) return invalid(req, res, "message_id is required");
        if (rating !== null && rating !== undefined && !["thumbs_up", "thumbs_down"].includes(rating)) {
            return invalid(req, res);
        }
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        try {
            if (rating === null || rating === undefined) {
                dependency(req, "deleteFeedback")(req.user.id, messageId, scope);
                return res.json({ ok: true, rating: null });
            }
            const existing = dependency(req, "getFeedbackByMessage")(req.user.id, messageId, scope);
            if (existing && existing.rating === rating) {
                dependency(req, "deleteFeedback")(req.user.id, messageId, scope);
                return res.json({ ok: true, rating: null });
            }
            dependency(req, "saveFeedback")(req.user.id, messageId, rating, comment || null, scope);
            return res.json({ ok: true, rating });
        } catch {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("feedback request failed"), {
                code: "REQUEST_FAILED", statusCode: 500,
            }), req.requestId));
        }
    });
}
