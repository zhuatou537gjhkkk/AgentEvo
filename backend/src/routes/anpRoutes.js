/**
 * Phase 7 / R5 (roadmap #9) — default-OFF ANP discovery/identity HTTP surface.
 *
 * These routes expose IDENTITY only (never a grant): /anp/cards lists the
 * server-trusted peers' identities, /anp/identity resolves one name to a pure
 * identity (identityOnly — advertised capabilities stripped). ANP discovery is
 * never authorization, so nothing here grants a dispatch. The whole tree is
 * gated by ANP_ENABLED (403 ANP_DISABLED while dark) and is NOT mounted on the
 * app singleton — a future R7 coordinator mounts it behind requireAuth.
 */
import express from "express";
import { sendError, svcFn } from "./deps.js";
import { anpEnabled } from "../extensibility/flags.js";
import { identityOnly } from "../anp/adapter.js";

function anpGate(req, res, next) {
    if (!anpEnabled()) {
        return res.status(403).json({
            ok: false,
            error: "ANP_DISABLED",
            errorCode: "ANP_DISABLED",
            message: "ANP discovery/identity is disabled",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    return next();
}

function bagService(req, name) {
    try {
        return svcFn(req, name);
    } catch {
        return null;
    }
}

/**
 * Resolve the ANP registry to serve a request: injected dependency-bag service
 * first (tests / instance wiring), otherwise the default registry singleton.
 * @param {import("express").Request} req
 * @returns {Promise<object>}
 */
async function registryFor(req) {
    const injected = bagService(req, "anpRegistry");
    if (injected) return injected;
    const mod = await import("../anp/registry.js");
    return mod.defaultAnpRegistry;
}

/**
 * @param {import("express").Router} router
 * @param {{requireAuth: (req,res,next)=>void}} opts
 */
export function registerAnpRoutes(router, { requireAuth }) {
    if (typeof requireAuth !== "function") throw new TypeError("requireAuth is required");
    const anp = express.Router();
    anp.use(requireAuth);
    anp.use(anpGate);

    // Cards of the server-trusted peers (identity display only).
    anp.get("/cards", async (req, res) => {
        try {
            const registry = await registryFor(req);
            const cards = registry.list({ onlyTrusted: true });
            return res.json({ ok: true, count: cards.length, cards });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // Resolve a single peer to its pure identity (no advertised capabilities).
    anp.get("/identity", async (req, res) => {
        try {
            const name = String(req.query?.name || "").trim();
            if (!name) {
                return sendError(res, req.requestId, Object.assign(new Error("anp identity name is required"), { code: "ANP_NAME_REQUIRED", statusCode: 400 }), { code: "ANP_NAME_REQUIRED", status: 400 });
            }
            const registry = await registryFor(req);
            const resolved = registry.resolveIdentity(name);
            if (!resolved || (!resolved.advertised && !resolved.trusted)) {
                return res.status(404).json({
                    ok: false,
                    error: "NOT_FOUND",
                    message: "anp identity not found",
                    retryable: false,
                    requestId: req.requestId || null,
                });
            }
            return res.json({
                ok: true,
                name: resolved.name,
                advertised: Boolean(resolved.advertised),
                trusted: Boolean(resolved.trusted),
                identity: resolved.identity ? identityOnly(resolved.identity) : null,
            });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    router.use("/anp", anp);
}

export default { registerAnpRoutes };
