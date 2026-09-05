import { svcFn, sendError } from "./deps.js";

function scope(req) {
    return { userId: req.user.id, tenantId: req.user.tenantId };
}

/**
 * Agent configuration + version management reads/writes are admin-guarded and
 * run through the injectable AgentConfigService so factory instances can assert
 * the current user/tenant scope is passed for every op.
 */
export function registerConfigRoutes(router, { requireAuth, requireAdmin }) {
    router.get("/agent-config", requireAuth, requireAdmin, (req, res) => {
        try {
            const current = scope(req);
            const all = svcFn(req, "agentConfig").getAll(current);
            return res.json({ ok: true, configs: all, scope: current });
        } catch (error) {
            console.error("[agent-config] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.put("/agent-config", requireAuth, requireAdmin, (req, res) => {
        const { key, value } = req.body || {};
        if (!key || value === undefined) {
            return sendError(res, req.requestId, Object.assign(new Error("key and value are required"), { statusCode: 400, code: "INVALID_ARGUMENT" }));
        }
        try {
            const ok = svcFn(req, "agentConfig").set(String(key), String(value), null, false, scope(req));
            return res.json({ ok, config: { key: String(key), value: String(value) } });
        } catch (error) {
            console.error("[agent-config] PUT failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/agent-config/versions", requireAuth, requireAdmin, (req, res) => {
        try {
            const versions = svcFn(req, "agentConfig").listVersions(20, scope(req));
            return res.json({ ok: true, versions });
        } catch (error) {
            console.error("[agent-config/versions] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/agent-config/versions/:id", requireAuth, requireAdmin, (req, res) => {
        try {
            const version = svcFn(req, "agentConfig").getVersion(Number(req.params.id), scope(req));
            if (!version) {
                return sendError(res, req.requestId, Object.assign(new Error("Version not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json({ ok: true, version });
        } catch (error) {
            console.error("[agent-config/versions/:id] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.post("/agent-config/rollback", requireAuth, requireAdmin, (req, res) => {
        const { versionId } = req.body || {};
        if (!versionId) {
            return sendError(res, req.requestId, Object.assign(new Error("versionId is required"), { statusCode: 400, code: "INVALID_ARGUMENT" }));
        }
        try {
            const current = scope(req);
            const ok = svcFn(req, "agentConfig").restoreVersion(Number(versionId), current);
            if (!ok) {
                return sendError(res, req.requestId, Object.assign(new Error("Rollback failed"), { statusCode: 400, code: "ROLLBACK_FAILED" }));
            }
            const all = svcFn(req, "agentConfig").getAll(current);
            return res.json({ ok: true, configs: all, scope: current });
        } catch (error) {
            console.error("[agent-config/rollback] POST failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.patch("/agent-config/versions/:id/label", requireAuth, requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        const { label } = req.body || {};
        if (!Number.isInteger(id) || id <= 0) {
            return sendError(res, req.requestId, Object.assign(new Error("Invalid version id"), { statusCode: 400, code: "INVALID_ARGUMENT" }));
        }
        try {
            const ok = svcFn(req, "agentConfig").renameVersion(id, label || null, scope(req));
            if (!ok) {
                return sendError(res, req.requestId, Object.assign(new Error("Version not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json({ ok: true });
        } catch (error) {
            console.error("[agent-config/versions/:id/label] PATCH failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.delete("/agent-config/versions/:id", requireAuth, requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return sendError(res, req.requestId, Object.assign(new Error("Invalid version id"), { statusCode: 400, code: "INVALID_ARGUMENT" }));
        }
        try {
            const ok = svcFn(req, "agentConfig").removeVersion(id, scope(req));
            if (!ok) {
                return sendError(res, req.requestId, Object.assign(new Error("Version not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json({ ok: true });
        } catch (error) {
            console.error("[agent-config/versions/:id] DELETE failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });
}
