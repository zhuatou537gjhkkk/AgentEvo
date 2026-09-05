import { toErrorEnvelope } from "../services/resilience.js";
import { calculateContextUsage } from "../services/contextUsage.js";

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

function invalid(res, requestId, code, message) {
    return res.status(400).json(toErrorEnvelope(Object.assign(new Error(message), {
        code,
        statusCode: 400,
    }), requestId));
}

/**
 * Session extensions are registered per factory while the LLM summary service
 * remains injectable. The registrar does not start providers or mutate global
 * application state.
 */
export function registerSessionExtensionRoutes(router, { requireAuth, estimateTokens, resolveModelName, buildCompactionSummary }) {
    router.get("/sessions/:id/context-usage", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalid(res, req.requestId, "INVALID_SESSION", "invalid session id");
        try {
            const history = dependency(req, "getHistoryMessages")(req.user.id, sessionId, 200);
            const modelName = resolveModelName(false);
            return res.json({ ok: true, data: calculateContextUsage(history, modelName, sessionId) });
        } catch {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("context usage unavailable"), {
                code: "CONTEXT_USAGE_FAILED", statusCode: 500,
            }), req.requestId));
        }
    });

    router.post("/sessions/:id/compact", requireAuth, async (req, res) => {
        const sessionId = Number(req.params.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) return invalid(res, req.requestId, "INVALID_SESSION", "invalid session id");
        try {
            const history = dependency(req, "getHistoryMessages")(req.user.id, sessionId, 200);
            const keepRecent = 6;
            const messagesToCompact = history.slice(0, Math.max(0, history.length - keepRecent));
            if (messagesToCompact.length === 0) {
                return res.json({ ok: true, data: { summary: null, tokensSaved: 0, messageCount: 0, message: "没有需要压缩的消息" } });
            }
            if (typeof buildCompactionSummary !== "function") {
                throw Object.assign(new Error("compaction service unavailable"), { code: "DEPENDENCY_UNAVAILABLE", statusCode: 503 });
            }
            const conversationText = messagesToCompact
                .map((message) => `[${message.role === "user" ? "用户" : "助手"}]: ${message.content}`)
                .join("\n\n");
            const tokensBefore = messagesToCompact.reduce((sum, message) => sum + (message.metrics?.total_tokens || estimateTokens(String(message.content || ""))), 0);
            const summaryContent = String(await buildCompactionSummary(conversationText.slice(0, 12000), req) || "").trim();
            if (!summaryContent) throw Object.assign(new Error("summary unavailable"), { code: "LLM_FAILED", statusCode: 503 });
            const summaryTokens = estimateTokens(summaryContent);
            dependency(req, "saveMessage")(
                req.user.id,
                sessionId,
                "system",
                `[上下文压缩摘要 — ${new Date().toLocaleString("zh-CN")}]\n${summaryContent}`
            );
            return res.json({ ok: true, data: {
                summary: summaryContent,
                tokensSaved: Math.max(0, tokensBefore - summaryTokens),
                tokensBefore,
                summaryTokens,
                compactedMessages: messagesToCompact.length,
            } });
        } catch (error) {
            const statusCode = Number(error?.statusCode) || 500;
            return res.status(statusCode).json(toErrorEnvelope(Object.assign(new Error("context compaction failed"), {
                code: error?.code || "REQUEST_FAILED", statusCode,
            }), req.requestId));
        }
    });

    router.delete("/sessions/:id/messages/:messageId/pair", requireAuth, (req, res) => {
        const sessionId = Number(req.params.id);
        const messageId = Number(req.params.messageId);
        if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(messageId) || messageId <= 0) {
            return invalid(res, req.requestId, "INVALID_ARGUMENT", "invalid session id or message id");
        }
        try {
            const result = dependency(req, "removeMessagePair")(req.user.id, sessionId, messageId);
            return res.json({ ok: true, ...result });
        } catch {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("remove message pair failed"), {
                code: "INVALID_ARGUMENT", statusCode: 400,
            }), req.requestId));
        }
    });

    router.post("/sessions/:id/branch", requireAuth, (req, res) => {
        const sourceSessionId = Number(req.params.id);
        const rawMessageId = req.body?.from_message_id;
        const fromMessageId = rawMessageId == null ? null : Number(rawMessageId);
        if (!Number.isInteger(sourceSessionId) || sourceSessionId <= 0) return invalid(res, req.requestId, "INVALID_ARGUMENT", "invalid source session id");
        if (fromMessageId != null && (!Number.isInteger(fromMessageId) || fromMessageId <= 0)) return invalid(res, req.requestId, "INVALID_ARGUMENT", "invalid from message id");
        try {
            const title = String(req.body?.title || "").trim() || `分支-${new Date().toLocaleString()}`;
            const branchId = dependency(req, "createBranchSession")(
                req.user.id,
                sourceSessionId,
                fromMessageId,
                title,
                String(req.body?.edited_content || "")
            );
            const session = dependency(req, "getSessionById")(req.user.id, branchId);
            return res.json({ ok: true, id: branchId, session });
        } catch {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("branch failed"), {
                code: "INVALID_ARGUMENT", statusCode: 400,
            }), req.requestId));
        }
    });
}
